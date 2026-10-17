// -----------------------------------------------------------------------------
// Device type: ZENDURE SOLARFLOW (and Hyper)
//
// Discovery comes from the Zendure cloud deviceList. Telemetry and control go
// through the best source each device offers, per device and re-assessed
// continuously:
//   1. the zenSDK local HTTP API of the device (`enable_local_http`, on by
//      default; src/zendure/zensdk.js) — what Home Assistant uses;
//   2. the device's local MQTT broker (`enable_local_mqtt`, older firmwares
//      and the Hyper 2000);
//   3. the Zendure cloud MQTT broker, the fallback — connected only while a
//      device needs it, since Zendure allows one cloud consumer per account.
// The raw deviceList entry bootstraps the values until the first report.
//
// Unlike the single-device template blueprints, this blueprint manages ONE
// Gladys device PER Zendure device found in the cloud account: it exposes
// `buildDevices` (plural) and `ownsDevice` for the registry dispatch.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import { toGladysPollFrequency } from '../config.js';
import { decodeCloudKey, fetchCloudData } from '../zendure/client.js';
import { batteryPresenceOf, hasSolarInput, remainingTimeOf } from '../zendure/battery.js';
import { modelCapabilitiesOf } from '../zendure/constants.js';
import {
  createZendureZenSdk,
  parseAddressOverrides,
  parseAddressOverridesDetailed,
  probeZenSdkReport,
  zenSdkAddressOf,
  ZENSDK_FAILURES_BEFORE_DOWN,
} from '../zendure/zensdk.js';
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
  featureNameFor,
} from '../zendure/deviceMapping.js';
import {
  createEnergyMeters,
  deviceCapacityKwh,
  packCapacityKwh,
  ENERGY_FLOWS,
  ENERGY_SAVE_INTERVAL_IN_MS,
} from '../zendure/energy.js';
import {
  buildWriteCommand,
  createWriteThrottle,
  ControlRefusedError,
  reportedValue,
  socScaleOf,
} from '../zendure/control.js';

// Scene trigger fired when a battery goes unreachable or comes back
// (manifest `scene_triggers`).
export const REACHABILITY_TRIGGER = 'battery_reachability_changed';

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
// Outcome of the last cloud deviceList request, for the diagnostic action.
let lastCloudFetch = null;
// The cloud broker is shared by every device; a locally-reachable device is
// served by a runtime connected to the local broker it publishes to.
let cloudMqttRuntime = null;
const localMqttRuntimes = new Map();
// When each runtime was created (ms): drives the startup grace window of the
// per-device freshness checks (a runtime that just connected has obviously
// not received anything yet, which must not count as silence).
let cloudRuntimeStartedAt = 0;
const localRuntimeStartedAt = new Map(); // broker url -> creation time (ms)
// The zenSDK local HTTP runtime (one for every device: it polls each one).
let zenSdkRuntime = null;
// When the polling (re)started: start of the startup grace (see localHttpStateOf).
let zenSdkStartedAt = 0;
// Last time a device needed the cloud broker (see CLOUD_HOLD_TIME_IN_MS).
let cloudLastNeededAt = 0;

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
// A lazily connected cloud broker stays up this long after the last device
// that needed it: a battery whose Wi-Fi blinks every few minutes must not
// take the account's single cloud session away from Home Assistant (and give
// it back) each time.
export const CLOUD_HOLD_TIME_IN_MS = 5 * 60 * 1000;

// Tooltip of the degraded badge (cloud fallback of a locally reachable device),
// in every language of the Gladys interface.
export const LOCAL_SILENT_MESSAGE = {
  en: 'Local telemetry is silent — running on the Zendure cloud fallback.',
  fr: 'Télémétrie locale muette — repli sur le cloud Zendure.',
  de: 'Die lokale Telemetrie schweigt — Betrieb über den Rückfall auf die Zendure-Cloud.',
  es: 'La telemetría local está en silencio — funcionando con el respaldo de la nube de Zendure.',
};

// Same, for a device whose local HTTP API answered before and stopped.
export const LOCAL_HTTP_SILENT_MESSAGE = {
  en: 'The local API of the battery is not answering — running on the Zendure cloud fallback.',
  fr: "L'API locale de la batterie ne répond plus — repli sur le cloud Zendure.",
  de: 'Die lokale API der Batterie antwortet nicht — Betrieb über den Rückfall auf die Zendure-Cloud.',
  es: 'La API local de la batería no responde — funcionando con el respaldo de la nube de Zendure.',
};

// Log names of the sources ('local' is the local MQTT broker).
const SOURCE_LABELS = {
  http: 'local http',
  local: 'local',
  cloud: 'cloud',
  unreachable: 'unreachable',
};
const isLocalSource = (source) => source === 'local' || source === 'http';

// --- Energy meters (src/zendure/energy.js) ------------------------------------
// Created and loaded from /data on the first push start; `dependencies` can
// inject a store for the tests.
let energyMeters = null;
let energyLoad = null;
let energyLoaded = false;
let energySaveTimer = null;

// Rate limiter of the control writes (src/zendure/control.js).
let writeThrottle = createWriteThrottle();

function getEnergyMeters() {
  if (!energyMeters) {
    energyMeters = dependencies.energyMeters || createEnergyMeters();
  }
  return energyMeters;
}

/** Load the saved totals once (the push listeners wait for it). */
function ensureEnergyLoaded() {
  if (!energyLoad) {
    energyLoad = getEnergyMeters()
      .load()
      .then(() => {
        energyLoaded = true;
      });
  }
  return energyLoad;
}

function stopEnergySaveTimer() {
  if (energySaveTimer) {
    clearInterval(energySaveTimer);
    energySaveTimer = null;
  }
}

/** Write the energy totals to /data now (shutdown, tests). */
export async function saveEnergyMeters() {
  if (energyLoaded) {
    await getEnergyMeters().save();
  }
}

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
 * Test hook: poll every device's local HTTP API once, now.
 * @returns {Promise<void>}
 */
export function pollLocalHttpNow() {
  return zenSdkRuntime ? zenSdkRuntime.pollAll() : Promise.resolve();
}

/**
 * Test hook: counters of the local HTTP runtime (null before it exists).
 * @returns {object|null}
 */
export function getLocalHttpStats() {
  return zenSdkRuntime ? zenSdkRuntime.getStats() : null;
}

/**
 * Inject test doubles: `{ fetchImpl, mqttLibrary, localFetchImpl, energyMeters }`.
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
  cloudLastNeededAt = 0;
  for (const runtime of localMqttRuntimes.values()) {
    runtime.disconnect();
  }
  localMqttRuntimes.clear();
  localRuntimeStartedAt.clear();
  if (zenSdkRuntime) {
    zenSdkRuntime.disconnect();
  }
  zenSdkRuntime = null;
  zenSdkStartedAt = 0;
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
  stopEnergySaveTimer();
  writeThrottle = createWriteThrottle();
  energyMeters = null;
  energyLoad = null;
  energyLoaded = false;
  for (const unsubscribe of dynamicUnsubscribes) {
    unsubscribe();
  }
  dynamicUnsubscribes = [];
  cloudData = null;
  lastCloudFetch = null;
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
    try {
      cloudData = await fetchCloudData(config.cloud_key, { fetchImpl: dependencies.fetchImpl });
      lastCloudFetch = { at: Date.now(), error: null };
    } catch (e) {
      // Kept for the diagnostic action: the messages of fetchCloudData never
      // carry the key (and the report scrubs it anyway).
      lastCloudFetch = { at: Date.now(), error: e.message || String(e) };
      throw e;
    }
    if (refresh) {
      refreshLocalHttpDevices(config);
    }
  }
  return cloudData;
}

async function ensureCloudRuntime(config, now = Date.now()) {
  const data = await ensureCloudData(config);
  cloudLastNeededAt = Math.max(cloudLastNeededAt, now);
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
 * Where to reach a device's zenSDK local HTTP API, or null when the option is
 * off, the model has no such API (Hyper 2000) or the device has no serial.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {{ host: string, origin: 'override'|'cloud'|'mdns' }|null}
 */
function localHttpAddressOf(config, rawCloudDevice) {
  if (config.enable_local_http !== true || !modelCapabilitiesOf(modelOf(rawCloudDevice)).zenSdk) {
    return null;
  }
  return zenSdkAddressOf(rawCloudDevice, parseAddressOverrides(config.local_http_addresses));
}

/**
 * State of a device's local HTTP API, or null when it has none (option off,
 * no zenSDK, runtime not started, device not polled):
 *   - 'up': it answers;
 *   - 'pending': it does not answer right now, but it answered within
 *     LOCAL_SILENCE_TIMEOUT_IN_MS (hysteresis: a Wi-Fi blip is not an
 *     outage), or the polling started less than that ago and it has not
 *     missed ZENSDK_FAILURES_BEFORE_DOWN requests yet (startup grace);
 *   - 'down': silent past both windows. Only then may the cloud serve it.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {number} [now] current time (ms)
 * @returns {'up'|'pending'|'down'|null}
 */
function localHttpStateOf(config, rawCloudDevice, now = Date.now()) {
  if (zenSdkRuntime === null || localHttpAddressOf(config, rawCloudDevice) === null) {
    return null;
  }
  const health = zenSdkRuntime.getDeviceHealth(rawCloudDevice.snNumber);
  if (!health) {
    return null;
  }
  if (zenSdkRuntime.isDeviceUp(rawCloudDevice.snNumber, now)) {
    return 'up';
  }
  const answeredRecently =
    health.lastSuccessAt !== null && now - health.lastSuccessAt <= LOCAL_SILENCE_TIMEOUT_IN_MS;
  const inStartupGrace =
    now - zenSdkStartedAt <= LOCAL_SILENCE_TIMEOUT_IN_MS &&
    health.failures < ZENSDK_FAILURES_BEFORE_DOWN;
  return answeredRecently || inStartupGrace ? 'pending' : 'down';
}

/** Whether the local HTTP API of a device answers right now. */
function isLocalHttpUp(config, rawCloudDevice, now = Date.now()) {
  return (
    zenSdkRuntime !== null &&
    localHttpAddressOf(config, rawCloudDevice) !== null &&
    zenSdkRuntime.isDeviceUp(rawCloudDevice.snNumber, now)
  );
}

/** Whether the local HTTP API of a device answered at least once (this run). */
function hasLocalHttpAnswered(config, rawCloudDevice) {
  return (
    zenSdkRuntime !== null &&
    localHttpAddressOf(config, rawCloudDevice) !== null &&
    zenSdkRuntime.getDeviceHealth(rawCloudDevice.snNumber)?.everAnswered === true
  );
}

/**
 * Whether a device has a local source worth tracking (local HTTP API or
 * local MQTT broker): the evaluator follows it and brings it back to local.
 */
function hasLocalCandidate(config, rawCloudDevice) {
  return (
    localHttpAddressOf(config, rawCloudDevice) !== null ||
    isDeviceLocallyReachable(config, rawCloudDevice)
  );
}

/**
 * Whether a device on the cloud is NOT where it should be (degraded badge):
 * its local MQTT broker is configured, or its local HTTP API answered before.
 * A device whose local API never answered is plain "cloud": local access is
 * on by default, and a site without it (Gladys on another network...) must
 * not show every battery as degraded.
 */
function expectsLocal(config, rawCloudDevice) {
  return (
    isDeviceLocallyReachable(config, rawCloudDevice) || hasLocalHttpAnswered(config, rawCloudDevice)
  );
}

/**
 * Source a device should use when the evaluator has no state for it yet: its
 * local HTTP API when it answers, its local MQTT broker when configured, its
 * local HTTP API again while it is pending (see localHttpStateOf), the cloud
 * otherwise. Same order as selectSourceRuntime.
 * @returns {'http'|'local'|'cloud'}
 */
function staticSourceOf(config, rawCloudDevice) {
  const httpState = localHttpStateOf(config, rawCloudDevice);
  if (httpState === 'up') {
    return 'http';
  }
  if (isDeviceLocallyReachable(config, rawCloudDevice)) {
    return 'local';
  }
  return httpState === 'pending' ? 'http' : 'cloud';
}

/** Whether any local transport is enabled (the evaluator then runs). */
function localTransportsEnabled(config) {
  return config.enable_local_mqtt === true || config.enable_local_http === true;
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
 * Select the active telemetry source for one device: prefer the local HTTP
 * API when it answers, then the LOCAL broker when enabled and reachable, then
 * the local HTTP API while it is only pending (a blip, the startup probe not
 * done yet: never a reason to take the cloud session), otherwise fall back to
 * the cloud broker.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {Promise<{ runtime: object, source: 'http'|'local'|'cloud' }>}
 */
async function selectSourceRuntime(config, rawCloudDevice) {
  const httpState = localHttpStateOf(config, rawCloudDevice);
  if (httpState === 'up') {
    return { runtime: zenSdkRuntime, source: 'http' };
  }
  if (isDeviceLocallyReachable(config, rawCloudDevice)) {
    const runtime = await ensureLocalRuntime(config, rawCloudDevice);
    if (runtime) {
      return { runtime, source: 'local' };
    }
  }
  if (httpState === 'pending') {
    return { runtime: zenSdkRuntime, source: 'http' };
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
 * @returns {Promise<{ runtime: object, source: 'http'|'local'|'cloud' }>}
 */
async function selectPollRuntime(config, rawCloudDevice) {
  if (hasLocalCandidate(config, rawCloudDevice)) {
    const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
    // Only while the API answers: otherwise the next source (local broker,
    // pending API, cloud) rather than a write to a dead host.
    if (
      effective &&
      effective.source === 'http' &&
      zenSdkRuntime?.isDeviceUp(rawCloudDevice.snNumber)
    ) {
      return { runtime: zenSdkRuntime, source: 'http' };
    }
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
  if (isLocalSource(source)) {
    return DEVICE_TRANSPORTS.LOCAL;
  }
  if (source === 'cloud') {
    return DEVICE_TRANSPORTS.CLOUD;
  }
  return DEVICE_TRANSPORTS.UNREACHABLE;
}

/**
 * Degraded-badge fields (SDK 0.9 / contract C.3) for a device given its
 * effective source. A device that is SUPPOSED to be served locally (locally
 * reachable) but is currently on the CLOUD fallback is "working, but not
 * nominal": flag it `degraded` with a readable multi-language reason (orange
 * dot on the badge). Every other state — nominal local, nominal cloud-only,
 * unreachable — returns no flag, and publishing an entry WITHOUT `degraded`
 * clears any previous degraded state (back to a clean badge).
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {'local'|'cloud'|'unreachable'} source effective source
 * @returns {{ degraded?: true, message?: Record<string, string> }}
 */
function degradedFieldsFor(config, rawCloudDevice, source) {
  if (source === 'cloud' && expectsLocal(config, rawCloudDevice)) {
    return {
      degraded: true,
      message: hasLocalHttpAnswered(config, rawCloudDevice)
        ? LOCAL_HTTP_SILENT_MESSAGE
        : LOCAL_SILENT_MESSAGE,
    };
  }
  return {};
}

/**
 * Build a transport badge entry for a device: the transport value, plus the
 * degraded flag when the device is on cloud fallback while it should be local.
 * A device the account reports offline stays a plain 'unreachable' (a device
 * that is not answering at all is not "degraded", it is down).
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {'local'|'cloud'|'unreachable'} source effective source
 * @returns {{ external_id: string, transport: string, degraded?: true, message?: object }}
 */
function buildTransportEntry(gladys, config, rawCloudDevice, source) {
  const external_id = gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice)).device;
  if (rawCloudDevice.online === false) {
    return { external_id, transport: DEVICE_TRANSPORTS.UNREACHABLE };
  }
  return {
    external_id,
    transport: transportOfSource(source),
    ...degradedFieldsFor(config, rawCloudDevice, source),
  };
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
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {'local'|'cloud'|'unreachable'} nextSource new effective source
 * @param {number} now current time (ms)
 * @returns {{ external_id: string, transport: string, degraded?: true, message?: object }|null}
 */
function applySourceTransition(gladys, config, rawCloudDevice, nextSource, now) {
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
  const from = SOURCE_LABELS[previous.source];
  const to = SOURCE_LABELS[nextSource];
  let detail;
  if (nextSource === 'unreachable') {
    detail = `unreachable (no local or cloud message for ${formatDuration(UNREACHABLE_TIMEOUT_IN_MS)})`;
  } else if (isLocalSource(nextSource) && isLocalSource(previous.source)) {
    detail = `${from} -> ${to} (after ${elapsed} on ${from})`;
  } else if (isLocalSource(nextSource)) {
    const recovery =
      previous.source === 'cloud' ? `after ${elapsed} on cloud` : `after ${elapsed} unreachable`;
    detail = `${from} -> ${to} (recovered ${recovery})`;
  } else if (isLocalSource(previous.source)) {
    detail = `${from} -> cloud fallback (local silent for ${elapsed})`;
  } else {
    detail = `unreachable -> cloud (cloud telemetry resumed after ${elapsed})`;
  }
  logger.info(`telemetry: ${deviceLabelOf(rawCloudDevice)}: ${detail}`);

  // "Went unreachable" and "came back" are events, not states: scene trigger.
  if (nextSource === 'unreachable' || previous.source === 'unreachable') {
    publishReachabilityEvent(gladys, rawCloudDevice, nextSource);
  }

  return buildTransportEntry(gladys, config, rawCloudDevice, nextSource);
}

/**
 * Fire the reachability scene trigger, without ever failing the evaluator
 * (an older core without scene events, a rate limit...).
 * @param {object} gladys Gladys SDK instance
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {'local'|'cloud'|'unreachable'} source new effective source
 */
function publishReachabilityEvent(gladys, rawCloudDevice, source) {
  if (typeof gladys.publishSceneEvent !== 'function') {
    return;
  }
  const data = {
    device: gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice)).device,
    state: source === 'unreachable' ? 'unreachable' : 'reachable',
    device_name: rawCloudDevice.deviceName || modelOf(rawCloudDevice),
    // The documented values of this scene variable are local, cloud and
    // unreachable: the local HTTP API is "local" there.
    source: source === 'http' ? 'local' : source,
  };
  Promise.resolve()
    .then(() => gladys.publishSceneEvent(REACHABILITY_TRIGGER, data))
    .catch((e) => logger.debug(`scene event ${REACHABILITY_TRIGGER} not published: ${e.message}`));
}

/**
 * Send a control command to one battery (scene actions, widget buttons):
 * validated, clamped and rate limited by src/zendure/control.js, then sent
 * as `properties/write` through the source currently serving the device (an
 * HTTP POST on the local API, an MQTT publish on a broker).
 * The new value shows up with the device's next report.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {string} deviceExternalId Gladys device external_id
 * @param {object} command see buildWriteCommand
 * @returns {Promise<{ sent: boolean, applied: Record<string, number>, source?: string }>}
 */
export async function controlDevice(gladys, config, deviceExternalId, command) {
  const deviceKey = String(deviceExternalId || '')
    .split(':')
    .pop();
  const data = await ensureCloudData(config);
  const rawCloudDevice = deviceKey ? findSupportedDevice(data, deviceKey) : null;
  if (!rawCloudDevice) {
    throw new ControlRefusedError(`unknown Zendure battery "${deviceExternalId}"`);
  }

  const { runtime, source } = await selectPollRuntime(config, rawCloudDevice);
  const payload = payloadFor(
    source,
    rawCloudDevice,
    runtime.getLatestPayload(telemetryKeyOf(source, rawCloudDevice)),
  );
  const write = buildWriteCommand(command, { productModel: modelOf(rawCloudDevice), payload });
  if (!write) {
    logger.info(
      `control: ${deviceLabelOf(rawCloudDevice)} already at ${command.kind}, nothing sent`,
    );
    return { sent: false, applied: {} };
  }

  const now = Date.now();
  writeThrottle.check(deviceKey, write.setting, now);
  await runtime.writeDeviceProperties(rawCloudDevice, write.properties);
  writeThrottle.record(deviceKey, write.setting, now);
  logger.info(
    `control: ${deviceLabelOf(rawCloudDevice)} <- ${JSON.stringify(write.properties)} ` +
      `(${source === 'http' ? 'local http API' : `${source} broker`})`,
  );
  // Ask for a fresh report so the new value shows up quickly (cloud and
  // local HTTP; the local broker pushes on its own).
  runtime.requestDeviceProperties(rawCloudDevice);
  return { sent: true, applied: write.applied, source };
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
 * Build the push listener of one source. The LOCAL HTTP listener always
 * publishes: an answer of the device IS proof of local health, so it also
 * moves the device (back) to 'http'. The LOCAL MQTT listener does the same,
 * except while the local HTTP API serves the device (then the HTTP feed is
 * the one published). The CLOUD listener publishes only when no local
 * source serves the device, avoiding duplicates while a local feed is
 * healthy (the paced publish channel deduplicates by value anyway).
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {'http'|'local'|'cloud'} source source of the runtime this listener serves
 * @returns {Function} `(key, payload) => void` payload listener
 */
function createPushListener(gladys, config, source) {
  return (key, payload) => {
    // The local runtimes (HTTP and MQTT) emit the serial number as key; the
    // cloud one emits the device key.
    const rawCloudDevice =
      source === 'cloud'
        ? findSupportedDevice(cloudData, key)
        : findSupportedDeviceBySerial(cloudData, key);
    if (!rawCloudDevice) {
      return;
    }
    // Default to the static preference when the evaluator has no state yet.
    const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
    const effectiveSource = effective ? effective.source : staticSourceOf(config, rawCloudDevice);
    if (source === 'http') {
      if (localHttpAddressOf(config, rawCloudDevice) === null) {
        return;
      }
      const entry = applySourceTransition(gladys, config, rawCloudDevice, 'http', Date.now());
      if (entry) {
        publishTransportEntries(gladys, [entry]);
      }
    } else if (source === 'local') {
      if (effectiveSource === 'http' && isLocalHttpUp(config, rawCloudDevice)) {
        return;
      }
      if (config.enable_local_mqtt === true) {
        const entry = applySourceTransition(gladys, config, rawCloudDevice, 'local', Date.now());
        if (entry) {
          publishTransportEntries(gladys, [entry]);
        }
      }
    } else if (isLocalSource(effectiveSource)) {
      return;
    }
    const states = [
      ...buildStates(gladys, rawCloudDevice, payload),
      ...buildEnergyStates(gladys, rawCloudDevice, payload, { integrate: true }),
    ];
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
 * @param {'http'|'local'|'cloud'} source source of the runtime
 * @returns {Function} unsubscribe
 */
function attachSourceListener(gladys, config, runtime, source) {
  return runtime.onPayload(createPushListener(gladys, config, source));
}

/**
 * Re-assess the effective telemetry source of every device with a local
 * source (local HTTP API and/or local MQTT broker):
 *   - local HTTP API answering -> 'http';
 *   - else local broker fresh (within LOCAL_SILENCE_TIMEOUT_IN_MS, grace
 *     included) -> 'local';
 *   - else cloud fresh (same grace logic) -> 'cloud';
 *   - else silent on EVERY source beyond UNREACHABLE_TIMEOUT_IN_MS -> 'unreachable';
 *   - else keep the previous source (pending, no flapping).
 * Transitions are logged and their badges published in one call. Also owns
 * the LAZY cloud connection: the Zendure cloud broker enforces one consumer
 * per account, so it stays disconnected while every device is healthy locally
 * and is only brought up when at least one device went locally silent (then
 * released again after two consecutive all-local evaluations).
 * Scheduled every SOURCE_EVALUATOR_INTERVAL_IN_MS by startPush when a local
 * transport is enabled; `now` is injectable for tests.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {number} [now] current time (ms)
 */
export async function evaluateTelemetrySources(gladys, config, now = Date.now()) {
  if (!localTransportsEnabled(config) || !cloudData) {
    return;
  }
  const allDevices = supportedDevices(cloudData);
  const localModeDevices = allDevices.filter((rawCloudDevice) =>
    hasLocalCandidate(config, rawCloudDevice),
  );
  if (localModeDevices.length === 0) {
    return;
  }

  const changedEntries = [];
  const locallySilent = [];
  for (const rawCloudDevice of localModeDevices) {
    const withHttp = localHttpAddressOf(config, rawCloudDevice) !== null;
    const httpState = withHttp ? localHttpStateOf(config, rawCloudDevice, now) : null;
    if (httpState === 'up') {
      const entry = applySourceTransition(gladys, config, rawCloudDevice, 'http', now);
      if (entry) {
        changedEntries.push(entry);
      }
      continue;
    }
    // Latest sign of local life, over both local sources (startup grace of
    // each runtime included).
    let localActivityAt = withHttp
      ? lastSourceActivityAt(zenSdkRuntime, rawCloudDevice.snNumber, zenSdkStartedAt)
      : 0;
    if (isDeviceLocallyReachable(config, rawCloudDevice)) {
      const brokerUrl = buildLocalBrokerConfig(rawCloudDevice).url;
      const mqttActivityAt = lastSourceActivityAt(
        localMqttRuntimes.get(brokerUrl) || null,
        rawCloudDevice.snNumber,
        localRuntimeStartedAt.get(brokerUrl),
      );
      if (now - mqttActivityAt <= LOCAL_SILENCE_TIMEOUT_IN_MS) {
        const entry = applySourceTransition(gladys, config, rawCloudDevice, 'local', now);
        if (entry) {
          changedEntries.push(entry);
        }
        continue;
      }
      localActivityAt = Math.max(localActivityAt, mqttActivityAt);
    }
    if (httpState === 'pending') {
      // A short blip or the startup probe: keep the current source.
      continue;
    }
    locallySilent.push({ rawCloudDevice, localActivityAt });
  }
  if (locallySilent.length > 0) {
    cloudLastNeededAt = Math.max(cloudLastNeededAt, now);
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
      entry = applySourceTransition(gladys, config, rawCloudDevice, 'cloud', now);
    } else if (
      now - localActivityAt > UNREACHABLE_TIMEOUT_IN_MS &&
      now - cloudActivityAt > UNREACHABLE_TIMEOUT_IN_MS
    ) {
      entry = applySourceTransition(gladys, config, rawCloudDevice, 'unreachable', now);
    }
    // Otherwise: pending state, keep the previous source (no flapping).
    if (entry) {
      changedEntries.push(entry);
    }
  }

  await publishTransportEntries(gladys, changedEntries);

  // Lazy cloud disconnect: once every local-mode device has been back on a
  // local source for two consecutive evaluations, no device needed the cloud
  // for CLOUD_HOLD_TIME_IN_MS (and no device statically needs it), release
  // the cloud broker for other consumers of the account (Home Assistant on
  // the same account, typically).
  const everyDeviceLocal = localModeDevices.every((rawCloudDevice) =>
    isLocalSource(effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice))?.source),
  );
  allLocalEvaluationStreak = everyDeviceLocal ? allLocalEvaluationStreak + 1 : 0;
  const cloudStaticallyNeeded = allDevices.length > localModeDevices.length;
  if (
    allLocalEvaluationStreak >= 2 &&
    cloudMqttRuntime &&
    !cloudStaticallyNeeded &&
    now - cloudLastNeededAt >= CLOUD_HOLD_TIME_IN_MS
  ) {
    cloudMqttRuntime.disconnect();
    cloudMqttRuntime = null;
    cloudRuntimeStartedAt = 0;
    logger.info(
      `fallback: all devices back on local for ${formatDuration(now - cloudLastNeededAt)} ` +
        '-> cloud broker disconnected',
    );
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
 * the serial number for the LOCAL runtimes (HTTP and MQTT), the device key
 * for the CLOUD one.
 * @param {'http'|'local'|'cloud'} source selected telemetry source
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {string}
 */
function telemetryKeyOf(source, rawCloudDevice) {
  return isLocalSource(source) ? rawCloudDevice.snNumber : deviceKeyOf(rawCloudDevice);
}

/**
 * The payload to read a device's values from. LOCAL MQTT payloads are built
 * incrementally (one metric per topic): a metric the device has not
 * re-published yet (state of charge, solar power at night...) would otherwise
 * never get a value, so the local cache is merged OVER the cloud deviceList
 * snapshot. The cloud and local HTTP reports are used as they are: their
 * `properties` are complete, and the raw entry's top-level values would
 * shadow the fresher nested ones.
 * @param {'http'|'local'|'cloud'} source
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {object|null} latestPayload cached payload of the source
 * @returns {object}
 */
function payloadFor(source, rawCloudDevice, latestPayload) {
  if (source === 'local' && latestPayload) {
    return { ...rawCloudDevice, ...latestPayload };
  }
  return latestPayload || rawCloudDevice;
}

/**
 * Build the Gladys states for one device from a Zendure payload (MQTT report
 * or raw cloud deviceList entry). Metrics without a value are skipped.
 */
function buildStates(gladys, rawCloudDevice, payload) {
  const ids = gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice));
  const states = [];

  for (const featureMapping of getFeaturesForModel(modelOf(rawCloudDevice))) {
    if (featureMapping.computed) {
      continue; // see buildEnergyStates
    }
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

/**
 * Build the states of the computed energy features of one device: the energy
 * indexes (integrated powers) and the energy remaining in the packs. With
 * `integrate`, the payload is a FRESH report and its powers advance the
 * meters; without it (polling a cached payload), the current totals are only
 * re-published. Nothing before the saved totals are loaded.
 * @param {object} gladys Gladys SDK instance
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {object} payload merged telemetry payload
 * @param {{ integrate: boolean, at?: number }} options
 * @returns {Array<{ device_feature_external_id: string, state: number }>}
 */
function buildEnergyStates(gladys, rawCloudDevice, payload, { integrate, at = Date.now() }) {
  if (!energyLoaded) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, deviceKeyOf(rawCloudDevice));
  const features = getFeaturesForModel(modelOf(rawCloudDevice));
  const meters = getEnergyMeters();
  let totals;
  if (integrate) {
    const powers = {};
    for (const featureMapping of features) {
      if (featureMapping.key in ENERGY_FLOWS) {
        const value = extractMetricValue(payload, featureMapping.metricPaths);
        if (value !== null) {
          powers[featureMapping.key] = value;
        }
      }
    }
    totals = meters.update(deviceKeyOf(rawCloudDevice), powers, at);
  } else {
    totals = meters.totals(deviceKeyOf(rawCloudDevice));
  }

  const states = Object.entries(totals).map(([key, kwh]) => ({
    device_feature_external_id: ids.feature(key),
    state: kwh,
  }));

  // Stored energy = state of charge x capacity of the known packs.
  const capacity = deviceCapacityKwh(payload);
  const levelMapping = features.find((featureMapping) => featureMapping.key === 'batteryLevel');
  const level = levelMapping ? extractMetricValue(payload, levelMapping.metricPaths) : null;
  if (capacity !== null && level !== null) {
    states.push({
      device_feature_external_id: ids.feature('batteryEnergyRemaining'),
      state: Math.round(normalizeMetricValue('batteryLevel', level) * capacity) / 100,
    });
  }
  return states;
}

/**
 * The source serving a device right now and the payload to read its values
 * from, out of the runtimes already running (never opens a connection).
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {string|undefined} effective source tracked by the evaluator
 * @returns {{ source: string, payload: object }}
 */
function currentPayloadOf(config, rawCloudDevice, effective) {
  const source =
    rawCloudDevice.online === false
      ? 'unreachable'
      : (effective ?? staticSourceOf(config, rawCloudDevice));
  // The runtime whose cache to read ('unreachable' reads the cloud one).
  const readSource = isLocalSource(source) ? source : 'cloud';
  const runtimes = {
    http: zenSdkRuntime,
    local: localMqttRuntimes.get(buildLocalBrokerConfig(rawCloudDevice)?.url),
    cloud: cloudMqttRuntime,
  };
  const cached = runtimes[readSource]?.getLatestPayload(telemetryKeyOf(readSource, rawCloudDevice));
  return { source, payload: payloadFor(readSource, rawCloudDevice, cached) };
}

/**
 * Snapshot of every supported battery for the dashboard widgets: names, the
 * source serving each one, the latest telemetry and the reported control
 * settings. Read-only: it uses the runtimes already running and never opens
 * a broker connection (a dashboard must not change the transport).
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @returns {Promise<Array<object>>}
 */
export async function describeBatteries(gladys, config) {
  const data = cloudData || (await ensureCloudData(config));
  return supportedDevices(data).map((rawCloudDevice) => {
    const deviceKey = deviceKeyOf(rawCloudDevice);
    const ids = gladys.externalIds(DEVICE_TYPE, deviceKey);
    const effective = hasLocalCandidate(config, rawCloudDevice)
      ? effectiveSourceByDeviceKey.get(deviceKey)?.source
      : undefined;
    const { source, payload } = currentPayloadOf(config, rawCloudDevice, effective);

    const values = {};
    for (const featureMapping of getFeaturesForModel(modelOf(rawCloudDevice))) {
      if (!featureMapping.computed) {
        const value = extractMetricValue(payload, featureMapping.metricPaths);
        values[featureMapping.key] =
          value === null ? null : normalizeMetricValue(featureMapping.key, value);
      }
    }
    const capacityKwh = deviceCapacityKwh(payload);
    const scale = socScaleOf(payload);
    const scaled = (property) => {
      const value = reportedValue(payload, property);
      return value === null || scale === null ? null : Math.round(value / scale);
    };
    const settings = {
      outputLimit: reportedValue(payload, 'outputLimit'),
      inputLimit: reportedValue(payload, 'inputLimit'),
      acMode: reportedValue(payload, 'acMode'),
      socSet: scaled('socSet'),
      minSoc: scaled('minSoc'),
    };
    const hasBattery = batteryPresenceOf(modelOf(rawCloudDevice), payload);
    return {
      externalId: ids.device,
      featureExternalId: (key) => ids.feature(key),
      name: rawCloudDevice.deviceName || modelOf(rawCloudDevice),
      model: modelOf(rawCloudDevice),
      source,
      degraded: source === 'cloud' && expectsLocal(config, rawCloudDevice),
      values,
      // true / false, or null while the telemetry has not told yet.
      hasBattery,
      hasSolar: hasSolarInput(modelOf(rawCloudDevice), values.solarInputPower),
      capacityKwh,
      remainingKwh:
        capacityKwh !== null && values.batteryLevel !== null
          ? Math.round(values.batteryLevel * capacityKwh) / 100
          : null,
      remainingTime:
        hasBattery === false
          ? null
          : remainingTimeOf(payload, {
              level: values.batteryLevel,
              chargePower: values.batteryOutputPower,
              dischargePower: values.batteryInputPower,
              capacityKwh,
              socSet: settings.socSet,
              minSoc: settings.minSoc,
            }),
      settings,
      // Energy meters (src/zendure/energy.js): `energyReady` false until the
      // saved totals are loaded (the first push start), `energySince(ms)`
      // the energy since a moment, null when nothing was integrated since.
      energyReady: energyLoaded,
      energySince: (since) =>
        energyLoaded ? getEnergyMeters().energySince(deviceKey, since) : null,
    };
  });
}

// --- Diagnostic (manifest actions fleet_diagnostic / test_local_api) ---------
// Read-only snapshots of the runtimes for src/diagnostic.js, which formats and
// redacts them. Nothing here opens a broker connection or changes a source:
// a diagnostic must observe the installation, not disturb it.

// Window of the "(re)connections" count of the brokers in the diagnostic.
export const DIAGNOSTIC_RECONNECT_WINDOW_IN_MS = 5 * 60 * 1000;

/**
 * Whether a raw cloud device matches what the user typed: its name, serial
 * number, device key or Gladys external id (case-insensitive).
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {string} reference typed reference
 * @returns {boolean}
 */
function matchesReference(rawCloudDevice, reference) {
  const ref = String(reference || '')
    .trim()
    .toLowerCase();
  if (ref === '') {
    return false;
  }
  const candidates = [
    rawCloudDevice.deviceName,
    rawCloudDevice.snNumber,
    deviceKeyOf(rawCloudDevice),
  ].map((value) => String(value || '').toLowerCase());
  return (
    candidates.includes(ref) ||
    ref.endsWith(`:${String(deviceKeyOf(rawCloudDevice)).toLowerCase()}`)
  );
}

/**
 * The supported devices a reference designates: exact matches (name, serial,
 * device key, external id), else the devices whose name contains it.
 * @param {Array<object>} devices supported raw cloud devices
 * @param {string} reference typed reference
 * @returns {Array<object>}
 */
export function findDevicesByReference(devices, reference) {
  const exact = devices.filter((rawCloudDevice) => matchesReference(rawCloudDevice, reference));
  if (exact.length > 0) {
    return exact;
  }
  const ref = String(reference || '')
    .trim()
    .toLowerCase();
  return ref === ''
    ? []
    : devices.filter((rawCloudDevice) =>
        String(rawCloudDevice.deviceName || '')
          .toLowerCase()
          .includes(ref),
      );
}

/**
 * Every secret the diagnostic text must never contain, whatever the options:
 * the cloud key and its app key, the cloud and local broker credentials.
 * @param {object} config normalized configuration
 * @returns {Array<string>}
 */
function diagnosticSecretsOf(config) {
  const secrets = [config.cloud_key];
  try {
    secrets.push(decodeCloudKey(config.cloud_key).appKey);
  } catch {
    // No usable key: nothing more to hide.
  }
  secrets.push(cloudData?.mqtt?.username, cloudData?.mqtt?.password);
  for (const rawCloudDevice of cloudData?.deviceList || []) {
    secrets.push(rawCloudDevice.username, rawCloudDevice.password);
  }
  return secrets.filter((secret) => typeof secret === 'string' && secret.trim() !== '');
}

/** Diagnostic view of one MQTT runtime (no credential: url and counters only). */
function brokerDiagnosticOf(runtime, url, now) {
  const stats = runtime.getStats();
  return {
    url,
    connected: stats.connected,
    connectCount: stats.connectCount,
    reconnectsInWindow:
      typeof runtime.connectionsSince === 'function'
        ? runtime.connectionsSince(now - DIAGNOSTIC_RECONNECT_WINDOW_IN_MS)
        : null,
    takeOverWarned: stats.takeOverWarned === true,
    trackedDevices: stats.trackedDevices,
    messagesReceived: stats.messagesReceived,
  };
}

/**
 * State of the local HTTP API of a device for the diagnostic: why it is not
 * used, or its health.
 * @param {object} config normalized configuration
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {number} now current time (ms)
 * @returns {object}
 */
function localHttpDiagnosticOf(config, rawCloudDevice, now) {
  const model = modelOf(rawCloudDevice);
  const overrides = parseAddressOverrides(config.local_http_addresses);
  const address = zenSdkAddressOf(rawCloudDevice, overrides);
  if (!modelCapabilitiesOf(model).zenSdk) {
    return { status: 'unsupported-model', address: null };
  }
  if (address === null) {
    return { status: 'no-serial', address: null };
  }
  if (config.enable_local_http !== true) {
    return { status: 'off', address };
  }
  const health = zenSdkRuntime?.getDeviceHealth(rawCloudDevice.snNumber) || null;
  if (!zenSdkRuntime || !health) {
    return { status: zenSdkRuntime ? 'not-polled' : 'not-started', address };
  }
  return {
    status: localHttpStateOf(config, rawCloudDevice, now) || 'down',
    address: { host: health.host, origin: health.origin },
    failures: health.failures,
    lastError: health.lastError,
    lastSuccessAt: health.lastSuccessAt,
  };
}

/** Pack list of a payload (flat local MQTT or `properties` + `packData`). */
function packsOf(payload) {
  const packs = payload?.packData ?? payload?.properties?.packData;
  return Array.isArray(packs) ? packs : null;
}

/**
 * Snapshot of the whole installation for the fleet diagnostic action: the
 * configuration (no secret), the cloud API, every broker, the local HTTP
 * runtime, and one entry per battery (optionally filtered). RAW values:
 * src/diagnostic.js redacts them. `secrets` lists what must never be shown.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {{ filter?: string, now?: number }} [options]
 * @returns {Promise<object>}
 */
export async function describeDiagnostics(gladys, config, { filter = '', now = Date.now() } = {}) {
  if (!cloudData && config.cloud_key) {
    // A first diagnostic before any discovery: try once, the outcome is
    // part of the report.
    await ensureCloudData(config).catch(() => {});
  }
  const allDevices = cloudData?.deviceList || [];
  const supported = supportedDevices(cloudData);
  const { overrides, invalid } = parseAddressOverridesDetailed(config.local_http_addresses);
  const knownSerials = new Set(supported.map((d) => String(d.snNumber || '').toUpperCase()));

  const filterText = String(filter || '').trim();
  const selected = filterText === '' ? supported : findDevicesByReference(supported, filterText);

  const brokers = [];
  if (cloudMqttRuntime) {
    brokers.push({
      kind: 'cloud',
      ...brokerDiagnosticOf(cloudMqttRuntime, cloudData?.mqtt?.url || 'cloud', now),
    });
  }
  for (const [url, runtime] of localMqttRuntimes) {
    brokers.push({ kind: 'local', ...brokerDiagnosticOf(runtime, url, now) });
  }

  const devices = selected.map((rawCloudDevice) => {
    const deviceKey = deviceKeyOf(rawCloudDevice);
    const model = modelOf(rawCloudDevice);
    const tracked = hasLocalCandidate(config, rawCloudDevice)
      ? effectiveSourceByDeviceKey.get(deviceKey)
      : undefined;
    const { source, payload } = currentPayloadOf(config, rawCloudDevice, tracked?.source);
    const degraded = source === 'cloud' && expectsLocal(config, rawCloudDevice);
    const brokerUrl = isDeviceLocallyReachable(config, rawCloudDevice)
      ? buildLocalBrokerConfig(rawCloudDevice).url
      : null;
    const localRuntime = brokerUrl ? localMqttRuntimes.get(brokerUrl) || null : null;

    const values = {};
    for (const featureMapping of getFeaturesForModel(model)) {
      if (!featureMapping.computed) {
        const value = extractMetricValue(payload, featureMapping.metricPaths);
        values[featureMapping.key] =
          value === null ? null : normalizeMetricValue(featureMapping.key, value);
      }
    }
    const scale = socScaleOf(payload);
    const settings = {
      outputLimit: reportedValue(payload, 'outputLimit'),
      inputLimit: reportedValue(payload, 'inputLimit'),
      acMode: reportedValue(payload, 'acMode'),
      socSet: reportedValue(payload, 'socSet'),
      minSoc: reportedValue(payload, 'minSoc'),
      socScale: scale,
      smartMode: reportedValue(payload, 'smartMode'),
    };
    const capacityKwh = deviceCapacityKwh(payload);
    const packs = packsOf(payload);
    const hasBattery = batteryPresenceOf(model, payload);
    const scaled = (value) => (value === null || scale === null ? null : Math.round(value / scale));
    return {
      name: rawCloudDevice.deviceName || model,
      model,
      serial: rawCloudDevice.snNumber || null,
      deviceKey,
      externalId: gladys.externalIds(DEVICE_TYPE, deviceKey).device,
      online: rawCloudDevice.online,
      source,
      sourceSince: tracked?.since ?? null,
      sourceTracked: tracked !== undefined,
      degraded,
      degradedReason: degraded
        ? (hasLocalHttpAnswered(config, rawCloudDevice)
            ? LOCAL_HTTP_SILENT_MESSAGE
            : LOCAL_SILENT_MESSAGE
          ).en
        : null,
      lastDataAt: {
        http: zenSdkRuntime?.getLastPayloadAt(rawCloudDevice.snNumber) ?? null,
        local: localRuntime?.getLastPayloadAt(rawCloudDevice.snNumber) ?? null,
        cloud: cloudMqttRuntime?.getLastPayloadAt(deviceKey) ?? null,
      },
      localHttp: localHttpDiagnosticOf(config, rawCloudDevice, now),
      localMqtt: {
        configured: brokerUrl !== null,
        advertised: buildLocalBrokerConfig(rawCloudDevice) !== null,
        brokerUrl,
        connected: localRuntime ? localRuntime.connected === true : null,
      },
      battery: {
        presence: hasBattery,
        level: values.batteryLevel ?? null,
        packNum: reportedValue(payload, 'packNum'),
        packs: packs
          ? packs.map((pack) => ({
              sn: typeof pack?.sn === 'string' ? pack.sn : null,
              capacityKwh: packCapacityKwh(pack),
              socLevel: typeof pack?.socLevel === 'number' ? pack.socLevel : null,
            }))
          : null,
        capacityKwh,
      },
      solar: {
        modelHasInput: modelCapabilitiesOf(model).solarInput,
        power: values.solarInputPower ?? null,
        hasSolar: hasSolarInput(model, values.solarInputPower),
      },
      powers: values,
      settings,
      remaining: {
        remainOutTime: reportedValue(payload, 'remainOutTime'),
        remainInputTime: reportedValue(payload, 'remainInputTime'),
        computed:
          hasBattery === false
            ? null
            : remainingTimeOf(payload, {
                level: values.batteryLevel ?? null,
                chargePower: values.batteryOutputPower ?? null,
                dischargePower: values.batteryInputPower ?? null,
                capacityKwh,
                socSet: scaled(settings.socSet),
                minSoc: scaled(settings.minSoc),
              }),
      },
      energy: energyLoaded ? getEnergyMeters().totals(deviceKey) : null,
    };
  });

  const currentSources = supported.map((rawCloudDevice) => {
    const tracked = hasLocalCandidate(config, rawCloudDevice)
      ? effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice))?.source
      : undefined;
    return { rawCloudDevice, source: currentPayloadOf(config, rawCloudDevice, tracked).source };
  });
  const zenSdkStats = zenSdkRuntime ? zenSdkRuntime.getStats() : null;

  return {
    generatedAt: now,
    config: {
      cloudKeySet: config.cloud_key !== '',
      pollFrequency: config.poll_frequency,
      gladysPollFrequencyMs: toGladysPollFrequency(config.poll_frequency),
      enableLocalHttp: config.enable_local_http === true,
      enableLocalMqtt: config.enable_local_mqtt === true,
      featureNames: config.feature_names,
      addressOverrides: {
        count: overrides.size,
        invalid: invalid.length,
        unmatched: [...overrides.keys()].filter((serial) => !knownSerials.has(serial)),
      },
    },
    cloud: {
      loaded: cloudData !== null,
      lastFetchAt: lastCloudFetch?.at ?? null,
      lastFetchError: lastCloudFetch?.error ?? null,
      deviceCount: allDevices.length,
      supportedCount: supported.length,
      unsupportedModels: allDevices
        .filter((rawCloudDevice) => !supported.includes(rawCloudDevice))
        .map((rawCloudDevice) => modelOf(rawCloudDevice)),
      brokerUrl: cloudData?.mqtt?.url || null,
    },
    cloudBroker: {
      connected: cloudMqttRuntime !== null,
      needing: currentSources
        .filter(({ source }) => !isLocalSource(source))
        .map(({ rawCloudDevice }) => rawCloudDevice.deviceName || modelOf(rawCloudDevice)),
      allLocal:
        currentSources.length > 0 && currentSources.every(({ source }) => isLocalSource(source)),
      lastNeededAt: cloudLastNeededAt || null,
      holdMs: CLOUD_HOLD_TIME_IN_MS,
    },
    brokers,
    localHttp: zenSdkStats
      ? {
          running: zenSdkStats.connected,
          startedAt: zenSdkStartedAt || null,
          trackedDevices: zenSdkStats.trackedDevices,
          devicesUp: zenSdkStats.devicesUp,
          requests: zenSdkStats.requests,
          failures: zenSdkStats.failures,
        }
      : null,
    filter: filterText,
    availableNames: supported.map((d) => d.deviceName || modelOf(d)),
    devices,
    secrets: diagnosticSecretsOf(config),
  };
}

/**
 * Test the local API of ONE battery now (test_local_api action): resolve its
 * address like the polling does and read `GET /properties/report` once,
 * through the running runtime when it polls the device (one request in
 * flight per device), directly otherwise. Never writes to the device.
 * @param {object} gladys Gladys SDK instance
 * @param {object} config normalized configuration
 * @param {string} reference name, serial number, device key or external id
 * @returns {Promise<object>} raw outcome, formatted by src/diagnostic.js
 */
export async function testLocalApi(gladys, config, reference) {
  const data = await ensureCloudData(config);
  const supported = supportedDevices(data);
  const matches = findDevicesByReference(supported, reference);
  const base = {
    reference: String(reference || '').trim(),
    availableNames: supported.map((d) => d.deviceName || modelOf(d)),
    secrets: diagnosticSecretsOf(config),
  };
  if (matches.length !== 1) {
    return {
      ...base,
      found: false,
      ambiguous: matches.map((d) => d.deviceName || modelOf(d)),
    };
  }
  const [rawCloudDevice] = matches;
  const model = modelOf(rawCloudDevice);
  const overrides = parseAddressOverrides(config.local_http_addresses);
  const address = zenSdkAddressOf(rawCloudDevice, overrides);
  const outcome = {
    ...base,
    found: true,
    device: {
      name: rawCloudDevice.deviceName || model,
      model,
      serial: rawCloudDevice.snNumber || null,
      deviceKey: deviceKeyOf(rawCloudDevice),
    },
    optionEnabled: config.enable_local_http === true,
    modelHasZenSdk: modelCapabilitiesOf(model).zenSdk,
    address,
    viaRuntime: false,
    result: null,
  };
  if (!outcome.modelHasZenSdk || address === null) {
    return outcome;
  }
  const polled =
    zenSdkRuntime?.getDeviceHealth(rawCloudDevice.snNumber)?.host === address.host
      ? zenSdkRuntime
      : null;
  if (polled) {
    outcome.viaRuntime = true;
    outcome.result = await polled.probeDevice(rawCloudDevice.snNumber);
  } else {
    outcome.result = await probeZenSdkReport({
      host: address.host,
      fetchImpl: dependencies.localFetchImpl,
    });
  }
  return outcome;
}

/**
 * The devices that have a local API address, with it.
 * @param {object} config normalized configuration
 * @param {Array<object>} devices supported raw cloud devices
 * @returns {Array<{ rawCloudDevice: object, address: { host: string, origin: string } }>}
 */
function localHttpEntriesOf(config, devices) {
  return devices
    .map((rawCloudDevice) => ({
      rawCloudDevice,
      address: localHttpAddressOf(config, rawCloudDevice),
    }))
    .filter((entry) => entry.address !== null);
}

/** The local HTTP runtime's device list built from the entries. */
const toZenSdkDevices = (entries) =>
  entries.map(({ rawCloudDevice, address }) => ({
    rawCloudDevice,
    host: address.host,
    origin: address.origin,
  }));

/**
 * After a refreshed cloud device list (discovery): hand the new addresses to
 * the running local HTTP runtime, so a battery that got a new IP address is
 * polled at it (setDevices keeps the loop of every unchanged device and
 * starts exactly one for a moved one). Nothing before startPush started it.
 * @param {object} config normalized configuration
 */
function refreshLocalHttpDevices(config) {
  if (!zenSdkRuntime || config.enable_local_http !== true) {
    return;
  }
  const entries = localHttpEntriesOf(config, supportedDevices(cloudData));
  for (const { rawCloudDevice, address } of entries) {
    const previous = zenSdkRuntime.getDeviceHealth(rawCloudDevice.snNumber);
    if (previous && previous.host !== address.host) {
      logger.info(
        `local http: ${deviceLabelOf(rawCloudDevice)}: address changed from ${previous.host} ` +
          `to ${address.host}`,
      );
    }
  }
  zenSdkRuntime.setDevices(toZenSdkDevices(entries));
}

/**
 * Log, once per start, the pairs of the local API addresses option that are
 * not used: malformed, or matching no battery of the account. Serial numbers
 * and IP addresses only (no secret in this option).
 * @param {object} config normalized configuration
 * @param {Array<object>} devices supported raw cloud devices
 */
function logUnusedAddressOverrides(config, devices) {
  const { overrides, invalid } = parseAddressOverridesDetailed(config.local_http_addresses);
  for (const pair of invalid) {
    logger.info(
      `local http: "${pair.slice(0, 80)}" ignored in the local API addresses option ` +
        '(expected SERIAL=IP address)',
    );
  }
  const knownSerials = new Set(
    devices.map((rawCloudDevice) => String(rawCloudDevice.snNumber || '').toUpperCase()),
  );
  for (const [serial, host] of overrides) {
    if (!knownSerials.has(serial)) {
      logger.info(
        `local http: "${serial}=${host}" in the local API addresses option matches no ` +
          'battery serial number of the Zendure account',
      );
    }
  }
}

/**
 * Bring up (or tear down) the zenSDK local HTTP runtime for the devices that
 * have a local API address, probe each one once and log the outcome, then
 * start the polling loops. A device that misses the probe is not moved to
 * the cloud: it stays pending through the startup grace (localHttpStateOf).
 * @param {object} config normalized configuration
 * @param {Array<object>} devices supported raw cloud devices
 */
async function startLocalHttp(config, devices) {
  const entries = localHttpEntriesOf(config, devices);
  if (entries.length === 0) {
    if (zenSdkRuntime) {
      zenSdkRuntime.disconnect();
      zenSdkRuntime = null;
      zenSdkStartedAt = 0;
      logger.info('push: local http API no longer used -> polling stopped');
    }
    return;
  }
  logUnusedAddressOverrides(config, devices);
  if (!zenSdkRuntime) {
    zenSdkRuntime = createZendureZenSdk({ fetchImpl: dependencies.localFetchImpl });
  }
  // A new runtime, or one stopped by the push cleanup: the startup grace
  // starts now (a running one keeps its own).
  if (!zenSdkRuntime.connected) {
    zenSdkStartedAt = Date.now();
  }
  for (const { rawCloudDevice, address } of entries) {
    if (address.origin === 'mdns') {
      logger.info(
        `local http: ${deviceLabelOf(rawCloudDevice)}: no IP address in the Zendure device list, ` +
          `trying its mDNS name ${address.host} (mDNS rarely resolves inside a Docker container: ` +
          `if it does not answer, add "${rawCloudDevice.snNumber}=<its IP address>" to the ` +
          'local API addresses option)',
      );
    }
  }
  zenSdkRuntime.setDevices(toZenSdkDevices(entries));
  await zenSdkRuntime.pollAll();

  const silent = entries.filter(({ rawCloudDevice }) => !isLocalHttpUp(config, rawCloudDevice));
  logger.info(
    `local http: ${entries.length - silent.length}/${entries.length} device(s) answer on ` +
      'their zenSDK local API',
  );
  for (const { rawCloudDevice, address } of silent) {
    const health = zenSdkRuntime.getDeviceHealth(rawCloudDevice.snNumber);
    const origin = { override: 'from the options', cloud: 'from the cloud', mdns: 'mDNS' }[
      address.origin
    ];
    logger.info(
      `local http: ${deviceLabelOf(rawCloudDevice)} not answering at ${address.host} ` +
        `(${origin}): ${health?.lastError || 'no answer'} -> retried in the background, ` +
        `${isDeviceLocallyReachable(config, rawCloudDevice) ? 'its local MQTT broker' : 'the cloud'} ` +
        'serves it if it stays silent',
    );
  }
  zenSdkRuntime.start();
}

/**
 * The devices each live source serves, for the telemetry watchdog: every
 * device with a local API address under 'http' (the silent ones show which
 * device does not answer and why), the local-MQTT devices under their broker,
 * and the devices currently served by the cloud under 'cloud'.
 * @param {object} config normalized configuration
 * @param {Array<object>} devices supported raw cloud devices
 * @returns {Array<{ source: string, runtime: object|null, ownedDevices: Array<object> }>}
 */
function watchdogGroups(config, devices) {
  const groups = [];
  const httpDevices = devices.filter((d) => localHttpAddressOf(config, d) !== null);
  if (zenSdkRuntime && httpDevices.length > 0) {
    groups.push({ source: 'http', runtime: zenSdkRuntime, ownedDevices: httpDevices });
  }
  for (const [url, runtime] of localMqttRuntimes) {
    const ownedDevices = devices.filter(
      (d) =>
        isDeviceLocallyReachable(config, d) &&
        buildLocalBrokerConfig(d).url === url &&
        effectiveSourceByDeviceKey.get(deviceKeyOf(d))?.source !== 'http',
    );
    if (ownedDevices.length > 0) {
      groups.push({ source: 'local', runtime, ownedDevices });
    }
  }
  const cloudDevices = devices.filter((d) => {
    const effective = hasLocalCandidate(config, d)
      ? effectiveSourceByDeviceKey.get(deviceKeyOf(d))?.source
      : undefined;
    return !isLocalSource(effective ?? staticSourceOf(config, d));
  });
  if (cloudDevices.length > 0) {
    groups.push({ source: 'cloud', runtime: cloudMqttRuntime, ownedDevices: cloudDevices });
  }
  return groups;
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
    // The exact cloud string is what a new model entry needs (several model
    // spellings are still unverified): log it so users can report it as is.
    for (const rawCloudDevice of data?.deviceList || []) {
      if (!devices.includes(rawCloudDevice)) {
        logger.warn(
          `Unsupported Zendure model skipped: productModel ${JSON.stringify(modelOf(rawCloudDevice))} ` +
            '(please report it on the gladys-zendure issues)',
        );
      }
    }

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
          name: featureNameFor(featureMapping, config.feature_names),
          external_id: ids.feature(featureMapping.key),
          // Composed with the device selector so two devices never share a
          // feature selector (the core enforces global uniqueness).
          selector: featureSelectorOf(rawCloudDevice, featureMapping.key),
          category: featureMapping.category,
          type: featureMapping.type,
          unit: featureMapping.unit,
          min: featureMapping.min,
          max: featureMapping.max,
          read_only: true, // telemetry only: no control
          has_feedback: false,
          keep_history: true,
        })),
      };
    });
  },

  /**
   * Per-device transport badges: devices the Zendure account reports offline
   * (`online === false` in the deviceList) are 'unreachable'; devices with a
   * local source (local HTTP API, local MQTT broker) follow their EFFECTIVE
   * source when the evaluator tracked one (local/cloud fallback/unreachable),
   * the static preference otherwise; everything else is 'cloud'.
   * Reads the cloudData cached by the last discovery.
   */
  async buildTransports(gladys, config) {
    const data = await ensureCloudData(config);
    return supportedDevices(data).map((rawCloudDevice) => {
      // Effective source: the one the evaluator tracked (local / cloud
      // fallback / unreachable), the static 'local' when a locally-reachable
      // device has no effective state yet, 'cloud' otherwise. The degraded
      // flag (cloud fallback of a local device) is added by buildTransportEntry.
      let source = 'cloud';
      if (hasLocalCandidate(config, rawCloudDevice)) {
        const effective = effectiveSourceByDeviceKey.get(deviceKeyOf(rawCloudDevice));
        source = effective ? effective.source : staticSourceOf(config, rawCloudDevice);
      }
      return buildTransportEntry(gladys, config, rawCloudDevice, source);
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
    logger.debug(`onPoll: using ${SOURCE_LABELS[source]} source for ${deviceKey}`);
    // Local telemetry is keyed by serial number, cloud telemetry by device key.
    const telemetryKey = telemetryKeyOf(source, rawCloudDevice);
    const lastPayloadAt = runtime.getLastPayloadAt(telemetryKey);
    if (!lastPayloadAt || Date.now() - lastPayloadAt > MQTT_STALE_TIMEOUT_IN_MS) {
      runtime.requestDeviceProperties(rawCloudDevice);
    }

    // Local MQTT payloads are merged over the cloud snapshot, the cloud and
    // local HTTP reports used as they are (see payloadFor).
    const latestPayload = runtime.getLatestPayload(telemetryKey);
    // A disconnected broker means the cache is BLIND, not that values are
    // stable: re-publishing it (30-min keep-alive included) would present
    // stale data as fresh during an outage. Skip until the broker is back.
    // (Without any cached payload yet, the raw cloud entry still bootstraps.)
    // The local HTTP runtime is always "connected" while it polls: its
    // blindness is the device's own health.
    const blind =
      source === 'http' ? !runtime.isDeviceUp(rawCloudDevice.snNumber) : !runtime.connected;
    if (blind && latestPayload) {
      logger.debug(
        `onPoll: ${SOURCE_LABELS[source]} source blind for ${deviceKey}, cached republish skipped`,
      );
      return;
    }
    const payload = payloadFor(source, rawCloudDevice, latestPayload);
    const states = buildStates(gladys, rawCloudDevice, payload);
    if (states.length > 0) {
      // The totals only: a cached payload is not a new interval to integrate.
      states.push(...buildEnergyStates(gladys, rawCloudDevice, payload, { integrate: false }));
    }
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
        await ensureEnergyLoaded();
        stopEnergySaveTimer();
        energySaveTimer = setInterval(() => {
          saveEnergyMeters().catch(() => {});
        }, ENERGY_SAVE_INTERVAL_IN_MS);
        if (typeof energySaveTimer.unref === 'function') {
          energySaveTimer.unref();
        }

        // Local HTTP API first: probe every device once, so the source of
        // each one is known before choosing which brokers to connect (a site
        // where every device answers never connects the cloud broker).
        await startLocalHttp(config, devices);
        if (stopped) {
          return;
        }

        // Explicit source breakdown in the logs: which device is served by its
        // local HTTP API, by the LOCAL broker (and which one) or by the
        // Zendure CLOUD broker.
        const localByBroker = new Map(); // broker url -> [device labels]
        const httpDeviceLabels = [];
        const cloudDeviceLabels = [];
        const labelOf = (d) => d.deviceName || deviceKeyOf(d);
        for (const rawCloudDevice of devices) {
          const staticSource = staticSourceOf(config, rawCloudDevice);
          if (staticSource === 'http') {
            httpDeviceLabels.push(
              isLocalHttpUp(config, rawCloudDevice)
                ? labelOf(rawCloudDevice)
                : `${labelOf(rawCloudDevice)} (not answering yet)`,
            );
          } else if (staticSource === 'local') {
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
          `push: telemetry source -> ${httpDeviceLabels.length} local http / ${localCount} local ` +
            `/ ${cloudDeviceLabels.length} cloud (of ${devices.length} device(s))`,
        );
        if (httpDeviceLabels.length > 0) {
          logger.info(
            `push: LOCAL HTTP API -> ${httpDeviceLabels.length} device(s): ${httpDeviceLabels.join(', ')}`,
          );
        }
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
          // A configured local broker stays connected behind the local HTTP
          // API (it costs nothing on the LAN): it takes over at once if the
          // API stops answering, before any cloud fallback.
          if (source === 'http' && isDeviceLocallyReachable(config, rawCloudDevice)) {
            const standby = await ensureLocalRuntime(config, rawCloudDevice);
            if (standby && !runtimesBySource.has(standby)) {
              runtimesBySource.set(standby, 'local');
            }
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
          return effective !== undefined && !isLocalSource(effective.source);
        });
        const cloudHeld = Date.now() - cloudLastNeededAt < CLOUD_HOLD_TIME_IN_MS;
        if (
          cloudMqttRuntime &&
          !runtimesBySource.has(cloudMqttRuntime) &&
          !cloudNeededByFallback &&
          !cloudHeld
        ) {
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
        if (zenSdkRuntime) {
          activeRuntimes.push({ runtime: zenSdkRuntime, source: 'http', url: 'zenSDK' });
        }
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

        for (const { runtime, source, url } of activeRuntimes) {
          unsubscribes.push(attachSourceListener(gladys, config, runtime, source));
          logger.info(
            source === 'http'
              ? `push: local http API: polling ${runtime.getStats().trackedDevices} device(s)`
              : `push: ${source} broker ${url}: tracking ${runtime.getStats().trackedDevices} device(s)`,
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
          for (const { source, runtime, ownedDevices } of watchdogGroups(config, devices)) {
            const entries = ownedDevices.map((rawCloudDevice) => {
              const health =
                source === 'http' ? runtime?.getDeviceHealth(rawCloudDevice.snNumber) : null;
              return {
                label:
                  `${rawCloudDevice.deviceName || modelOf(rawCloudDevice)} ` +
                  `(${deviceKeyOf(rawCloudDevice)}, SN ${rawCloudDevice.snNumber || 'unknown'}` +
                  `${health?.lastError ? `, ${health.host}: ${health.lastError}` : ''})`,
                lastPayloadAt: runtime
                  ? runtime.getLastPayloadAt(telemetryKeyOf(source, rawCloudDevice))
                  : null,
              };
            });
            logger.info(
              `telemetry(${SOURCE_LABELS[source]}): ${buildTelemetrySummary(entries, now)}`,
            );
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

        // Per-device source evaluator: with a local transport, re-assess every 30 s
        // which source actually delivers telemetry, with automatic cloud
        // fallback and recovery (see evaluateTelemetrySources).
        stopSourceEvaluator();
        if (localTransportsEnabled(config)) {
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
      // Stop the local API polling (caches and health kept: the next
      // startPush resumes it).
      zenSdkRuntime?.stop();
      stopEnergySaveTimer();
      saveEnergyMeters().catch(() => {});
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
