// -----------------------------------------------------------------------------
// Zendure cloud MQTT runtime.
//
// Ported from the Zendure service of Gladys core (zendure.mqtt.js), reshaped
// for the integration SDK: a self-contained transport runtime with no Gladys
// state manager access. Telemetry interpretation (metric extraction) is the
// job of the device layer — this module only:
//   - connects to the cloud MQTT broker described by the deviceList response;
//   - subscribes to the per-device topics (iot/{productKey}/{deviceKey}/# and
//     /{productKey}/{deviceKey}/#);
//   - sends `properties/read` requests to ask for fresh telemetry;
//   - caches the latest merged payload per deviceKey (reports are partial);
//   - notifies listeners on every payload update (real-time push).
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

  const baseProperties =
    base.properties && typeof base.properties === 'object' ? base.properties : {};
  const incomingProperties =
    incoming.properties && typeof incoming.properties === 'object' ? incoming.properties : {};
  if (Object.keys(baseProperties).length > 0 || Object.keys(incomingProperties).length > 0) {
    merged.properties = { ...baseProperties, ...incomingProperties };
  }

  return merged;
}

/**
 * Create the Zendure MQTT runtime.
 * @param {{ mqttLibrary?: typeof mqtt, clientId?: string, connectTimeout?: number }} [options]
 * `mqttLibrary` is injectable for tests (must expose `connect(url, options)`).
 * @returns {object} the runtime
 */
export function createZendureMqtt({ mqttLibrary = mqtt, clientId, connectTimeout } = {}) {
  const mqttClientId = clientId || `gladys-zendure-${Math.floor(Math.random() * 1000000)}`;
  const connectTimeoutInMs = connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_IN_MS;

  let client = null;
  let connected = false;
  let connectionSignature = null;
  let messageId = 0;

  const subscribedTopics = new Set();
  const trackedDevices = new Map(); // normalized deviceKey -> raw cloud device
  const latestPayloadByDeviceKey = new Map();
  const lastPayloadAtByDeviceKey = new Map();
  const payloadListeners = new Set();

  function subscribeDevice(rawCloudDevice) {
    if (!rawCloudDevice) {
      return;
    }
    const { productKey } = rawCloudDevice;
    const deviceKey = rawCloudDevice.deviceKey || rawCloudDevice.id;
    if (!productKey || !deviceKey) {
      return;
    }

    // Remember the device so subscriptions survive broker reconnections.
    trackedDevices.set(String(deviceKey).toLowerCase(), rawCloudDevice);

    if (!client || !connected) {
      return;
    }

    [`iot/${productKey}/${deviceKey}/#`, `/${productKey}/${deviceKey}/#`].forEach((topic) => {
      if (subscribedTopics.has(topic)) {
        return;
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
        logger.info(`Zendure MQTT subscribed to ${topic}.`);
      });
    });
  }

  function refreshSubscriptions() {
    trackedDevices.forEach((rawCloudDevice) => subscribeDevice(rawCloudDevice));
  }

  function handleMessage(topic, payload) {
    const deviceKey = extractDeviceKeyFromTopic(topic);
    if (!deviceKey) {
      return;
    }

    let decodedPayload;
    try {
      decodedPayload = JSON.parse(payload.toString());
    } catch {
      logger.debug(`Zendure MQTT message ignored (invalid JSON) topic=${topic}.`);
      return;
    }

    // Messages tagged isHA are the ones third-party clients (like us) send:
    // skip our own echoes.
    if (!decodedPayload || decodedPayload.isHA) {
      return;
    }

    const normalizedDeviceKey = String(deviceKey).toLowerCase();
    const previousPayload = latestPayloadByDeviceKey.get(normalizedDeviceKey);
    const mergedPayload = mergeMqttPayload(previousPayload, decodedPayload);
    latestPayloadByDeviceKey.set(normalizedDeviceKey, mergedPayload);
    lastPayloadAtByDeviceKey.set(normalizedDeviceKey, Date.now());

    for (const listener of payloadListeners) {
      try {
        listener(normalizedDeviceKey, mergedPayload, topic);
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

  return {
    get connected() {
      return connected;
    },

    /**
     * Connect to the cloud MQTT broker described by the deviceList response
     * (`data.mqtt`: url + credentials). Reconnections are handled by mqtt.js;
     * an initial failure is logged, not thrown — the client keeps retrying in
     * the background. Calling connect() again with the same broker/credentials
     * is a no-op.
     * @param {{ url?: string, username?: string, password?: string }} mqttConfiguration
     * @returns {Promise<void>} resolves once connected (or after the timeout)
     */
    async connect(mqttConfiguration) {
      if (!mqttConfiguration || typeof mqttConfiguration !== 'object') {
        logger.warn('Zendure MQTT configuration is missing in the cloud response.');
        return;
      }

      const mqttUrl = normalizeMqttUrl(mqttConfiguration.url);
      if (!mqttUrl) {
        logger.warn('Zendure MQTT URL is missing in the cloud response.');
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

      // Some brokers enforce ACLs tied to the client id: prefer the one the
      // cloud provides in its MQTT metadata, when present.
      const effectiveClientId = mqttConfiguration.clientId || mqttClientId;
      logger.info(
        `Zendure MQTT connecting to ${mqttUrl} ` +
          `(metadata fields: ${Object.keys(mqttConfiguration).join(', ')}; ` +
          `clientId source: ${mqttConfiguration.clientId ? 'cloud' : 'generated'})`,
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
        logger.info('Zendure MQTT connected.');
        refreshSubscriptions();
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
     * Ask the device for fresh properties through `properties/read`.
     * @param {object} rawCloudDevice device from the cloud deviceList
     * @returns {boolean} true when the request was published
     */
    requestDeviceProperties(rawCloudDevice) {
      if (!client || !connected || !rawCloudDevice) {
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
    },

    /**
     * Latest merged payload for one device, or null.
     * @param {string} deviceKey Zendure device key
     */
    getLatestPayload(deviceKey) {
      if (!deviceKey) {
        return null;
      }
      return latestPayloadByDeviceKey.get(String(deviceKey).toLowerCase()) || null;
    },

    /**
     * Timestamp (ms) of the last payload received for one device, or null.
     * @param {string} deviceKey Zendure device key
     */
    getLastPayloadAt(deviceKey) {
      if (!deviceKey) {
        return null;
      }
      return lastPayloadAtByDeviceKey.get(String(deviceKey).toLowerCase()) || null;
    },

    /**
     * Register a listener called on every payload update:
     * `(deviceKey, mergedPayload, topic) => void`.
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
      latestPayloadByDeviceKey.clear();
      lastPayloadAtByDeviceKey.clear();
      payloadListeners.clear();
    },
  };
}
