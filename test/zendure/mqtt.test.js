import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createZendureMqtt,
  normalizeMqttUrl,
  extractDeviceKeyFromTopic,
  mergeMqttPayload,
} from '../../src/zendure/mqtt.js';

// --- Fake mqtt.js library ----------------------------------------------------

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

function createFakeMqttLibrary() {
  const library = {
    clients: [],
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      library.clients.push(client);
      return client;
    },
  };
  return library;
}

const MQTT_CONFIG = { url: 'broker.zendure.example:1883', username: 'user', password: 'pass' };
const DEVICE = { deviceKey: 'DevKey1', productKey: 'prodA', productModel: 'SolarFlow 800 Pro' };

async function createConnectedRuntime() {
  const library = createFakeMqttLibrary();
  const runtime = createZendureMqtt({ mqttLibrary: library, clientId: 'test-client' });
  const connectPromise = runtime.connect(MQTT_CONFIG);
  const client = library.clients[0];
  client.emit('connect');
  await connectPromise;
  return { library, runtime, client };
}

// --- Pure helpers ------------------------------------------------------------

test('normalizeMqttUrl adds the mqtt:// scheme when missing', () => {
  assert.equal(normalizeMqttUrl('broker:1883'), 'mqtt://broker:1883');
  assert.equal(normalizeMqttUrl('mqtts://broker:8883'), 'mqtts://broker:8883');
  assert.equal(normalizeMqttUrl('wss://broker/ws'), 'wss://broker/ws');
  assert.equal(normalizeMqttUrl(''), null);
  assert.equal(normalizeMqttUrl(undefined), null);
});

test('extractDeviceKeyFromTopic reads both Zendure topic shapes', () => {
  assert.equal(extractDeviceKeyFromTopic('iot/prodA/devB/properties/report'), 'devB');
  assert.equal(extractDeviceKeyFromTopic('/prodA/devB/properties/report'), 'devB');
  assert.equal(extractDeviceKeyFromTopic('other/prodA/devB/x'), null);
  assert.equal(extractDeviceKeyFromTopic('iot/short'), null);
  assert.equal(extractDeviceKeyFromTopic(undefined), null);
});

test('mergeMqttPayload merges top-level fields and nested properties', () => {
  const merged = mergeMqttPayload(
    { properties: { electricLevel: 50, packNum: 1 }, timestamp: 1 },
    { properties: { electricLevel: 60 }, timestamp: 2 },
  );
  assert.deepEqual(merged, { properties: { electricLevel: 60, packNum: 1 }, timestamp: 2 });
});

// --- Runtime: connection -----------------------------------------------------

test('connect opens the broker connection with normalized URL and credentials', async () => {
  const { library, runtime, client } = await createConnectedRuntime();

  assert.equal(library.clients.length, 1);
  assert.equal(client.url, 'mqtt://broker.zendure.example:1883');
  assert.equal(client.options.username, 'user');
  assert.equal(client.options.password, 'pass');
  assert.equal(client.options.clientId, 'test-client');
  assert.equal(runtime.connected, true);
});

test('connect is a no-op when called again with the same broker and credentials', async () => {
  const { library, runtime } = await createConnectedRuntime();
  await runtime.connect(MQTT_CONFIG);
  assert.equal(library.clients.length, 1);
});

test('connect replaces the client when the broker or credentials change', async () => {
  const { library, runtime, client } = await createConnectedRuntime();

  const secondConnect = runtime.connect({ ...MQTT_CONFIG, password: 'other' });
  library.clients[1].emit('connect');
  await secondConnect;

  assert.equal(client.ended, true);
  assert.equal(library.clients.length, 2);
  assert.equal(runtime.connected, true);
});

test('connect resolves without throwing when the broker errors out', async () => {
  const library = createFakeMqttLibrary();
  const runtime = createZendureMqtt({ mqttLibrary: library, connectTimeout: 50 });
  const connectPromise = runtime.connect(MQTT_CONFIG);
  library.clients[0].emit('error', new Error('boom'));
  await connectPromise;
  assert.equal(runtime.connected, false);
});

test('connect ignores a missing MQTT configuration', async () => {
  const library = createFakeMqttLibrary();
  const runtime = createZendureMqtt({ mqttLibrary: library });
  await runtime.connect(undefined);
  await runtime.connect({});
  assert.equal(library.clients.length, 0);
});

// --- Runtime: subscriptions --------------------------------------------------

test('subscribeDevice subscribes both Zendure topic shapes once', async () => {
  const { runtime, client } = await createConnectedRuntime();

  runtime.subscribeDevice(DEVICE);
  runtime.subscribeDevice(DEVICE);

  assert.deepEqual(client.subscriptions, ['iot/prodA/DevKey1/#', '/prodA/DevKey1/#']);
});

test('devices subscribed before connection are subscribed on connect', async () => {
  const library = createFakeMqttLibrary();
  const runtime = createZendureMqtt({ mqttLibrary: library });

  runtime.subscribeDevice(DEVICE); // not connected yet: only tracked

  const connectPromise = runtime.connect(MQTT_CONFIG);
  const client = library.clients[0];
  client.emit('connect');
  await connectPromise;

  assert.deepEqual(client.subscriptions, ['iot/prodA/DevKey1/#', '/prodA/DevKey1/#']);
});

test('subscriptions are restored after a broker reconnection', async () => {
  const { runtime, client } = await createConnectedRuntime();
  runtime.subscribeDevice(DEVICE);

  client.emit('close'); // clean session: subscriptions lost
  client.emit('connect'); // mqtt.js reconnects

  assert.deepEqual(client.subscriptions, [
    'iot/prodA/DevKey1/#',
    '/prodA/DevKey1/#',
    'iot/prodA/DevKey1/#',
    '/prodA/DevKey1/#',
  ]);
});

// --- Runtime: properties/read request ----------------------------------------

test('requestDeviceProperties publishes a getAll read request', async () => {
  const { runtime, client } = await createConnectedRuntime();

  const sent = runtime.requestDeviceProperties(DEVICE);

  assert.equal(sent, true);
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0].topic, 'iot/prodA/DevKey1/properties/read');
  const payload = JSON.parse(client.published[0].payload);
  assert.equal(payload.deviceId, 'DevKey1');
  assert.deepEqual(payload.properties, ['getAll']);
  assert.equal(typeof payload.messageId, 'number');
  assert.equal(typeof payload.timestamp, 'number');
});

test('requestDeviceProperties returns false when not connected', () => {
  const runtime = createZendureMqtt({ mqttLibrary: createFakeMqttLibrary() });
  assert.equal(runtime.requestDeviceProperties(DEVICE), false);
});

// --- Runtime: payload cache + listeners ---------------------------------------

test('incoming reports are cached per device key (case-insensitive) and merged', async () => {
  const { runtime, client } = await createConnectedRuntime();

  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 55, packNum: 2 } })),
  );
  client.emit(
    'message',
    '/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { packInputPower: 120 } })),
  );

  const payload = runtime.getLatestPayload('devkey1');
  assert.deepEqual(payload.properties, { electricLevel: 55, packNum: 2, packInputPower: 120 });
  assert.equal(typeof runtime.getLastPayloadAt('DevKey1'), 'number');
});

test('payload listeners are notified with the merged payload', async () => {
  const { runtime, client } = await createConnectedRuntime();
  const seen = [];
  const unsubscribe = runtime.onPayload((deviceKey, payload, topic) => {
    seen.push({ deviceKey, payload, topic });
  });

  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 42 } })),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].deviceKey, 'devkey1');
  assert.equal(seen[0].payload.properties.electricLevel, 42);
  assert.equal(seen[0].topic, 'iot/prodA/DevKey1/properties/report');

  unsubscribe();
  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 43 } })),
  );
  assert.equal(seen.length, 1);
});

test('own isHA echoes and invalid JSON payloads are ignored', async () => {
  const { runtime, client } = await createConnectedRuntime();

  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/read',
    Buffer.from(JSON.stringify({ isHA: true, properties: ['getAll'] })),
  );
  client.emit('message', 'iot/prodA/DevKey1/properties/report', Buffer.from('not-json'));

  assert.equal(runtime.getLatestPayload('DevKey1'), null);
});

test('disconnect ends the client and clears the cache', async () => {
  const { runtime, client } = await createConnectedRuntime();
  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 42 } })),
  );

  runtime.disconnect();

  assert.equal(client.ended, true);
  assert.equal(runtime.connected, false);
  assert.equal(runtime.getLatestPayload('DevKey1'), null);
});
