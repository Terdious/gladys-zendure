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
// When each runtime was created (ms): drives the startup grace window of the
// per-device freshness checks (a runtime that just connected has obviously
// not received anything yet, which must not count as silence).
let cloudRuntimeStartedAt = 0;
const localRuntimeStartedAt = new Map(); // broker url -> creation time (ms)

// --- Per-device effective telemetry source (local mode) -----------------------
// In local mode a device can silently stop publishing on its LOCAL broker
// while staying reachable through the Zendure cloud (seen in the field on a
// SolarFlow 800 Pro). Instead of trusting the static preference forever, the
// integration tracks per device the source that ACTUALLY delivers telemetry
// ('local', 'cloud' or 'unreachable'), falls back to the cloud automatically
// and returns to local as soon as local messages resume. Only meaningful when
// `enable_local_mqtt` is true: cloud-only mode keeps the static behavior.

// A device is considered silent on a source when no payload arrived within
// this window, measured against max(lastPayloadAt, runtimeStartedAt) so a
// freshly-created runtime gets a startup grace window.
export const LOCAL_SILENCE_TIMEOUT_IN_MS = 90 * 1000;
// Silent on BOTH sources beyond this (past grace) -> the device is unreachable.
export const UNREACHABLE_TIMEOUT_IN_MS = 5 * 60 * 1000;
// The evaluator re-assesses every device at this interval.
export const SOURCE_EVALUATOR_INTERVAL_IN_MS = 30 * 1000;

// deviceKey -> { source: 'local'|'cloud'|'unreachable', since: ms timestamp }
const effectiveSourceByDeviceKey = new Map();
let sourceEvaluatorTimer = null;
// Consecutive evaluations where EVERY local-mode device was 'local' (drives
// the lazy cloud-broker disconnect).
let allLocalEvaluationStreak = 0;
// Unsubscribes for push listeners attached OUTSIDE startPush (the evaluator's
// lazy cloud connect), drained by the push cleanup and the runtime reset.
let dynamicUnsubscribes = [];

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
// Adaptive pacing (AIMD, like TCP congestion control): the tick is
// PUBLISH_INTERVAL_IN_MS + an adaptive extra delay. When the core accepts our
// batch the extra delay decays gently (additive decrease) back towards the
// reactive base; a 429 grows it fast (multiplicative increase). Result: ~2 s
// ticks (reactive, good for control automations) when we are the only
// consumer, self-throttling toward ~5-6 s only while the core's shared budget
// (~100 requests / 5 min, also consumed by discovery/status/transport AND by
// any second integration instance) is actually saturated. Values coalesce
// between ticks (latest per feature wins), so a longer tick never loses data,
// it only delays it. onSetValue commands do NOT go through this channel — they
// are sent immediately — so control latency is unaffected by the pacing.
const PUBLISH_INTERVAL_IN_MS = 2000;
const PUBLISH_MAX_BACKOFF_IN_MS = 30000;
// How much the adaptive extra delay decays per successful flush.
const PUBLISH_BACKOFF_DECAY_IN_MS = 500;
const MAX_STATES_PER_REQUEST = 100; // SDK hard limit (publishStates)
let pendingStates = new Map(); // feature external_id -> state object
let publishTimer = null;
let publishBackoffInMs = 0;
const lastPublishedByFeature = new Map(); // feature external_id -> last published value
// Unchanged values are still re-published once in a while, so the core never
// flags a live feature as "no recent value" just because it is stable.
const STALE_REPUBLISH_INTERVAL_IN_MS = 30 * 60 * 1000;
const lastPublishedAtByFeature = new Map(); // feature external_id -> last publish time (ms)

// Telemetry watchdog: every 5 minutes, log which devices reported vs went
// silent on each active source, plus the publish-channel counters.
export const TELEMETRY_WATCHDOG_INTERVAL_IN_MS = 5 * 60 * 1000;
let telemetryWatchdogTimer = null;
// connectCount baseline per runtime, to report (re)connections per watchdog
// period (a rapid delta exposes the shared-cloud-clientId take-over fight).
const watchdogConnectBaseline = new WeakMap();
// Publish-channel counters since the last watchdog report.
let publishSentCount = 0;
let publishDeduplicatedCount = 0;
// Timestamps of our POST /state requests over the last minute: when the core
// rate-limits us while OUR rate is modest, the budget is being consumed by
// something else (typically a SECOND integration instance on the same core),
// and the failure log should say so instead of leaving the user guessing.
let publishRequestLog = [];
let sharedLimitHintLogged = false;

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
  let deduplicated = 0;
  for (const [featureId, state] of pendingStates) {
    const isChanged = lastPublishedByFeature.get(featureId) !== state.state;
    const lastPublishedAt = lastPublishedAtByFeature.get(featureId) || 0;
    if (isChanged || now - lastPublishedAt > STALE_REPUBLISH_INTERVAL_IN_MS) {
      changed.push(state);
    } else {
      deduplicated += 1;
    }
  }
  pendingStates = new Map();
  publishDeduplicatedCount += deduplicated;
  if (changed.length === 0) {
    logger.debug(`publish: nothing to send (${deduplicated} state(s) deduplicated)`);
    return;
  }

  const batch = changed.slice(0, MAX_STATES_PER_REQUEST);
  const overflow = changed.slice(MAX_STATES_PER_REQUEST);
  publishRequestLog.push(now);
  publishRequestLog = publishRequestLog.filter((at) => now - at <= 60 * 1000);
  try {
    await gladys.publishStates(batch);
    for (const state of batch) {
      lastPublishedByFeature.set(state.device_feature_external_id, state.state);
      lastPublishedAtByFeature.set(state.device_feature_external_id, Date.now());
    }
    // Additive decrease: ease back towards the reactive base instead of
    // resetting to 0, so a single success between 429s does not immediately
    // re-flood the shared budget (which would just trip the next 429).
    publishBackoffInMs = Math.max(0, publishBackoffInMs - PUBLISH_BACKOFF_DECAY_IN_MS);
    publishSentCount += batch.length;
    logger.debug(`publish: sent ${batch.length} changed state(s), ${deduplicated} deduplicated`);
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
    // Name the rejected features (device:feature suffix of the external id)
    // and our own request rate, so a rate-limit log tells WHAT was refused
    // and WHETHER we caused it.
    const sample = batch
      .slice(0, 3)
      .map((state) => state.device_feature_external_id.split(':').slice(-2).join(':'));
    const ourRate = publishRequestLog.length;
    logger.warn(
      `publish: states rejected (${e.message}); retrying ${batch.length} state(s) in ` +
        `${PUBLISH_INTERVAL_IN_MS + publishBackoffInMs} ms ` +
        `(our rate: ${ourRate} request(s) in the last 60 s; ` +
        `batch: ${sample.join(', ')}${batch.length > 3 ? ', ...' : ''})`,
    );
    if (/Too Many Requests/i.test(e.message || '') && ourRate <= 30 && !sharedLimitHintLogged) {
      sharedLimitHintLogged = true;
      logger.warn(
        'publish: the core rate limit tripped while our own request rate is modest: ' +
          'the budget is probably shared with ANOTHER integration instance publishing ' +
          'states on this Gladys (e.g. a second Zendure container - prod + test side by side).',
      );
    }
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
 * Forget the publish dedup memory (and the watchdog counters) so the NEXT
 * flush re-sends EVERY value. Called when the user changes the configuration
 * (e.g. switches cloud<->local): the first sync after the change must
 * re-publish everything immediately instead of waiting for the 30-min
 * keep-alive.
 */
export function resetPublishDedup() {
  lastPublishedByFeature.clear();
  lastPublishedAtByFeature.clear();
  publishSentCount = 0;
  publishDeduplicatedCount = 0;
  publishRequestLog = [];
  sharedLimitHintLogged = false;
}

/**
 * Build the telemetry watchdog summary for one source, from
 * `[{ label, lastPayloadAt }]` entries (one per supported device of that
 * source). A device is "reporting" when its last payload is younger than the
 * watchdog interval. Pure helper, exported for direct unit testing.
 * @param {Array<{ label: string, lastPayloadAt: number|null }>} entries
 * @param {number} now current time (ms)
 * @returns {string} e.g. `14/15 device(s) reported in the last 5 min; silent: ...`
 */
export function buildTelemetrySummary(entries, now) {
  const total = entries.length;
  const silent = entries.filter(
    (entry) =>
      !entry.lastPayloadAt || now - entry.lastPayloadAt > TELEMETRY_WATCHDOG_INTERVAL_IN_MS,
  );
  if (silent.length === 0) {
    return `all ${total} device(s) reporting`;
  }
  const minutes = Math.round(TELEMETRY_WATCHDOG_INTERVAL_IN_MS / 60000);
  return (
    `${total - silent.length}/${total} device(s) reported in the last ${minutes} min; ` +
    `silent: ${silent.map((entry) => entry.label).join(', ')}`
  );
}

function stopTelemetryWatchdog() {
  if (telemetryWatchdogTimer) {
    clearInterval(telemetryWatchdogTimer);
    telemetryWatchdogTimer = null;
  }
}

function stopSourceEvaluator() {
  if (sourceEvaluatorTimer) {
    clearInterval(sourceEvaluatorTimer);
    sourceEvaluatorTimer = null;
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
  cloudRuntimeStartedAt = 0;
  for (const runtime of localMqttRuntimes.values()) {
    runtime.disconnect();
  }
  localMqttRuntimes.clear();
  localRuntimeStartedAt.clear();
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = null;
  }
  pendingStates = new Map();
  publishBackoffInMs = 0;
  resetPublishDedup();
  stopTelemetryWatchdog();
  stopSourceEvaluator();
  effectiveSourceByDeviceKey.clear();
  allLocalEvaluationStreak = 0;
  for (const unsubscribe of dynamicUnsubscribes) {
    unsubscribe();
  }
  dynamicUnsubscribes = [];
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

async function ensureCloudRuntime(config, now = Date.now()) {
  const data = await ensureCloudData(config);
  if (!cloudMqttRuntime) {
    cloudMqttRuntime = createZendureMqtt({ mqttLibrary: dependencies.mqttLibrary });
    // Creation time drives the startup grace window of the freshness checks.
    // The evaluator passes its own `now` so the grace window is measured on
    // the same clock as its freshness decisions.
    cloudRuntimeStartedAt = now;
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
    // Creation time drives the startup grace window of the freshness checks.
    localRuntimeStartedAt.set(key, Date.now());
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

/**
 * Runtime used by onPoll for one device: the device's EFFECTIVE source when
 * the evaluator tracked a cloud fallback (local mode), the static preference
 * otherwise (including when no effective state exists yet).
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {Promise<{ runtime: object, source: 'local'|'cloud' }>}
 */
async function selectPollRuntime(config, rawCloudDevice) {
  if (config.enable_local_mqtt === true && isDeviceLocallyReachable(config, rawCloudDevice)) {
    const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
    if (effective && effective.source === 'cloud') {
      // Fallback in progress: poll the cloud runtime, with the cloud payload
      // logic (its `properties` reports are complete, no local merge needed).
      const runtime = await ensureCloudRuntime(config);
      return { runtime, source: 'cloud' };
    }
  }
  return selectSourceRuntime(config, rawCloudDevice);
}

/**
 * Human-readable duration for the transition logs: seconds under 2 minutes,
 * minutes otherwise.
 * @param {number} ms duration in milliseconds
 * @returns {string} e.g. `95 s` or `12 min`
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${seconds} s`;
  }
  return `${Math.round(seconds / 60)} min`;
}

/** Log label of a device, e.g. `SolarFlow 800 Pro L1 (dCLTD95V)`. */
function deviceLabelOf(rawCloudDevice) {
  return `${rawCloudDevice.deviceName || modelOf(rawCloudDevice)} (${deviceKeyOf(rawCloudDevice)})`;
}

/** Map an effective source to the Gladys transport badge value. */
function transportOfSource(source) {
  if (source === 'local') {
    return DEVICE_TRANSPORTS.LOCAL;
  }
  if (source === 'cloud') {
    return DEVICE_TRANSPORTS.CLOUD;
  }
  return DEVICE_TRANSPORTS.UNREACHABLE;
}

/**
 * Latest activity timestamp of one source for a device: the last payload, or
 * the runtime creation time when nothing arrived yet (startup grace window).
 * A missing runtime yields 0 (silent since forever).
 * @param {object|null} runtime MQTT runtime of the source (may be null)
 * @param {string} telemetryKey serial (local) or deviceKey (cloud)
 * @param {number|undefined} startedAt runtime creation time (ms)
 * @returns {number} activity timestamp (ms), 0 when unknown
 */
function lastSourceActivityAt(runtime, telemetryKey, startedAt) {
  const lastPayloadAt = runtime ? runtime.getLastPayloadAt(telemetryKey) : null;
  return Math.max(lastPayloadAt || 0, startedAt || 0);
}

/**
 * Record a device's effective source and, on a real TRANSITION, log it (with
 * the elapsed time of the previous state) and return the transport badge
 * entry to publish. Returns null when nothing changed, and seeds silently
 * when the device had no effective state yet (initial observation, not a
 * transition).
 * @param {object} gladys Gladys SDK instance
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {'local'|'cloud'|'unreachable'} nextSource new effective source
 * @param {number} now current time (ms)
 * @returns {{ external_id: string, transport: string }|null}
 */
function applySourceTransition(gladys, rawCloudDevice, nextSource, now) {
  const deviceKey = deviceKeyOf(rawCloudDevice);
  const previous = effectiveSourceByDeviceKey.get(deviceKey);
  if (previous && previous.source === nextSource) {
    return null;
  }
  effectiveSourceByDeviceKey.set(deviceKey, { source: nextSource, since: now });
  if (!previous) {
    logger.debug(`telemetry: ${deviceLabelOf(rawCloudDevice)}: initial source is ${nextSource}`);
    return null;
  }

  const elapsed = formatDuration(now - previous.since);
  let detail;
  if (nextSource === 'unreachable') {
    detail = `unreachable (no local or cloud message for ${formatDuration(UNREACHABLE_TIMEOUT_IN_MS)})`;
  } else if (nextSource === 'local') {
    const recovery =
      previous.source === 'cloud' ? `after ${elapsed} on cloud` : `after ${elapsed} unreachable`;
    detail = `${previous.source} -> local (recovered ${recovery})`;
  } else if (previous.source === 'local') {
    detail = `local -> cloud fallback (local silent for ${elapsed})`;
  } else {
    detail = `unreachable -> cloud (cloud telemetry resumed after ${elapsed})`;
  }
  logger.info(`telemetry: ${deviceLabelOf(rawCloudDevice)}: ${detail}`);

  // A device the account reports offline stays 'unreachable' on the badge.
  const transport =
    rawCloudDevice.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : transportOfSource(nextSource);
  return {
    external_id: gladys.externalIds(DEVICE_TYPE, deviceKey).device,
    transport,
  };
}

/**
 * Publish transport badge entries, tolerating an older Gladys core without
 * the endpoint (same defensive pattern as the discovery sync).
 * @param {object} gladys Gladys SDK instance
 * @param {Array<{ external_id: string, transport: string }>} entries
 */
async function publishTransportEntries(gladys, entries) {
  if (entries.length === 0) {
    return;
  }
  try {
    await gladys.publishTransports(entries);
  } catch (e) {
    logger.debug(`publishTransports skipped (older Gladys core?): ${e.message}`);
  }
}

/**
 * Build the push listener of one source. The LOCAL listener always publishes:
 * a local message IS proof of local health, so it also transitions the device
 * back to 'local' when it had fallen back. The CLOUD listener publishes only
 * when the device's effective source is NOT 'local', avoiding duplicates
 * while the local feed is healthy (the paced publish channel deduplicates by
 * value anyway).
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {'local'|'cloud'} source source of the runtime this listener serves
 * @returns {Function} `(key, payload) => void` payload listener
 */
function createPushListener(gladys, config, source) {
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
    if (source === 'local') {
      if (config.enable_local_mqtt === true) {
        const entry = applySourceTransition(gladys, rawCloudDevice, 'local', Date.now());
        if (entry) {
          publishTransportEntries(gladys, [entry]);
        }
      }
    } else {
      // Default to the static preference when the evaluator has no state yet.
      const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
      const effectiveSource = effective
        ? effective.source
        : isDeviceLocallyReachable(config, rawCloudDevice)
          ? 'local'
          : 'cloud';
      if (effectiveSource === 'local') {
        return;
      }
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

/**
 * Attach the push listener of one runtime; shared by startPush and the
 * evaluator's lazy cloud connect so a late cloud runtime publishes too.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {object} runtime MQTT runtime
 * @param {'local'|'cloud'} source source of the runtime
 * @returns {Function} unsubscribe
 */
function attachSourceListener(gladys, config, runtime, source) {
  return runtime.onPayload(createPushListener(gladys, config, source));
}

/**
 * Re-assess the effective telemetry source of every local-mode device:
 *   - local fresh (within LOCAL_SILENCE_TIMEOUT_IN_MS, grace included) -> 'local';
 *   - else cloud fresh (same grace logic) -> 'cloud';
 *   - else silent on BOTH sources beyond UNREACHABLE_TIMEOUT_IN_MS -> 'unreachable';
 *   - else keep the previous source (pending, no flapping).
 * Transitions are logged and their badges published in one call. Also owns
 * the LAZY cloud connection: the Zendure cloud broker enforces one consumer
 * per account, so it stays disconnected while every device is healthy locally
 * and is only brought up when at least one device went locally silent (then
 * released again after two consecutive all-local evaluations).
 * Scheduled every SOURCE_EVALUATOR_INTERVAL_IN_MS by startPush in local mode;
 * `now` is injectable for tests.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {number} [now] current time (ms)
 */
export async function evaluateTelemetrySources(gladys, config, now = Date.now()) {
  if (config.enable_local_mqtt !== true || !cloudData) {
    return;
  }
  const allDevices = supportedDevices(cloudData);
  const localModeDevices = allDevices.filter((rawCloudDevice) =>
    isDeviceLocallyReachable(config, rawCloudDevice),
  );
  if (localModeDevices.length === 0) {
    return;
  }

  const changedEntries = [];
  const locallySilent = [];
  for (const rawCloudDevice of localModeDevices) {
    const brokerUrl = buildLocalBrokerConfig(rawCloudDevice).url;
    const localRuntime = localMqttRuntimes.get(brokerUrl) || null;
    const localActivityAt = lastSourceActivityAt(
      localRuntime,
      rawCloudDevice.snNumber,
      localRuntimeStartedAt.get(brokerUrl),
    );
    if (now - localActivityAt <= LOCAL_SILENCE_TIMEOUT_IN_MS) {
      const entry = applySourceTransition(gladys, rawCloudDevice, 'local', now);
      if (entry) {
        changedEntries.push(entry);
      }
    } else {
      locallySilent.push({ rawCloudDevice, localActivityAt });
    }
  }

  // Lazy cloud fallback connection (one consumer per account: connect only
  // when needed). The freshly-attached listener makes the late cloud runtime
  // publish states like the ones attached by startPush.
  if (locallySilent.length > 0 && !cloudMqttRuntime) {
    logger.info(
      `fallback: connecting the cloud broker for ${locallySilent.length} locally-silent device(s)`,
    );
    try {
      await ensureCloudRuntime(config, now);
      dynamicUnsubscribes.push(attachSourceListener(gladys, config, cloudMqttRuntime, 'cloud'));
    } catch (e) {
      logger.warn(`fallback: cloud broker connection failed: ${e.message}`);
    }
  }

  for (const { rawCloudDevice, localActivityAt } of locallySilent) {
    const cloudActivityAt = lastSourceActivityAt(
      cloudMqttRuntime,
      deviceKeyOf(rawCloudDevice),
      cloudRuntimeStartedAt,
    );
    let entry = null;
    if (now - cloudActivityAt <= LOCAL_SILENCE_TIMEOUT_IN_MS) {
      entry = applySourceTransition(gladys, rawCloudDevice, 'cloud', now);
    } else if (
      now - localActivityAt > UNREACHABLE_TIMEOUT_IN_MS &&
      now - cloudActivityAt > UNREACHABLE_TIMEOUT_IN_MS
    ) {
      entry = applySourceTransition(gladys, rawCloudDevice, 'unreachable', now);
    }
    // Otherwise: pending state, keep the previous source (no flapping).
    if (entry) {
      changedEntries.push(entry);
    }
  }

  await publishTransportEntries(gladys, changedEntries);

  // Lazy cloud disconnect: once every local-mode device has been back on
  // 'local' for two consecutive evaluations (and no device statically needs
  // the cloud), release the cloud broker for other consumers of the account.
  const everyDeviceLocal = localModeDevices.every((rawCloudDevice) => {
    const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
    return effective !== undefined && effective.source === 'local';
  });
  allLocalEvaluationStreak = everyDeviceLocal ? allLocalEvaluationStreak + 1 : 0;
  const cloudStaticallyNeeded = allDevices.length > localModeDevices.length;
  if (allLocalEvaluationStreak >= 2 && cloudMqttRuntime && !cloudStaticallyNeeded) {
    cloudMqttRuntime.disconnect();
    cloudMqttRuntime = null;
    cloudRuntimeStartedAt = 0;
    logger.info('fallback: all devices back on local -> cloud broker disconnected');
  }
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

  // Optional hook called by the registry when the configuration changes: the
  // first sync after a change must re-publish every value immediately.
  resetPublishDedup,

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
   * by their LOCAL MQTT broker follow their EFFECTIVE source when the
   * evaluator tracked one (local/cloud fallback/unreachable), the static
   * 'local' otherwise; everything else is 'cloud'.
   * Reads the cloudData cached by the last discovery.
   */
  async buildTransports(gladys, config) {
    const data = await ensureCloudData(config);
    return supportedDevices(data).map((rawCloudDevice) => {
      let transport = DEVICE_TRANSPORTS.CLOUD;
      if (rawCloudDevice.online === false) {
        transport = DEVICE_TRANSPORTS.UNREACHABLE;
      } else if (isDeviceLocallyReachable(config, rawCloudDevice)) {
        const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
        transport = effective ? transportOfSource(effective.source) : DEVICE_TRANSPORTS.LOCAL;
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

    const { runtime, source } = await selectPollRuntime(config, rawCloudDevice);
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
    // A disconnected broker means the cache is BLIND, not that values are
    // stable: re-publishing it (30-min keep-alive included) would present
    // stale data as fresh during an outage. Skip until the broker is back.
    // (Without any cached payload yet, the raw cloud entry still bootstraps.)
    if (!runtime.connected && latestPayload) {
      logger.debug(
        `onPoll: ${source} broker disconnected for ${deviceKey}, cached republish skipped`,
      );
      return;
    }
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
        // the shared cloud client id). The cloud runtime is kept when a device
        // currently FELL BACK to it (effective source tracked by the evaluator).
        const cloudNeededByFallback = devices.some((rawCloudDevice) => {
          const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
          return effective !== undefined && effective.source !== 'local';
        });
        if (cloudMqttRuntime && !runtimesBySource.has(cloudMqttRuntime) && !cloudNeededByFallback) {
          cloudMqttRuntime.disconnect();
          cloudMqttRuntime = null;
          cloudRuntimeStartedAt = 0;
          logger.info('push: cloud broker no longer needed -> disconnected');
        }
        for (const [url, runtime] of localMqttRuntimes) {
          if (!runtimesBySource.has(runtime)) {
            runtime.disconnect();
            localMqttRuntimes.delete(url);
            localRuntimeStartedAt.delete(url);
            logger.info(`push: local broker ${url} no longer needed -> disconnected`);
          }
        }

        // Attach the push listeners to EVERY live runtime (a device may be
        // served by its local broker AND, during a fallback, by the cloud
        // one): the per-source listeners decide per device what to publish.
        const activeRuntimes = [];
        for (const [url, runtime] of localMqttRuntimes) {
          activeRuntimes.push({ runtime, source: 'local', url });
        }
        if (cloudMqttRuntime) {
          activeRuntimes.push({
            runtime: cloudMqttRuntime,
            source: 'cloud',
            url: data.mqtt?.url || 'cloud',
          });
        }

        const runtimeInfos = [];
        for (const { runtime, source, url } of activeRuntimes) {
          unsubscribes.push(attachSourceListener(gladys, config, runtime, source));
          // The devices this runtime serves (for the telemetry watchdog): on a
          // local runtime, only the devices publishing to THIS broker.
          const ownedDevices = devices.filter((rawCloudDevice) => {
            if (isDeviceLocallyReachable(config, rawCloudDevice)) {
              return source === 'local' && buildLocalBrokerConfig(rawCloudDevice).url === url;
            }
            return source === 'cloud';
          });
          runtimeInfos.push({ runtime, source, ownedDevices });
          logger.info(
            `push: ${source} broker ${url}: tracking ${runtime.getStats().trackedDevices} device(s)`,
          );
        }

        // Telemetry watchdog: one INFO line per active source every 5 minutes
        // listing reporting vs silent devices, plus the publish-channel
        // counters, so a device gone quiet is visible without debug logs.
        stopTelemetryWatchdog();
        telemetryWatchdogTimer = setInterval(() => {
          const now = Date.now();
          // Broker connection summary, from the runtimes alive RIGHT NOW (a
          // lazily-connected cloud fallback runtime is included): connection
          // state + (re)connections since the last report. The reconnect
          // delta is the visible trace of the shared-cloud-clientId fight
          // (one INFO line per reconnect would flood the logs instead).
          const liveRuntimes = [...localMqttRuntimes].map(([url, runtime]) => ({
            runtime,
            source: 'local',
            url,
          }));
          if (cloudMqttRuntime) {
            liveRuntimes.push({
              runtime: cloudMqttRuntime,
              source: 'cloud',
              url: cloudData?.mqtt?.url || 'cloud',
            });
          }
          for (const { runtime, source, url } of liveRuntimes) {
            const stats = runtime.getStats();
            const baseline = watchdogConnectBaseline.get(runtime) || 0;
            watchdogConnectBaseline.set(runtime, stats.connectCount);
            logger.info(
              `broker(${source} ${url}): ${stats.connected ? 'connected' : 'disconnected'}, ` +
                `${stats.connectCount - baseline} (re)connection(s) in the last 5 min`,
            );
          }
          for (const { runtime, source, ownedDevices } of runtimeInfos) {
            if (ownedDevices.length === 0) {
              continue;
            }
            const entries = ownedDevices.map((rawCloudDevice) => ({
              label:
                `${rawCloudDevice.deviceName || modelOf(rawCloudDevice)} ` +
                `(${deviceKeyOf(rawCloudDevice)}, SN ${rawCloudDevice.snNumber || 'unknown'})`,
              lastPayloadAt: runtime.getLastPayloadAt(telemetryKeyOf(source, rawCloudDevice)),
            }));
            logger.info(`telemetry(${source}): ${buildTelemetrySummary(entries, now)}`);
          }
          logger.info(
            `publish: ${publishSentCount} sent, ${publishDeduplicatedCount} deduplicated ` +
              `since the last report`,
          );
          publishSentCount = 0;
          publishDeduplicatedCount = 0;
        }, TELEMETRY_WATCHDOG_INTERVAL_IN_MS);
        // Do not keep the process alive just for the watchdog.
        if (typeof telemetryWatchdogTimer.unref === 'function') {
          telemetryWatchdogTimer.unref();
        }

        // Per-device source evaluator: in local mode, re-assess every 30 s
        // which source actually delivers telemetry, with automatic cloud
        // fallback and recovery (see evaluateTelemetrySources).
        stopSourceEvaluator();
        if (config.enable_local_mqtt === true) {
          sourceEvaluatorTimer = setInterval(() => {
            evaluateTelemetrySources(gladys, config).catch((e) =>
              logger.warn(`telemetry: source evaluation failed: ${e.message}`),
            );
          }, SOURCE_EVALUATOR_INTERVAL_IN_MS);
          // Do not keep the process alive just for the evaluator.
          if (typeof sourceEvaluatorTimer.unref === 'function') {
            sourceEvaluatorTimer.unref();
          }
        }
      } catch (e) {
        logger.error('push: Zendure MQTT setup failed', e);
      }
    })();

    return () => {
      stopped = true;
      stopTelemetryWatchdog();
      stopSourceEvaluator();
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      for (const unsubscribe of dynamicUnsubscribes) {
        unsubscribe();
      }
      dynamicUnsubscribes = [];
    };
  },
};
