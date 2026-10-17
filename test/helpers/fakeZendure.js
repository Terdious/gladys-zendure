// -----------------------------------------------------------------------------
// Test doubles for the Zendure side: cloud API (fetch) and MQTT broker
// (mqtt.js library), so the device layer can be exercised without network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnergyMeters } from '../../src/zendure/energy.js';

export const FAKE_API_URL = 'https://app.zendure.example';
export const FAKE_APP_KEY = 'appKey123';
export const FAKE_CLOUD_KEY = Buffer.from(`${FAKE_API_URL}.${FAKE_APP_KEY}`).toString('base64');

export const FAKE_SOLARFLOW_DEVICE = {
  deviceKey: 'AbC123',
  productKey: 'prodX',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Garage battery',
  online: true,
  electricLevel: 47,
  packInputPower: 150,
  outputPackPower: 0,
  outputHomePower: 320,
  solarInputPower: 470,
};

// A second supported device, to check selector uniqueness across devices.
export const FAKE_SECOND_SOLARFLOW_DEVICE = {
  deviceKey: 'XyZ789',
  productKey: 'prodX',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Balcony battery',
  electricLevel: 62,
  packInputPower: 0,
  outputPackPower: 210,
  outputHomePower: 180,
  solarInputPower: 90,
};

// A supported device the cloud reports offline (online: false), to check the
// 'unreachable' transport badge.
export const FAKE_OFFLINE_SOLARFLOW_DEVICE = {
  deviceKey: 'OfF456',
  productKey: 'prodX',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Cellar battery',
  online: false,
  electricLevel: 12,
};

// A newly-supported model (SolarFlow 2400 AC), to check discovery of the
// extended catalog. Its productModel lowercases/trims to 'solarflow 2400 ac'.
export const FAKE_SOLARFLOW_2400_DEVICE = {
  deviceKey: 'Sf2400A',
  productKey: 'prodZ',
  productModel: 'SolarFlow 2400 AC',
  deviceName: 'Attic battery',
  electricLevel: 55,
  packInputPower: 1200,
  outputPackPower: 0,
  outputHomePower: 900,
  solarInputPower: 1400,
};

// A supported device that also advertises its LOCAL MQTT broker (native local
// MQTT). Local telemetry is keyed by the device serial number (`snNumber`).
export const FAKE_LOCAL_SOLARFLOW_DEVICE = {
  deviceKey: 'LoC456',
  snNumber: 'SN-LOCAL-1',
  productKey: 'prodX',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Local battery',
  electricLevel: 55,
  packInputPower: 100,
  outputPackPower: 0,
  outputHomePower: 200,
  solarInputPower: 300,
  // Local MQTT broker parameters exposed by the cloud deviceList.
  ip: '192.168.1.50',
  server: '192.168.1.50',
  port: 1883,
  protocol: 'mqtt',
  username: 'local-user',
  password: 'local-pass',
  // The cloud `enable` flag is unreliable and intentionally left false here to
  // prove reachability no longer depends on it.
  enable: false,
};

// A SolarFlow 800 served by its zenSDK local HTTP API (no local MQTT broker):
// the cloud deviceList gives its LAN `ip` and serial number.
export const FAKE_HTTP_SOLARFLOW_DEVICE = {
  deviceKey: 'HtTp800',
  snNumber: 'SN-HTTP-800',
  productKey: 'prodW',
  productModel: 'SolarFlow 800',
  deviceName: 'Shed inverter',
  online: true,
  ip: '192.168.1.80',
  electricLevel: 30,
  packInputPower: 0,
  outputPackPower: 0,
  outputHomePower: 100,
  solarInputPower: 150,
};

// What its local API answers: the cloud report shape, complete.
export const FAKE_HTTP_REPORT = {
  properties: {
    electricLevel: 64,
    packInputPower: 250,
    outputPackPower: 0,
    outputHomePower: 480,
    solarInputPower: 230,
    outputLimit: 600,
    inputLimit: 800,
    acMode: 2,
    socSet: 1000,
    minSoc: 100,
    packNum: 1,
    remainOutTime: 135,
    remainInputTime: 59940,
  },
  packData: [{ sn: 'C0A1', socLevel: 64 }],
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

/**
 * Energy meters writing to a fresh temporary directory, never to /data.
 * @returns {{ meters: ReturnType<typeof createEnergyMeters>, dataDir: string }}
 */
export function createTestEnergyMeters() {
  const dataDir = mkdtempSync(join(tmpdir(), 'gladys-zendure-energy-'));
  return { meters: createEnergyMeters({ dataDir }), dataDir };
}

/**
 * Fake `fetch` for the zenSDK local HTTP API of the devices. Nothing ever
 * leaves the process: a host without a report (or marked failing) rejects
 * like an unreachable device, a "hanging" host never answers until the
 * request's abort signal fires (timeout path).
 * @param {{ reports?: Record<string, object> }} [options] host -> report body
 */
export function createFakeZenSdkFetch({ reports = {} } = {}) {
  const bodies = new Map(Object.entries(reports));
  const failing = new Set();
  const hanging = new Set();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const { host, pathname } = new URL(url);
    calls.push({
      url,
      host,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    if (hanging.has(host)) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason));
      });
    }
    if (failing.has(host) || !bodies.has(host)) {
      throw new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
    }
    const text = pathname === '/properties/report' ? JSON.stringify(bodies.get(host)) : '';
    return { status: 200, ok: true, text: async () => text, json: async () => JSON.parse(text) };
  };
  fetchImpl.calls = calls;
  fetchImpl.setReport = (host, body) => bodies.set(host, body);
  fetchImpl.fail = (host) => failing.add(host);
  fetchImpl.recover = (host) => failing.delete(host);
  fetchImpl.hang = (host) => hanging.add(host);
  return fetchImpl;
}
