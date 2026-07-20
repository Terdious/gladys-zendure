// -----------------------------------------------------------------------------
// Device type: ZENDURE SOLARFLOW (v1: SolarFlow 800 Pro, read-only telemetry)
//
// Discovery comes from the Zendure cloud deviceList; telemetry comes from the
// Zendure cloud MQTT broker (`properties/report` payloads), with the raw
// deviceList entry as a fallback until the first report arrives.
//
// Unlike the single-device template blueprints, this blueprint manages ONE
// Gladys device PER Zendure device found in the cloud account: it exposes
// `buildDevices` (plural) and `ownsDevice` for the registry dispatch.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import { toGladysPollFrequency } from '../config.js';
import { fetchCloudData } from '../zendure/client.js';
import {
  createZendureMqtt,
  createZendureLocalMqtt,
  buildLocalBrokerConfig,
} from '../zendure/mqtt.js';
import {
  getFeaturesForModel,
  extractMetricValue,
  searchMetricByKeys,
  normalizeMetricValue,
} from '../zendure/deviceMapping.js';

const DEVICE_TYPE = 'solarflow';

const logger = createLogger({ name: DEVICE_TYPE });

// Ask the device for fresh properties when the cached MQTT payload is older
// than this (same value as the Gladys core service).
const MQTT_STALE_TIMEOUT_IN_MS = 90 * 1000;

// --- Module runtime -----------------------------------------------------------
// Shared by discovery, polling and push. `dependencies` lets the tests inject
// a fake fetch and a fake mqtt.js library.

let dependencies = {};
let cloudData = null;
// The cloud broker is shared by every device; a locally-reachable device is
// served by a runtime connected to the local broker it publishes to.
let cloudMqttRuntime = null;
const localMqttRuntimes = new Map();

// --- State publishing: single coalesced + deduplicated + paced channel -------
// Every Gladys state update is an HTTP `POST /state` to the core, which enforces
// a request-rate limit (429 "Too Many Requests"). Our telemetry is high volume:
// 15+ devices x several metrics, arriving on every MQTT report AND on every
// poll (the core calls onPoll once PER device, so a naive onPoll would fire one
// request per device per cycle). To stay well under the limit we funnel ALL
// publishing (poll + push) through a SINGLE channel that:
//   - coalesces pending states (latest value per feature wins),
//   - drops states whose value has not changed since the last successful
//     publish (huge reduction once the initial sync is done),
//   - sends everything pending in ONE request per tick (up to the SDK's 100),
//   - paces ticks and backs off when the core rate-limits us.
const PUBLISH_INTERVAL_IN_MS = 2000;
const PUBLISH_MAX_BACKOFF_IN_MS = 30000;
const MAX_STATES_PER_REQUEST = 100; // SDK hard limit (publishStates)
let pendingStates = new Map(); // feature external_id -> state object
let publishTimer = null;
let publishBackoffInMs = 0;
const lastPublishedByFeature = new Map(); // feature external_id -> last published value
// Unchanged values are still re-published once in a while, so the core never
// flags a live feature as "no recent value" just because it is stable.
const STALE_REPUBLISH_INTERVAL_IN_MS = 30 * 60 * 1000;
const lastPublishedAtByFeature = new Map(); // feature external_id -> last publish time (ms)

/** Queue states for publication through the single paced channel. */
function queueStates(gladys, states) {
  for (const state of states) {
    pendingStates.set(state.device_feature_external_id, state);
  }
  schedulePublish(gladys);
}

function schedulePublish(gladys) {
  if (publishTimer) {
    return;
  }
  publishTimer = setTimeout(() => {
    publishTimer = null;
    flushPendingStates(gladys);
  }, PUBLISH_INTERVAL_IN_MS + publishBackoffInMs);
  // Do not keep the process alive just for a pending flush.
  if (typeof publishTimer.unref === 'function') {
    publishTimer.unref();
  }
}

/**
 * Flush the pending states in a single request: only values that changed since
 * the last successful publish are sent. Exposed for tests via `flushStatesNow`.
 */
async function flushPendingStates(gladys) {
  if (pendingStates.size === 0) {
    return;
  }
  // Keep the values that changed since the last publish, plus the unchanged
  // ones that have not been re-published for a while (freshness keep-alive).
  const now = Date.now();
  const changed = [];
  for (const [featureId, state] of pendingStates) {
    const isChanged = lastPublishedByFeature.get(featureId) !== state.state;
    const lastPublishedAt = lastPublishedAtByFeature.get(featureId) || 0;
    if (isChanged || now - lastPublishedAt > STALE_REPUBLISH_INTERVAL_IN_MS) {
      changed.push(state);
    }
  }
  pendingStates = new Map();
  if (changed.length === 0) {
    return;
  }

  const batch = changed.slice(0, MAX_STATES_PER_REQUEST);
  const overflow = changed.slice(MAX_STATES_PER_REQUEST);
  try {
    await gladys.publishStates(batch);
    for (const state of batch) {
      lastPublishedByFeature.set(state.device_feature_external_id, state.state);
      lastPublishedAtByFeature.set(state.device_feature_external_id, Date.now());
    }
    publishBackoffInMs = 0;
    logger.debug(`publish: sent ${batch.length} changed state(s)`);
  } catch (e) {
    // Not published: re-queue it (unless a fresher value arrived meanwhile).
    for (const state of batch) {
      if (!pendingStates.has(state.device_feature_external_id)) {
        pendingStates.set(state.device_feature_external_id, state);
      }
    }
    publishBackoffInMs = Math.min(
      PUBLISH_MAX_BACKOFF_IN_MS,
      (publishBackoffInMs || PUBLISH_INTERVAL_IN_MS) * 2,
    );
    logger.warn(
      `publish: states rejected (${e.message}); retrying ${batch.length} state(s) in ` +
        `${PUBLISH_INTERVAL_IN_MS + publishBackoffInMs} ms`,
    );
  }
  // Re-queue overflow and schedule the next tick if anything remains.
  for (const state of overflow) {
    if (!pendingStates.has(state.device_feature_external_id)) {
      pendingStates.set(state.device_feature_external_id, state);
    }
  }
  if (pendingStates.size > 0) {
    schedulePublish(gladys);
  }
}

/**
 * Test hook: rewind the per-feature publish timestamps so the next flush
 * re-publishes even unchanged values (freshness keep-alive path).
 */
export function markPublishedStatesStale() {
  for (const featureId of lastPublishedAtByFeature.keys()) {
    lastPublishedAtByFeature.set(featureId, 0);
  }
}

/**
 * Flush the pending states immediately (used by tests to avoid waiting for the
 * paced timer). Returns the flush promise.
 * @param {object} gladys Gladys SDK instance
 */
export function flushStatesNow(gladys) {
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
  }
  return flushPendingStates(gladys);
}

/**
 * Inject test doubles: `{ fetchImpl, mqttLibrary }`.
 * @param {object} overrides
 */
export function setSolarflowDependencies(overrides) {
  dependencies = { ...dependencies, ...overrides };
}

/** Reset the module runtime (tests + reconfiguration). */
export function resetSolarflowRuntime() {
  if (cloudMqttRuntime) {
    cloudMqttRuntime.disconnect();
  }
  cloudMqttRuntime = null;
  for (const runtime of localMqttRuntimes.values()) {
    runtime.disconnect();
  }
  localMqttRuntimes.clear();
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
  }
  pendingStates = new Map();
  publishBackoffInMs = 0;
  lastPublishedByFeature.clear();
  lastPublishedAtByFeature.clear();
  cloudData = null;
}

function deviceKeyOf(rawCloudDevice) {
  return rawCloudDevice.deviceKey || rawCloudDevice.id;
}

// Gladys selectors must be globally unique across the WHOLE installation, not
// just within the integration, and are lowercase/hyphenated. When a device is
// created, Gladys derives a selector from the name if none is provided, so two
// SolarFlow devices would both yield the feature selector "battery-level" and
// the second creation fails with a 409 (selector must be unique). We therefore
// build explicit selectors from the Zendure device key (globally unique) and
// compose every feature selector with the device one.

/** Lowercase/hyphenate a value into a selector-safe slug (no camelCase split). */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Unique device selector, e.g. `zendure-solarflow-9epd0sc2` (key kept opaque). */
function deviceSelectorOf(rawCloudDevice) {
  return `zendure-${DEVICE_TYPE}-${slugify(deviceKeyOf(rawCloudDevice))}`;
}

/**
 * Feature selector composed with the device one, guaranteeing uniqueness.
 * The camelCase feature key is turned into a readable kebab-case suffix, e.g.
 * `batteryLevel` -> `...-battery-level`.
 */
function featureSelectorOf(rawCloudDevice, featureKey) {
  const kebabKey = slugify(String(featureKey).replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
  return `${deviceSelectorOf(rawCloudDevice)}-${kebabKey}`;
}

function modelOf(rawCloudDevice) {
  return rawCloudDevice.productModel || rawCloudDevice.productName || '';
}

function supportedDevices(data) {
  return (data?.deviceList || []).filter(
    (rawCloudDevice) => getFeaturesForModel(modelOf(rawCloudDevice)).length > 0,
  );
}

async function ensureCloudData(config, { refresh = false } = {}) {
  if (!cloudData || refresh) {
    cloudData = await fetchCloudData(config.cloud_key, { fetchImpl: dependencies.fetchImpl });
  }
  return cloudData;
}

async function ensureCloudRuntime(config) {
  const data = await ensureCloudData(config);
  if (!cloudMqttRuntime) {
    cloudMqttRuntime = createZendureMqtt({ mqttLibrary: dependencies.mqttLibrary });
  }
  await cloudMqttRuntime.connect(data.mqtt);
  supportedDevices(data).forEach((rawCloudDevice) =>
    cloudMqttRuntime.subscribeDevice(rawCloudDevice),
  );
  return cloudMqttRuntime;
}

/**
 * Whether a raw cloud device can be reached over its LOCAL MQTT broker: the
 * integration option must be enabled and the device must expose usable local
 * broker parameters (a `server` host). The cloud `enable` flag is NOT consulted:
 * it is unreliable (it can read false while local MQTT is actually active), so
 * gating on it would hide reachable devices.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {boolean}
 */
function isDeviceLocallyReachable(config, rawCloudDevice) {
  return config.enable_local_mqtt === true && buildLocalBrokerConfig(rawCloudDevice) !== null;
}

/**
 * Ensure the LOCAL MQTT runtime for a device's broker is connected and every
 * locally-reachable device that shares that broker is subscribed to it.
 *
 * Local brokers are shared by many devices (they all publish to the same
 * `server`), so runtimes are keyed by broker URL: one connection serves every
 * device on the same broker instead of one connection per device.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {Promise<object|null>} the runtime, or null when no local broker
 */
async function ensureLocalRuntime(config, rawCloudDevice) {
  const brokerConfig = buildLocalBrokerConfig(rawCloudDevice);
  if (!brokerConfig) {
    return null;
  }
  const key = brokerConfig.url;
  let runtime = localMqttRuntimes.get(key);
  if (!runtime) {
    runtime = createZendureLocalMqtt({ mqttLibrary: dependencies.mqttLibrary });
    localMqttRuntimes.set(key, runtime);
  }
  await runtime.connect(brokerConfig);
  // Subscribe every locally-reachable device that publishes to this broker.
  for (const otherDevice of supportedDevices(cloudData)) {
    if (!isDeviceLocallyReachable(config, otherDevice)) {
      continue;
    }
    const otherBroker = buildLocalBrokerConfig(otherDevice);
    if (otherBroker && otherBroker.url === key) {
      runtime.subscribeDevice(otherDevice);
    }
  }
  return runtime;
}

/**
 * Select the active telemetry source for one device: prefer the LOCAL broker
 * when enabled and reachable, otherwise fall back to the cloud broker.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {Promise<{ runtime: object, source: 'local'|'cloud' }>}
 */
async function selectSourceRuntime(config, rawCloudDevice) {
  if (isDeviceLocallyReachable(config, rawCloudDevice)) {
    const runtime = await ensureLocalRuntime(config, rawCloudDevice);
    if (runtime) {
      return { runtime, source: 'local' };
    }
  }
  const runtime = await ensureCloudRuntime(config);
  return { runtime, source: 'cloud' };
}

function findSupportedDevice(data, deviceKey) {
  const normalized = String(deviceKey || '').toLowerCase();
  return (
    supportedDevices(data).find(
      (rawCloudDevice) => String(deviceKeyOf(rawCloudDevice)).toLowerCase() === normalized,
    ) || null
  );
}

/** Find a supported device by its serial number (local telemetry key). */
function findSupportedDeviceBySerial(data, serial) {
  const normalized = String(serial || '');
  if (normalized === '') {
    return null;
  }
  return (
    supportedDevices(data).find(
      (rawCloudDevice) => String(rawCloudDevice.snNumber || '') === normalized,
    ) || null
  );
}

/**
 * The key under which a device's telemetry is cached in the selected runtime:
 * the serial number for the LOCAL runtime, the device key for the CLOUD one.
 * @param {'local'|'cloud'} source selected telemetry source
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {string}
 */
function telemetryKeyOf(source, rawCloudDevice) {
  return source === 'local' ? rawCloudDevice.snNumber : deviceKeyOf(rawCloudDevice);
}

/**
 * Build the Gladys states for one device from a Zendure payload (MQTT report
 * or raw cloud deviceList entry). Metrics without a value are skipped.
 */
function buildStates(gladys, rawCloudDevice, payload) {
  const ids = gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice));
  const states = [];

  for (const featureMapping of getFeaturesForModel(modelOf(rawCloudDevice))) {
    let value = extractMetricValue(payload, featureMapping.metricPaths);
    if (value === null) {
      value = searchMetricByKeys(
        payload,
        featureMapping.metricPaths.map((path) => path.split('.').pop()),
      );
    }
    if (value === null) {
      continue;
    }
    states.push({
      device_feature_external_id: ids.feature(featureMapping.key),
      state: normalizeMetricValue(featureMapping.key, value),
    });
  }

  return states;
}

export const solarflow = {
  key: DEVICE_TYPE,

  /** Registry dispatch: does this blueprint own the given Gladys device? */
  ownsDevice(gladys, device) {
    return (
      typeof device?.external_id === 'string' &&
      device.external_id.startsWith(gladys.externalId(`${DEVICE_TYPE}:`))
    );
  },

  /**
   * Discovery: one Gladys device per supported Zendure device of the account.
   * Refreshes the cloud data so a scan always reflects the current account.
   */
  async buildDevices(gladys, config) {
    const data = await ensureCloudData(config, { refresh: true });
    const devices = supportedDevices(data);
    logger.info(`Found ${devices.length} supported Zendure device(s) in the cloud account`);

    return devices.map((rawCloudDevice) => {
      const ids = gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice));
      return {
        name: rawCloudDevice.deviceName || rawCloudDevice.name || modelOf(rawCloudDevice),
        external_id: ids.device,
        // Globally unique selector (Gladys would otherwise derive a clashing
        // one from the name).
        selector: deviceSelectorOf(rawCloudDevice),
        // Gladys will call onPoll at this interval. The core only polls
        // devices flagged should_poll, and only accepts its fixed
        // DEVICE_POLL_FREQUENCIES values (milliseconds), so the user setting
        // (seconds) is snapped to the closest allowed one.
        should_poll: true,
        poll_frequency: toGladysPollFrequency(config.poll_frequency),
        features: getFeaturesForModel(modelOf(rawCloudDevice)).map((featureMapping) => ({
          name: featureMapping.name,
          external_id: ids.feature(featureMapping.key),
          // Composed with the device selector so two devices never share a
          // feature selector (the core enforces global uniqueness).
          selector: featureSelectorOf(rawCloudDevice, featureMapping.key),
          category: featureMapping.category,
          type: featureMapping.type,
          unit: featureMapping.unit,
          min: featureMapping.min,
          max: featureMapping.max,
          read_only: true, // v1 is telemetry only: no control
          has_feedback: false,
          keep_history: true,
        })),
      };
    });
  },

  /**
   * Per-device transport badges: devices the Zendure account reports offline
   * (`online === false` in the deviceList) are 'unreachable'; devices served
   * by their LOCAL MQTT broker are 'local'; everything else is 'cloud'.
   * Reads the cloudData cached by the last discovery.
   */
  async buildTransports(gladys, config) {
    const data = await ensureCloudData(config);
    return supportedDevices(data).map((rawCloudDevice) => {
      let transport = DEVICE_TRANSPORTS.CLOUD;
      if (rawCloudDevice.online === false) {
        transport = DEVICE_TRANSPORTS.UNREACHABLE;
      } else if (isDeviceLocallyReachable(config, rawCloudDevice)) {
        transport = DEVICE_TRANSPORTS.LOCAL;
      }
      return {
        external_id: gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice)).device,
        transport,
      };
    });
  },

  /**
   * Polling: publish the latest known telemetry of one device. The MQTT cache
   * is the primary source; the raw cloud deviceList entry is the fallback
   * until the first report arrives. A `properties/read` request is sent when
   * the cache is stale.
   */
  async onPoll(gladys, config, device) {
    const deviceKey = String(device?.external_id || '')
      .split(':')
      .pop();
    if (!deviceKey) {
      logger.warn(`onPoll: invalid external_id "${device?.external_id}"`);
      return;
    }

    const data = await ensureCloudData(config);
    const rawCloudDevice = findSupportedDevice(data, deviceKey);
    if (!rawCloudDevice) {
      logger.warn(`onPoll: Zendure device "${deviceKey}" not found in the cloud account`);
      return;
    }

    const { runtime, source } = await selectSourceRuntime(config, rawCloudDevice);
    logger.debug(`onPoll: using ${source} MQTT source for ${deviceKey}`);
    // Local telemetry is keyed by serial number, cloud telemetry by device key.
    const telemetryKey = telemetryKeyOf(source, rawCloudDevice);
    const lastPayloadAt = runtime.getLastPayloadAt(telemetryKey);
    if (!lastPayloadAt || Date.now() - lastPayloadAt > MQTT_STALE_TIMEOUT_IN_MS) {
      runtime.requestDeviceProperties(rawCloudDevice);
    }

    // LOCAL payloads are built incrementally (one metric per topic): a metric
    // the device has not re-published yet (state of charge, solar power at
    // night...) would otherwise never get a value. Merge the local cache OVER
    // the cloud deviceList snapshot so missing metrics fall back to the last
    // cloud value. The cloud payload stays as-is (its `properties` report is
    // complete, and the raw entry would shadow fresher nested values).
    const latestPayload = runtime.getLatestPayload(telemetryKey);
    const payload =
      source === 'local' && latestPayload
        ? { ...rawCloudDevice, ...latestPayload }
        : latestPayload || rawCloudDevice;
    const states = buildStates(gladys, rawCloudDevice, payload);
    if (states.length === 0) {
      logger.debug(`onPoll: no telemetry available yet for ${deviceKey}`);
      return;
    }

    // Funnel through the shared paced channel (deduplicated) instead of a
    // direct request: the core calls onPoll once per device, so a direct
    // publish here would fire one request per device per cycle and trip 429.
    queueStates(gladys, states);
    logger.debug(`onPoll: queued ${states.length} state(s) for ${deviceKey}`);
  },

  /**
   * Real-time push: publish states as soon as an MQTT report arrives.
   * Returns the cleanup function expected by the wiring in index.js.
   */
  startPush(gladys, config) {
    let stopped = false;
    const unsubscribes = [];

    // Publish a payload only when THIS runtime is the selected source for the
    // device: a device could otherwise be reported by both its local broker
    // and the shared cloud broker, causing duplicate states.
    function makeListener(source) {
      return (key, payload) => {
        // The local runtime emits the serial number as key; the cloud one emits
        // the device key.
        const rawCloudDevice =
          source === 'local'
            ? findSupportedDeviceBySerial(cloudData, key)
            : findSupportedDevice(cloudData, key);
        if (!rawCloudDevice) {
          return;
        }
        const selectedSource = isDeviceLocallyReachable(config, rawCloudDevice) ? 'local' : 'cloud';
        if (selectedSource !== source) {
          return;
        }
        const states = buildStates(gladys, rawCloudDevice, payload);
        if (states.length === 0) {
          return;
        }
        // Coalesce instead of publishing immediately: bursts of reports (many
        // devices at once) would otherwise flood the core with 429 errors.
        queueStates(gladys, states);
      };
    }

    (async () => {
      try {
        const data = await ensureCloudData(config);
        const devices = supportedDevices(data);

        // Explicit source breakdown in the logs: which device is served by the
        // LOCAL broker (and which one) versus the Zendure CLOUD broker.
        const localByBroker = new Map(); // broker url -> [device labels]
        const cloudDeviceLabels = [];
        const labelOf = (d) => d.deviceName || deviceKeyOf(d);
        for (const rawCloudDevice of devices) {
          if (isDeviceLocallyReachable(config, rawCloudDevice)) {
            const url = buildLocalBrokerConfig(rawCloudDevice).url;
            if (!localByBroker.has(url)) {
              localByBroker.set(url, []);
            }
            localByBroker.get(url).push(labelOf(rawCloudDevice));
          } else {
            cloudDeviceLabels.push(labelOf(rawCloudDevice));
          }
        }
        const localCount = [...localByBroker.values()].reduce((n, list) => n + list.length, 0);
        logger.info(
          `push: telemetry source -> ${localCount} local / ${cloudDeviceLabels.length} cloud ` +
            `(of ${devices.length} device(s))`,
        );
        for (const [url, labels] of localByBroker) {
          logger.info(
            `push: LOCAL broker ${url} -> ${labels.length} device(s): ${labels.join(', ')}`,
          );
        }
        if (cloudDeviceLabels.length > 0) {
          logger.info(
            `push: CLOUD broker -> ${cloudDeviceLabels.length} device(s): ${cloudDeviceLabels.join(', ')}`,
          );
        }

        // Attach a listener to every runtime that owns at least one device.
        const runtimesBySource = new Map(); // runtime -> source
        for (const rawCloudDevice of devices) {
          const { runtime, source } = await selectSourceRuntime(config, rawCloudDevice);
          if (!runtimesBySource.has(runtime)) {
            runtimesBySource.set(runtime, source);
          }
        }
        if (stopped) {
          return;
        }

        // Tear down runtimes no longer used by any device: when the user enables
        // local MQTT for every device, the cloud runtime must be disconnected so
        // it stops reconnecting (and stops fighting a second cloud consumer over
        // the shared cloud client id).
        if (cloudMqttRuntime && !runtimesBySource.has(cloudMqttRuntime)) {
          cloudMqttRuntime.disconnect();
          cloudMqttRuntime = null;
          logger.info('push: cloud broker no longer needed -> disconnected');
        }
        for (const [url, runtime] of localMqttRuntimes) {
          if (!runtimesBySource.has(runtime)) {
            runtime.disconnect();
            localMqttRuntimes.delete(url);
            logger.info(`push: local broker ${url} no longer needed -> disconnected`);
          }
        }

        for (const [runtime, source] of runtimesBySource) {
          unsubscribes.push(runtime.onPayload(makeListener(source)));
        }
      } catch (e) {
        logger.error('push: Zendure MQTT setup failed', e);
      }
    })();

    return () => {
      stopped = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  },
};
