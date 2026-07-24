import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createZendureMqtt,
  createZendureLocalMqtt,
  normalizeMqttUrl,
  extractDeviceKeyFromTopic,
  parseLocalSensorTopic,
  parseLocalScalar,
  mergeMqttPayload,
  buildLocalBrokerConfig,
  isReportTopic,
  isRequestTopic,
} from '../../src/zendure/mqtt.js';
import { extractMetricValue } from '../../src/zendure/deviceMapping.js';

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

// --- Local broker config -----------------------------------------------------

test('buildLocalBrokerConfig builds a broker URL from a raw cloud device', () => {
  const config = buildLocalBrokerConfig({
    server: '192.168.1.50',
    ip: '192.168.1.50',
    port: 1883,
    protocol: 'mqtt',
    username: 'local-user',
    password: 'local-pass',
    enable: 1,
  });
  assert.deepEqual(config, {
    url: 'mqtt://192.168.1.50:1883',
    username: 'local-user',
    password: 'local-pass',
  });
});

test('buildLocalBrokerConfig defaults the scheme/port from the broker host', () => {
  const config = buildLocalBrokerConfig({ server: 'broker.local', protocol: 'weird' });
  assert.equal(config.url, 'mqtt://broker.local');
});

test('buildLocalBrokerConfig ignores the device ip (never a broker host)', () => {
  // `ip` is the device address (local HTTP/zenSDK), not an MQTT broker: a
  // device that advertises only `ip` has no usable local broker.
  assert.equal(buildLocalBrokerConfig({ ip: '10.0.0.5', protocol: 'mqtt' }), null);
});

test('buildLocalBrokerConfig honours a secure protocol and port', () => {
  const config = buildLocalBrokerConfig({ server: 'device.local', port: 8883, protocol: 'mqtts' });
  assert.equal(config.url, 'mqtts://device.local:8883');
});

test('buildLocalBrokerConfig returns null without a usable host', () => {
  assert.equal(buildLocalBrokerConfig({ port: 1883 }), null);
  assert.equal(buildLocalBrokerConfig({}), null);
  assert.equal(buildLocalBrokerConfig(undefined), null);
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

test('isReportTopic only accepts properties/report topics', () => {
  assert.equal(isReportTopic('iot/prodA/DevKey1/properties/report'), true);
  assert.equal(isReportTopic('/prodA/DevKey1/properties/report'), true);
  assert.equal(isReportTopic('iot/prodA/DevKey1/properties/read'), false);
  assert.equal(isReportTopic('iot/prodA/DevKey1/properties/write'), false);
  assert.equal(isReportTopic('iot/prodA/DevKey1/time-sync'), false);
  assert.equal(isReportTopic(undefined), false);
});

test('isRequestTopic flags the command channels', () => {
  assert.equal(isRequestTopic('iot/prodA/DevKey1/properties/read'), true);
  assert.equal(isRequestTopic('iot/prodA/DevKey1/properties/write'), true);
  assert.equal(isRequestTopic('iot/prodA/DevKey1/function/invoke'), true);
  assert.equal(isRequestTopic('iot/prodA/DevKey1/properties/report'), false);
  assert.equal(isRequestTopic('iot/prodA/DevKey1/state'), false);
  assert.equal(isRequestTopic(undefined), false);
});

test('the echo of our own properties/read request neither feeds the cache nor refreshes freshness', async () => {
  const { runtime, client } = await createConnectedRuntime();
  runtime.subscribeDevice(DEVICE);

  // A real report arrives first.
  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 47 } })),
  );
  const freshnessAfterReport = runtime.getLastPayloadAt('DevKey1');

  // We ask for fresh properties; the broker delivers our own publication back
  // to us (wildcard subscription includes the read topic).
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.requestDeviceProperties(DEVICE), true);
  const readRequest = client.published.find((entry) => entry.topic.endsWith('properties/read'));
  client.emit('message', readRequest.topic, Buffer.from(readRequest.payload));

  // The cache is untouched (no junk keys, no `properties: ['getAll']` spread)
  // and the freshness timestamp did NOT move: a dead device must not look
  // alive just because we keep asking it for data.
  assert.deepEqual(runtime.getLatestPayload('DevKey1'), { properties: { electricLevel: 47 } });
  assert.equal(runtime.getLastPayloadAt('DevKey1'), freshnessAfterReport);
});

test('non-report cloud topics (time-sync, register...) are ignored', async () => {
  const { runtime, client } = await createConnectedRuntime();

  client.emit(
    'message',
    'iot/prodA/DevKey1/time-sync',
    Buffer.from(JSON.stringify({ timestamp: 1234567890 })),
  );
  client.emit(
    'message',
    'iot/prodA/DevKey1/register/replay',
    Buffer.from(JSON.stringify({ deviceId: 'DevKey1' })),
  );

  assert.equal(runtime.getLatestPayload('DevKey1'), null);
  assert.equal(runtime.getLastPayloadAt('DevKey1'), null);
});

test('mergeMqttPayload ignores a non-object properties field (read-request array)', () => {
  const merged = mergeMqttPayload(
    { properties: { electricLevel: 47 } },
    { properties: ['getAll'], messageId: 3 },
  );
  assert.deepEqual(merged.properties, { electricLevel: 47 });
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

test('reconnections increment connectCount in getStats (watchdog reconnect delta)', async () => {
  const { runtime, client } = await createConnectedRuntime();
  assert.equal(runtime.getStats().connectCount, 1);

  // A take-over cycle: the broker closes the session, mqtt.js reconnects.
  client.emit('close');
  client.emit('connect');
  client.emit('close');
  client.emit('connect');

  assert.equal(runtime.getStats().connectCount, 3);
  assert.equal(runtime.getStats().connected, true);
});

test('getStats reports honest connection, subscription and message counters', async () => {
  const { runtime, client } = await createConnectedRuntime();
  runtime.subscribeDevice(DEVICE);
  client.emit(
    'message',
    'iot/prodA/DevKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 12 } })),
  );
  client.emit('message', 'iot/prodA/DevKey1/properties/report', Buffer.from('not-json'));

  const stats = runtime.getStats();
  assert.equal(stats.connected, true);
  assert.equal(stats.subscribedTopics, 2);
  assert.equal(stats.trackedDevices, 1);
  // Every incoming message is counted, even the ignored ones...
  assert.equal(stats.messagesReceived, 2);
  // ...but only valid reports produce a cached payload.
  assert.equal(stats.keysWithPayload, 1);
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

// --- Local runtime: native flat topic scheme ---------------------------------

const LOCAL_DEVICE = { snNumber: 'SN-LOCAL-1', productModel: 'SolarFlow 800 Pro' };

async function createConnectedLocalRuntime() {
  const library = createFakeMqttLibrary();
  const runtime = createZendureLocalMqtt({ mqttLibrary: library, clientId: 'local-test-client' });
  const connectPromise = runtime.connect({
    url: 'mqtt://192.168.1.50:1883',
    username: 'local-user',
    password: 'local-pass',
  });
  const client = library.clients[0];
  client.emit('connect');
  await connectPromise;
  return { library, runtime, client };
}

test('parseLocalSensorTopic reads the serial and metric, ignores non-sensor topics', () => {
  assert.deepEqual(parseLocalSensorTopic('Zendure/sensor/SN-1/electricLevel'), {
    serial: 'SN-1',
    metric: 'electricLevel',
  });
  assert.equal(parseLocalSensorTopic('Zendure/number/SN-1/socSet'), null);
  assert.equal(parseLocalSensorTopic('Zendure/sensor/SN-1'), null);
  assert.equal(parseLocalSensorTopic(undefined), null);
});

test('parseLocalScalar keeps finite numbers as numbers and everything else as strings', () => {
  assert.equal(parseLocalScalar(Buffer.from('78')), 78);
  assert.equal(parseLocalScalar(Buffer.from('159')), 159);
  assert.equal(parseLocalScalar(Buffer.from('discharging')), 'discharging');
  assert.equal(parseLocalScalar(Buffer.from('  42 ')), 42);
  assert.equal(parseLocalScalar(Buffer.from('')), '');
});

test('local subscribeDevice subscribes the flat sensor wildcard by serial', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();

  runtime.subscribeDevice(LOCAL_DEVICE);
  runtime.subscribeDevice(LOCAL_DEVICE);
  // A device without a serial number is skipped.
  runtime.subscribeDevice({ productModel: 'SolarFlow 800 Pro' });

  assert.deepEqual(client.subscriptions, ['Zendure/sensor/SN-LOCAL-1/#']);
});

test('local runtime accumulates a flat payload per serial from plain scalars', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  runtime.subscribeDevice(LOCAL_DEVICE);

  client.emit('message', 'Zendure/sensor/SN-LOCAL-1/electricLevel', Buffer.from('73'));
  client.emit('message', 'Zendure/sensor/SN-LOCAL-1/packInputPower', Buffer.from('159'));
  // A string metric is stored but is non-numeric, so buildStates ignores it.
  client.emit('message', 'Zendure/sensor/SN-LOCAL-1/packState', Buffer.from('discharging'));

  const payload = runtime.getLatestPayload('SN-LOCAL-1');
  assert.deepEqual(payload, {
    electricLevel: 73,
    packInputPower: 159,
    packState: 'discharging',
  });
  assert.equal(typeof runtime.getLastPayloadAt('SN-LOCAL-1'), 'number');

  // The flat payload is directly consumable by the metric extractor: numeric
  // metrics resolve, the string metric is skipped.
  assert.equal(extractMetricValue(payload, ['electricLevel']), 73);
  assert.equal(extractMetricValue(payload, ['packState']), null);
});

test('local runtime notifies listeners with the serial as key', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  const seen = [];
  runtime.onPayload((key, payload, topic) => seen.push({ key, payload, topic }));

  client.emit('message', 'Zendure/sensor/SN-LOCAL-1/electricLevel', Buffer.from('55'));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'SN-LOCAL-1');
  assert.equal(seen[0].payload.electricLevel, 55);
  assert.equal(seen[0].topic, 'Zendure/sensor/SN-LOCAL-1/electricLevel');
});

// --- Local runtime: legacy JSON topics on the local broker --------------------
// Some firmwares (e.g. SolarFlow 800 Pro) publish the legacy JSON format
// (iot/{productKey}/{deviceKey}/...) on the LOCAL broker instead of the native
// flat topics: the local runtime must consume both, keyed by SERIAL.

const LOCAL_DEVICE_WITH_KEYS = {
  snNumber: 'SN-LOCAL-1',
  deviceKey: 'LocKey1',
  productKey: 'prodA',
  productModel: 'SolarFlow 800 Pro',
};

test('local subscribeDevice also subscribes the legacy iot topics when keys exist', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();

  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);
  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);

  assert.deepEqual(client.subscriptions, [
    'Zendure/sensor/SN-LOCAL-1/#',
    'iot/prodA/LocKey1/#',
    '/prodA/LocKey1/#',
  ]);
});

test('local runtime consumes legacy iot JSON reports keyed by SERIAL and merges with flat topics', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);

  // Flat native topic first...
  client.emit('message', 'Zendure/sensor/SN-LOCAL-1/packInputPower', Buffer.from('120'));
  // ...then a legacy JSON report on the same broker: its `properties` merge
  // into the SAME flat per-serial payload.
  client.emit(
    'message',
    'iot/prodA/LocKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 66, solarInputPower: 250 } })),
  );

  const payload = runtime.getLatestPayload('SN-LOCAL-1');
  assert.deepEqual(payload, { packInputPower: 120, electricLevel: 66, solarInputPower: 250 });

  const seen = [];
  runtime.onPayload((key) => seen.push(key));
  client.emit(
    'message',
    '/prodA/LocKey1/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 67 } })),
  );
  // Listeners are notified with the SERIAL as key, never the deviceKey.
  assert.deepEqual(seen, ['SN-LOCAL-1']);
  assert.equal(runtime.getLatestPayload('SN-LOCAL-1').electricLevel, 67);
});

test('local runtime ignores legacy non-report topics (properties/write and friends)', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);

  // A write bundle published on the shared broker (by us in a future control
  // phase, or by another client without the isHA tag) must neither feed the
  // telemetry cache nor refresh the freshness.
  client.emit(
    'message',
    'iot/prodA/LocKey1/properties/write',
    Buffer.from(JSON.stringify({ properties: { outputLimit: 800 } })),
  );
  client.emit(
    'message',
    'iot/prodA/LocKey1/properties/read',
    Buffer.from(JSON.stringify({ properties: ['getAll'] })),
  );

  assert.equal(runtime.getLatestPayload('SN-LOCAL-1'), null);
  assert.equal(runtime.getLastPayloadAt('SN-LOCAL-1'), null);
});

test('local runtime falls back to top-level numeric fields when properties is absent', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);

  client.emit(
    'message',
    'iot/prodA/LocKey1/state',
    Buffer.from(JSON.stringify({ electricLevel: 44, packState: 'discharging' })),
  );

  // Only the numeric root fields are merged; strings are ignored in this mode.
  assert.deepEqual(runtime.getLatestPayload('SN-LOCAL-1'), { electricLevel: 44 });
});

test('local runtime ignores iot echoes, invalid JSON and unknown device keys', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  runtime.subscribeDevice(LOCAL_DEVICE_WITH_KEYS);

  // Our own isHA echo.
  client.emit(
    'message',
    'iot/prodA/LocKey1/properties/read',
    Buffer.from(JSON.stringify({ isHA: true, properties: ['getAll'] })),
  );
  // Invalid JSON.
  client.emit('message', 'iot/prodA/LocKey1/properties/report', Buffer.from('not-json'));
  // A deviceKey that maps to no tracked serial.
  client.emit(
    'message',
    'iot/prodA/Unknown9/properties/report',
    Buffer.from(JSON.stringify({ properties: { electricLevel: 99 } })),
  );

  assert.equal(runtime.getLatestPayload('SN-LOCAL-1'), null);
});

test('local requestDeviceProperties is a no-op returning false', async () => {
  const { runtime, client } = await createConnectedLocalRuntime();
  assert.equal(runtime.requestDeviceProperties(LOCAL_DEVICE), false);
  assert.equal(client.published.length, 0);
});

test('local runtime generates a unique client id (never reuses a cloud id)', async () => {
  const { client } = await createConnectedLocalRuntime();
  assert.equal(client.options.clientId, 'local-test-client');

  // With no explicit clientId, a generated unique id is used.
  const library = createFakeMqttLibrary();
  const runtime = createZendureLocalMqtt({ mqttLibrary: library });
  const connectPromise = runtime.connect({ url: 'mqtt://192.168.1.50:1883' });
  library.clients[0].emit('connect');
  await connectPromise;
  assert.match(library.clients[0].options.clientId, /^gladys-zendure-[a-z0-9]+$/);
});
