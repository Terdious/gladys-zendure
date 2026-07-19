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

import { createLogger } from '@gladysassistant/integration-sdk';

import { toGladysPollFrequency } from '../config.js';
import { fetchCloudData } from '../zendure/client.js';
import { createZendureMqtt } from '../zendure/mqtt.js';
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
let mqttRuntime = null;

/**
 * Inject test doubles: `{ fetchImpl, mqttLibrary }`.
 * @param {object} overrides
 */
export function setSolarflowDependencies(overrides) {
  dependencies = { ...dependencies, ...overrides };
}

/** Reset the module runtime (tests + reconfiguration). */
export function resetSolarflowRuntime() {
  if (mqttRuntime) {
    mqttRuntime.disconnect();
  }
  mqttRuntime = null;
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

async function ensureMqttRuntime(config) {
  const data = await ensureCloudData(config);
  if (!mqttRuntime) {
    mqttRuntime = createZendureMqtt({ mqttLibrary: dependencies.mqttLibrary });
  }
  await mqttRuntime.connect(data.mqtt);
  supportedDevices(data).forEach((rawCloudDevice) => mqttRuntime.subscribeDevice(rawCloudDevice));
  return mqttRuntime;
}

function findSupportedDevice(data, deviceKey) {
  const normalized = String(deviceKey || '').toLowerCase();
  return (
    supportedDevices(data).find(
      (rawCloudDevice) => String(deviceKeyOf(rawCloudDevice)).toLowerCase() === normalized,
    ) || null
  );
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

    const runtime = await ensureMqttRuntime(config);
    const lastPayloadAt = runtime.getLastPayloadAt(deviceKey);
    if (!lastPayloadAt || Date.now() - lastPayloadAt > MQTT_STALE_TIMEOUT_IN_MS) {
      runtime.requestDeviceProperties(rawCloudDevice);
    }

    const payload = runtime.getLatestPayload(deviceKey) || rawCloudDevice;
    const states = buildStates(gladys, rawCloudDevice, payload);
    if (states.length === 0) {
      logger.debug(`onPoll: no telemetry available yet for ${deviceKey}`);
      return;
    }

    await gladys.publishStates(states);
    logger.debug(`onPoll: published ${states.length} state(s) for ${deviceKey}`);
  },

  /**
   * Real-time push: publish states as soon as an MQTT report arrives.
   * Returns the cleanup function expected by the wiring in index.js.
   */
  startPush(gladys, config) {
    let stopped = false;
    let unsubscribe = null;

    (async () => {
      try {
        const runtime = await ensureMqttRuntime(config);
        if (stopped) {
          return;
        }
        unsubscribe = runtime.onPayload(async (deviceKey, payload) => {
          const rawCloudDevice = findSupportedDevice(cloudData, deviceKey);
          if (!rawCloudDevice) {
            return;
          }
          const states = buildStates(gladys, rawCloudDevice, payload);
          if (states.length === 0) {
            return;
          }
          try {
            await gladys.publishStates(states);
            logger.debug(`push: published ${states.length} state(s) for ${deviceKey}`);
          } catch (e) {
            logger.warn(`push: publishing states failed: ${e.message}`);
          }
        });
      } catch (e) {
        logger.error('push: Zendure MQTT setup failed', e);
      }
    })();

    return () => {
      stopped = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  },
};
