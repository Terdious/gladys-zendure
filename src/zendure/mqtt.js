// -----------------------------------------------------------------------------
// Zendure MQTT runtimes.
//
// Two transport runtimes share the same connection machinery (see
// `createBaseMqttRuntime`) but consume different telemetry formats:
//
//   - `createZendureMqtt` (CLOUD): connects to the cloud broker described by the
//     deviceList response, subscribes to the per-device topics
//     (iot/{productKey}/{deviceKey}/# and /{productKey}/{deviceKey}/#), sends
//     `properties/read` requests, and caches the latest merged JSON payload
//     keyed by deviceKey (reports are partial).
//
//   - `createZendureLocalMqtt` (LOCAL): connects to a user-provided broker the
//     device PUBLISHES TO natively, using the flat per-property topic scheme
//     `Zendure/sensor/{serialNumber}/{metricName}` where each message carries a
//     single plain scalar payload. Telemetry is keyed by SERIAL NUMBER
//     (the cloud `snNumber` field). The device pushes continuously, so there is
//     no read-request in local mode.
//
// Both runtimes are self-contained transports with no Gladys state manager
// access; telemetry interpretation (metric extraction) is the job of the device
// layer. Each caches the latest merged payload per key and notifies listeners on
// every update (real-time push).
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'zendure-mqtt' });

const DEFAULT_CONNECT_TIMEOUT_IN_MS = 12000;

/**
 * Normalize an MQTT URL to a format supported by mqtt.js.
 * @param {string} url raw URL from the Zendure API (may lack a scheme)
 * @returns {string|null}
 */
export function normalizeMqttUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  if (
    url.startsWith('mqtt://') ||
    url.startsWith('mqtts://') ||
    url.startsWith('ws://') ||
    url.startsWith('wss://')
  ) {
    return url;
  }
  return `mqtt://${url}`;
}

// Schemes accepted as-is when the device advertises its local MQTT protocol.
const KNOWN_MQTT_SCHEMES = new Set(['mqtt', 'mqtts', 'ws', 'wss', 'tcp', 'ssl']);

/**
 * Build the local MQTT broker configuration from a raw cloud deviceList entry.
 *
 * When local MQTT is enabled in the Zendure app (developer mode), the cloud
 * deviceList exposes, per device, the parameters of the broker the device
 * PUBLISHES TO: `server` (broker host), `port`, `protocol`, `username` and
 * `password`. This helper turns them into the `{ url, username, password }`
 * shape expected by `connect()`. It does NOT check the local `enable` flag nor
 * the integration option — that reachability decision belongs to the caller.
 *
 * NOTE: the host is `server` ONLY. `ip` is the device's own LAN address (used
 * by the local HTTP/zenSDK API, a different mechanism) and is NOT an MQTT
 * broker, so it must never be used as a broker host.
 *
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {{ url: string, username?: string, password?: string }|null} null
 * when the device advertises no local broker host.
 */
export function buildLocalBrokerConfig(rawCloudDevice) {
  if (!rawCloudDevice || typeof rawCloudDevice !== 'object') {
    return null;
  }

  const host = rawCloudDevice.server;
  if (!host || typeof host !== 'string' || host.trim() === '') {
    return null;
  }

  const rawProtocol = String(rawCloudDevice.protocol || '')
    .trim()
    .toLowerCase()
    .replace('://', '');
  const scheme = KNOWN_MQTT_SCHEMES.has(rawProtocol) ? rawProtocol : 'mqtt';

  const port = Number(rawCloudDevice.port);
  const hasPort = Number.isFinite(port) && port > 0;

  return {
    url: `${scheme}://${host.trim()}${hasPort ? `:${port}` : ''}`,
    username: rawCloudDevice.username,
    password: rawCloudDevice.password,
  };
}

/**
 * Extract the device key from a Zendure MQTT topic.
 * Topics come as `iot/{productKey}/{deviceKey}/...` or `/{productKey}/{deviceKey}/...`.
 * @param {string} topic MQTT topic
 * @returns {string|null}
 */
export function extractDeviceKeyFromTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return null;
  }
  const parts = topic.split('/');
  if (parts.length < 4) {
    return null;
  }
  if (parts[0] === 'iot' || parts[0] === '') {
    return parts[2] || null;
  }
  return null;
}

/**
 * Whether a JSON-format topic carries device telemetry (`properties/report`).
 * The wildcard subscriptions also deliver every OTHER message under the device
 * root — time-sync, register, firmware chatter, and even the ECHO of the
 * `properties/read` requests WE publish (a broker delivers a publication back
 * to a matching subscriber, including its author). Merging those into the
 * telemetry cache pollutes it with junk keys and, worse, refreshes the
 * per-device freshness timestamp: a dead device would look alive just because
 * we keep asking it for data. Only report topics may feed the cache.
 * @param {string} topic MQTT topic
 * @returns {boolean}
 */
export function isReportTopic(topic) {
  return typeof topic === 'string' && topic.endsWith('/properties/report');
}

/**
 * Whether a JSON-format topic is a REQUEST/COMMAND channel (read requests,
 * write bundles, function invocations) rather than telemetry. Used as a
 * deny-list by the LOCAL legacy path, which must stay permissive about
 * telemetry topics (some firmwares publish root-level metrics outside
 * `properties/report`) but must never ingest command echoes.
 * @param {string} topic MQTT topic
 * @returns {boolean}
 */
export function isRequestTopic(topic) {
  return (
    typeof topic === 'string' &&
    (topic.endsWith('/properties/read') ||
      topic.endsWith('/properties/write') ||
      topic.endsWith('/function/invoke'))
  );
}

// Prefix of the native local topic scheme the device publishes its telemetry
// to: `Zendure/sensor/{serialNumber}/{metricName}`.
const LOCAL_SENSOR_TOPIC_PREFIX = 'Zendure/sensor';

/**
 * Parse a native local sensor topic `Zendure/sensor/{sn}/{metric}`.
 * @param {string} topic MQTT topic
 * @returns {{ serial: string, metric: string }|null} null when it is not a
 * sensor telemetry topic (settings topics number/select/switch are ignored).
 */
export function parseLocalSensorTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return null;
  }
  const parts = topic.split('/');
  // Zendure / sensor / {sn} / {metric}
  if (parts.length < 4 || parts[0] !== 'Zendure' || parts[1] !== 'sensor') {
    return null;
  }
  const serial = parts[2];
  const metric = parts[parts.length - 1];
  if (!serial || !metric) {
    return null;
  }
  return { serial, metric };
}

/**
 * Parse a native local scalar payload: the device publishes plain values, not
 * JSON. A stringified finite number becomes a Number; anything else keeps its
 * trimmed string form (e.g. "discharging", "idle").
 * @param {Buffer|string} payload raw MQTT payload
 * @returns {number|string}
 */
export function parseLocalScalar(payload) {
  const text = (payload === undefined || payload === null ? '' : payload.toString()).trim();
  if (text !== '') {
    const numericValue = Number(text);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }
  return text;
}

/**
 * Merge two MQTT payloads: some `properties/report` messages only carry a
 * subset of the properties, so the cache keeps a rolling merge.
 * @param {object|undefined} previousPayload payload already in cache
 * @param {object} incomingPayload freshly received payload
 * @returns {object}
 */
export function mergeMqttPayload(previousPayload, incomingPayload) {
  const base = previousPayload && typeof previousPayload === 'object' ? previousPayload : {};
  const incoming = incomingPayload && typeof incomingPayload === 'object' ? incomingPayload : {};

  const merged = { ...base, ...incoming };

  // `properties` must be a plain object: a read REQUEST carries an ARRAY
  // (`properties: ['getAll']`) which would otherwise spread into junk
  // index keys and shadow the object cache.
  const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const baseProperties = isPlainObject(base.properties) ? base.properties : {};
  const incomingProperties = isPlainObject(incoming.properties) ? incoming.properties : {};
  if (Object.keys(baseProperties).length > 0 || Object.keys(incomingProperties).length > 0) {
    merged.properties = { ...baseProperties, ...incomingProperties };
  }

  return merged;
}

/**
 * Shared MQTT runtime factory. It owns the connection state machine (connect,
 * unique client id, reconnect handling, "resolve after first connect or
 * timeout"), the tracked-devices set, the per-key payload cache and the
 * listener fan-out. Each concrete runtime (cloud/local) parametrizes it with:
 *   - `normalizeKey(rawKey)`: how a cache/lookup key is normalized;
 *   - `getDeviceKey(rawCloudDevice)`: the tracking key of a device, or null to
 *     skip a device that lacks the required fields;
 *   - `topicsForDevice(rawCloudDevice)`: the topics to subscribe for a device;
 *   - `parseMessage(topic, payload)`: turn a message into
 *     `{ key, partialPayload }` (merged into the cache), or null to ignore it;
 *   - `buildRequestDeviceProperties(context)` (optional): builds the
 *     `requestDeviceProperties(rawCloudDevice)` implementation; defaults to a
 *     no-op returning false. `context` exposes `{ getClient, isConnected,
 *     subscribeDevice }`.
 *
 * @param {object} params
 * @returns {object} the runtime
 */
function createBaseMqttRuntime({
  mqttLibrary = mqtt,
  clientId,
  connectTimeout,
  normalizeKey,
  getDeviceKey,
  topicsForDevice,
  parseMessage,
  buildRequestDeviceProperties,
}) {
  // A per-runtime random suffix, computed ONCE and kept stable across
  // reconnections (mqtt.js reuses the same client id when it reconnects).
  const runtimeSuffix = Math.random().toString(36).slice(2, 10);
  const mqttClientId = clientId || `gladys-zendure-${runtimeSuffix}`;
  const connectTimeoutInMs = connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_IN_MS;

  let client = null;
  let connected = false;
  let connectionSignature = null;

  const subscribedTopics = new Set();
  const trackedDevices = new Map(); // normalized key -> raw cloud device
  const latestPayloadByKey = new Map();
  const lastPayloadAtByKey = new Map();
  const payloadListeners = new Set();
  let messagesReceived = 0;
  // Connection log throttling: the first connect of a session is INFO, the
  // automatic reconnections are DEBUG (the 5-min watchdog reports the count).
  // A rapid take-over cycle (another consumer fighting over a shared client
  // id, e.g. Home Assistant on the same Zendure cloud account) is diagnosed
  // once at WARN instead of flooding one INFO line per reconnect.
  let connectCount = 0;
  let lastConnectAt = 0;
  let rapidReconnects = 0;
  let takeOverWarned = false;

  function subscribeDevice(rawCloudDevice) {
    if (!rawCloudDevice) {
      return;
    }
    const deviceKey = getDeviceKey(rawCloudDevice);
    if (!deviceKey) {
      return;
    }

    // Remember the device so subscriptions survive broker reconnections.
    trackedDevices.set(deviceKey, rawCloudDevice);

    if (!client || !connected) {
      return;
    }

    for (const topic of topicsForDevice(rawCloudDevice)) {
      if (subscribedTopics.has(topic)) {
        continue;
      }
      client.subscribe(topic, (error, granted) => {
        if (error) {
          logger.warn(
            `Zendure MQTT subscribe failed for topic "${topic}": ${error.message}` +
              `${error.code !== undefined ? ` (code=${error.code})` : ''}`,
          );
          return;
        }
        // A SUBACK can also refuse silently: reason codes >= 128 land in
        // granted[].qos without an error object.
        const refused = Array.isArray(granted) && granted.find((g) => g && g.qos > 2);
        if (refused) {
          logger.warn(`Zendure MQTT subscription refused for "${topic}" (qos=${refused.qos}).`);
          return;
        }
        subscribedTopics.add(topic);
        logger.debug(`Zendure MQTT subscribed to ${topic}.`);
      });
    }
  }

  function refreshSubscriptions() {
    trackedDevices.forEach((rawCloudDevice) => subscribeDevice(rawCloudDevice));
  }

  function handleMessage(topic, payload) {
    messagesReceived += 1;
    const parsed = parseMessage(topic, payload);
    if (!parsed || !parsed.key) {
      return;
    }

    const key = parsed.key;
    const previousPayload = latestPayloadByKey.get(key);
    const mergedPayload = mergeMqttPayload(previousPayload, parsed.partialPayload);
    latestPayloadByKey.set(key, mergedPayload);
    lastPayloadAtByKey.set(key, Date.now());

    for (const listener of payloadListeners) {
      try {
        listener(key, mergedPayload, topic);
      } catch (e) {
        logger.warn(`Zendure MQTT payload listener failed: ${e.message}`);
      }
    }
  }

  function teardownClient() {
    if (client) {
      try {
        client.removeAllListeners();
        client.end(true);
      } catch (e) {
        logger.debug('Zendure MQTT client cleanup failed.', e);
      }
    }
    client = null;
    connected = false;
    connectionSignature = null;
    subscribedTopics.clear();
  }

  const requestDeviceProperties = buildRequestDeviceProperties
    ? buildRequestDeviceProperties({
        getClient: () => client,
        isConnected: () => connected,
        subscribeDevice,
      })
    : // Local devices push continuously: there is no read-request to send.
      () => false;

  return {
    get connected() {
      return connected;
    },

    /**
     * Connect to the MQTT broker described by `mqttConfiguration`. Reconnections
     * are handled by mqtt.js; an initial failure is logged, not thrown — the
     * client keeps retrying in the background. Calling connect() again with the
     * same broker/credentials is a no-op.
     * @param {{ url?: string, username?: string, password?: string, clientId?: string }} mqttConfiguration
     * @returns {Promise<void>} resolves once connected (or after the timeout)
     */
    async connect(mqttConfiguration) {
      if (!mqttConfiguration || typeof mqttConfiguration !== 'object') {
        logger.warn('Zendure MQTT configuration is missing.');
        return;
      }

      const mqttUrl = normalizeMqttUrl(mqttConfiguration.url);
      if (!mqttUrl) {
        logger.warn('Zendure MQTT URL is missing.');
        return;
      }

      const signature = `${mqttUrl}::${mqttConfiguration.username || ''}::${mqttConfiguration.password || ''}`;
      if (client && connectionSignature === signature) {
        if (connected) {
          refreshSubscriptions();
        }
        return;
      }

      teardownClient();

      // Client id handling differs by broker:
      //   - CLOUD: the Zendure cloud broker scopes its topic ACL to the EXACT
      //     client id it hands out in the deviceList metadata. Altering it (even
      //     appending a suffix) makes every SUBSCRIBE fail with an "unspecified
      //     error" SUBACK. So when the broker provides a client id, use it AS-IS.
      //     Consequence: only ONE consumer per Zendure account may use the cloud
      //     broker at a time (two would fight over the shared id); run the local
      //     broker path for any second instance.
      //   - LOCAL: no client id is provided, so we use our own unique generated
      //     id (the local broker has no such ACL), which also avoids any clash
      //     between several Gladys instances / the HA integration.
      const effectiveClientId = mqttConfiguration.clientId || mqttClientId;
      logger.info(
        `Zendure MQTT connecting to ${mqttUrl} ` +
          `(metadata fields: ${Object.keys(mqttConfiguration).join(', ')}; ` +
          `clientId: ${mqttConfiguration.clientId ? 'broker-provided (exact)' : 'generated'})`,
      );
      client = mqttLibrary.connect(mqttUrl, {
        clientId: effectiveClientId,
        username: mqttConfiguration.username,
        password: mqttConfiguration.password,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        clean: true,
      });
      connectionSignature = signature;

      client.on('connect', () => {
        connected = true;
        refreshSubscriptions();
        connectCount += 1;
        const now = Date.now();
        const isRapid = lastConnectAt !== 0 && now - lastConnectAt < 60 * 1000;
        rapidReconnects = isRapid ? rapidReconnects + 1 : 0;
        lastConnectAt = now;
        if (connectCount === 1) {
          logger.info(`Zendure MQTT connected to ${mqttUrl}.`);
        } else {
          logger.debug(`Zendure MQTT reconnected to ${mqttUrl} (connection #${connectCount}).`);
        }
        if (rapidReconnects >= 5 && !takeOverWarned && mqttConfiguration.clientId) {
          takeOverWarned = true;
          logger.warn(
            `Zendure MQTT session on ${mqttUrl} keeps being taken over ` +
              `(${rapidReconnects + 1} reconnections in under a minute each): another consumer ` +
              `of the same Zendure account (Home Assistant, a second Gladys instance...) is ` +
              `fighting over the shared cloud client id. Telemetry flows but may be intermittent; ` +
              `only one cloud consumer per account is supported by Zendure.`,
          );
        }
        // Counts are meaningless at connect time (subscriptions are still in
        // flight): keep them out of the INFO line, expose them via getStats().
        logger.debug(
          `Zendure MQTT state after connect: ${subscribedTopics.size} topic(s) ` +
            `for ${trackedDevices.size} device(s).`,
        );
      });
      client.on('offline', () => {
        connected = false;
        logger.debug('Zendure MQTT client is offline, waiting for automatic reconnect.');
      });
      client.on('close', () => {
        connected = false;
        // clean:true sessions lose their subscriptions on disconnect.
        subscribedTopics.clear();
      });
      client.on('error', (error) => {
        logger.warn(`Zendure MQTT error: ${error.message}`);
      });
      client.on('message', (topic, payload) => {
        handleMessage(topic, payload);
      });

      // Wait for the first connection, without failing hard: the mqtt client
      // keeps reconnecting in the background either way.
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Zendure MQTT initial connection timed out, retrying in background.');
          resolve();
        }, connectTimeoutInMs);
        const settle = () => {
          clearTimeout(timeout);
          resolve();
        };
        client.once('connect', settle);
        client.once('error', settle);
      });
    },

    /** Subscribe the per-device topics of one raw cloud device. */
    subscribeDevice,

    /**
     * Ask the device for fresh properties (cloud only; a no-op returning false
     * on the local runtime, where the device pushes continuously).
     * @param {object} rawCloudDevice device from the cloud deviceList
     * @returns {boolean} true when a request was published
     */
    requestDeviceProperties,

    /**
     * Latest merged payload for one key (deviceKey on cloud, serial on local),
     * or null.
     * @param {string} key lookup key
     */
    getLatestPayload(key) {
      if (!key) {
        return null;
      }
      return latestPayloadByKey.get(normalizeKey(key)) || null;
    },

    /**
     * Timestamp (ms) of the last payload received for one key, or null.
     * @param {string} key lookup key
     */
    getLastPayloadAt(key) {
      if (!key) {
        return null;
      }
      return lastPayloadAtByKey.get(normalizeKey(key)) || null;
    },

    /**
     * Diagnostic snapshot of this runtime, for the device-layer logs: honest
     * counts of what is actually subscribed/tracked/received right now.
     * @returns {{ connected: boolean, subscribedTopics: number,
     * trackedDevices: number, messagesReceived: number, keysWithPayload: number,
     * connectCount: number }}
     */
    getStats() {
      return {
        connected,
        subscribedTopics: subscribedTopics.size,
        trackedDevices: trackedDevices.size,
        messagesReceived,
        keysWithPayload: latestPayloadByKey.size,
        connectCount,
      };
    },

    /**
     * Register a listener called on every payload update:
     * `(key, mergedPayload, topic) => void`.
     * @param {Function} listener
     * @returns {Function} unsubscribe
     */
    onPayload(listener) {
      payloadListeners.add(listener);
      return () => payloadListeners.delete(listener);
    },

    /** Disconnect and clear every runtime cache. */
    disconnect() {
      teardownClient();
      trackedDevices.clear();
      latestPayloadByKey.clear();
      lastPayloadAtByKey.clear();
      payloadListeners.clear();
    },
  };
}

/**
 * Create the Zendure CLOUD MQTT runtime. Telemetry is keyed by deviceKey
 * (case-insensitive) and carried as JSON `properties/report` payloads.
 * @param {{ mqttLibrary?: typeof mqtt, clientId?: string, connectTimeout?: number }} [options]
 * `mqttLibrary` is injectable for tests (must expose `connect(url, options)`).
 * @returns {object} the runtime
 */
export function createZendureMqtt({ mqttLibrary = mqtt, clientId, connectTimeout } = {}) {
  const normalizeKey = (key) => String(key).toLowerCase();

  return createBaseMqttRuntime({
    mqttLibrary,
    clientId,
    connectTimeout,
    normalizeKey,
    getDeviceKey(rawCloudDevice) {
      const { productKey } = rawCloudDevice;
      const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
      if (!productKey || !deviceKey) {
        return null;
      }
      return normalizeKey(deviceKey);
    },
    topicsForDevice(rawCloudDevice) {
      const { productKey } = rawCloudDevice;
      const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
      return [`iot/${productKey}/${deviceKey}/#`, `/${productKey}/${deviceKey}/#`];
    },
    parseMessage(topic, payload) {
      // Only `properties/report` carries telemetry; everything else under the
      // wildcard (read/write requests — including OUR OWN echoes — time-sync,
      // register...) must neither feed the cache nor refresh the freshness.
      if (!isReportTopic(topic)) {
        return null;
      }
      const deviceKey = extractDeviceKeyFromTopic(topic);
      if (!deviceKey) {
        return null;
      }

      let decodedPayload;
      try {
        decodedPayload = JSON.parse(payload.toString());
      } catch {
        logger.debug(`Zendure MQTT message ignored (invalid JSON) topic=${topic}.`);
        return null;
      }

      // Messages tagged isHA are the ones third-party clients (like us) send:
      // skip our own echoes.
      if (!decodedPayload || decodedPayload.isHA) {
        return null;
      }

      return { key: normalizeKey(deviceKey), partialPayload: decodedPayload };
    },
    buildRequestDeviceProperties({ getClient, isConnected, subscribeDevice }) {
      let messageId = 0;
      return (rawCloudDevice) => {
        const client = getClient();
        if (!client || !isConnected() || !rawCloudDevice) {
          return false;
        }

        subscribeDevice(rawCloudDevice);

        const { productKey } = rawCloudDevice;
        const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
        if (!deviceKey || !productKey) {
          return false;
        }

        const requestTopic = `iot/${productKey}/${deviceKey}/properties/read`;
        messageId = (messageId + 1) % 1000000;
        const payload = {
          deviceId: deviceKey,
          messageId,
          timestamp: Math.floor(Date.now() / 1000),
          properties: ['getAll'],
        };

        client.publish(requestTopic, JSON.stringify(payload), (error) => {
          if (error) {
            logger.warn(`Zendure MQTT read request failed for ${deviceKey}: ${error.message}`);
          }
        });

        logger.debug(`Zendure MQTT read request sent for ${deviceKey}.`);
        return true;
      };
    },
  });
}

/**
 * Create the Zendure LOCAL MQTT runtime. Depending on the firmware generation,
 * a device publishes on its local broker EITHER the native flat topic scheme
 * `Zendure/sensor/{serialNumber}/{metricName}` (one plain scalar per message)
 * OR the legacy JSON topics `iot/{productKey}/{deviceKey}/...` (the same
 * format as the cloud broker; e.g. the SolarFlow 800 Pro only publishes the
 * legacy format locally). The runtime subscribes to BOTH and keys everything
 * by SERIAL NUMBER (the cloud `snNumber` field), accumulating a flat payload
 * object per serial so `buildStates`/`extractMetricValue` can read the metrics
 * by leaf key. Legacy JSON payloads are flattened by merging their
 * `properties` object.
 * @param {{ mqttLibrary?: typeof mqtt, clientId?: string, connectTimeout?: number }} [options]
 * @returns {object} the runtime
 */
export function createZendureLocalMqtt({ mqttLibrary = mqtt, clientId, connectTimeout } = {}) {
  // deviceKey (lowercased) -> serial number, so legacy iot/ topics (addressed
  // by deviceKey) land in the per-serial cache. Filled by getDeviceKey: raw
  // cloud devices carry both identifiers.
  const serialByDeviceKey = new Map();

  return createBaseMqttRuntime({
    mqttLibrary,
    clientId,
    connectTimeout,
    // Serial numbers are case-sensitive identifiers carried verbatim in the
    // topic and in the cloud `snNumber` field: no normalization.
    normalizeKey: (key) => String(key),
    getDeviceKey(rawCloudDevice) {
      const serial = rawCloudDevice.snNumber;
      if (!serial || typeof serial !== 'string' || serial.trim() === '') {
        return null;
      }
      // Remember the deviceKey -> serial translation used by the legacy JSON
      // topics.
      const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
      if (deviceKey) {
        serialByDeviceKey.set(String(deviceKey).toLowerCase(), serial);
      }
      return serial;
    },
    topicsForDevice(rawCloudDevice) {
      const topics = [`${LOCAL_SENSOR_TOPIC_PREFIX}/${rawCloudDevice.snNumber}/#`];
      // Also listen to the legacy JSON topics on the local broker: some
      // firmwares only publish that format locally.
      const { productKey } = rawCloudDevice;
      const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
      if (productKey && deviceKey) {
        topics.push(`iot/${productKey}/${deviceKey}/#`, `/${productKey}/${deviceKey}/#`);
      }
      return topics;
    },
    parseMessage(topic, payload) {
      const parsedTopic = parseLocalSensorTopic(topic);
      if (parsedTopic) {
        // Native flat format, one metric per message: build a flat partial
        // `{ [metric]: value }` that merges into the per-serial payload.
        return {
          key: parsedTopic.serial,
          partialPayload: { [parsedTopic.metric]: parseLocalScalar(payload) },
        };
      }

      // Legacy JSON format (iot/{productKey}/{deviceKey}/... topics). Unlike
      // the cloud runtime (strict report allow-list), the local path stays
      // permissive about telemetry topics — some firmwares publish root-level
      // metrics outside properties/report — but command channels (read/write
      // bundles, ours or another client's) must never feed the cache nor
      // refresh the freshness.
      if (isRequestTopic(topic)) {
        return null;
      }
      const deviceKey = extractDeviceKeyFromTopic(topic);
      if (!deviceKey) {
        return null;
      }
      const serial = serialByDeviceKey.get(String(deviceKey).toLowerCase());
      if (!serial) {
        // Not one of the tracked devices: ignore.
        return null;
      }

      let decodedPayload;
      try {
        decodedPayload = JSON.parse(payload.toString());
      } catch {
        logger.debug(`Zendure local MQTT message ignored (invalid JSON) topic=${topic}.`);
        return null;
      }
      // Messages tagged isHA are the ones third-party clients (like us) send:
      // skip our own echoes.
      if (!decodedPayload || typeof decodedPayload !== 'object' || decodedPayload.isHA) {
        return null;
      }

      // Merge ONLY the report content into the flat per-serial cache: the
      // `properties` object when present, otherwise the top-level numeric
      // fields (some legacy messages carry metrics at the root).
      const properties =
        decodedPayload.properties && typeof decodedPayload.properties === 'object'
          ? decodedPayload.properties
          : Object.fromEntries(
              Object.entries(decodedPayload).filter(([, value]) => Number.isFinite(value)),
            );
      if (Object.keys(properties).length === 0) {
        return null;
      }
      return { key: serial, partialPayload: { ...properties } };
    },
  });
}
