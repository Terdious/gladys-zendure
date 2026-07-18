// -----------------------------------------------------------------------------
// Test doubles for the Zendure side: cloud API (fetch) and MQTT broker
// (mqtt.js library), so the device layer can be exercised without network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const FAKE_API_URL = 'https://app.zendure.example';
export const FAKE_APP_KEY = 'appKey123';
export const FAKE_CLOUD_KEY = Buffer.from(`${FAKE_API_URL}.${FAKE_APP_KEY}`).toString('base64');

export const FAKE_SOLARFLOW_DEVICE = {
  deviceKey: 'AbC123',
  productKey: 'prodX',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Garage battery',
  electricLevel: 47,
  packInputPower: 150,
  outputPackPower: 0,
  outputHomePower: 320,
  solarInputPower: 470,
};

export const FAKE_UNSUPPORTED_DEVICE = {
  deviceKey: 'ZzZ999',
  productKey: 'prodY',
  productModel: 'Some Future Model',
  deviceName: 'Unknown thing',
};

/**
 * Fake `fetch` for the Zendure cloud deviceList endpoint.
 * @param {{ deviceList?: Array<object> }} [options]
 */
export function createFakeZendureFetch({
  deviceList = [FAKE_SOLARFLOW_DEVICE, FAKE_UNSUPPORTED_DEVICE],
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      async json() {
        return {
          success: true,
          code: 200,
          data: {
            deviceList,
            mqtt: {
              url: 'broker.zendure.example:1883',
              username: 'mqtt-user',
              password: 'mqtt-pass',
            },
          },
        };
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

class FakeMqttClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.subscriptions = [];
    this.published = [];
    this.ended = false;
  }

  subscribe(topic, callback) {
    this.subscriptions.push(topic);
    callback?.(null);
  }

  publish(topic, payload, callback) {
    this.published.push({ topic, payload });
    callback?.(null);
  }

  end() {
    this.ended = true;
  }
}

/**
 * Fake mqtt.js library. Created clients are collected in `clients`; tests
 * drive them by emitting 'connect' and 'message' events.
 */
export function createFakeMqttLibrary() {
  const library = {
    clients: [],
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      library.clients.push(client);
      // Auto-accept the connection on the next tick, like a healthy broker.
      process.nextTick(() => client.emit('connect'));
      return client;
    },
  };
  return library;
}
