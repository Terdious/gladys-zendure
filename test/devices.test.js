import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
  syncDiscoveredDevices,
  resetTelemetryDedup,
} from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  flushStatesNow,
  markPublishedStatesStale,
  buildTelemetrySummary,
  evaluateTelemetrySources,
  TELEMETRY_WATCHDOG_INTERVAL_IN_MS,
  LOCAL_SILENCE_TIMEOUT_IN_MS,
  UNREACHABLE_TIMEOUT_IN_MS,
  REACHABILITY_TRIGGER,
  controlDevice,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeGladys as createSdkFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_DEVICE,
  FAKE_SECOND_SOLARFLOW_DEVICE,
  FAKE_OFFLINE_SOLARFLOW_DEVICE,
  FAKE_SOLARFLOW_2400_DEVICE,
  FAKE_LOCAL_SOLARFLOW_DEVICE,
  createTestEnergyMeters,
} from './helpers/fakeZendure.js';

const CLOUD_BROKER_URL = 'mqtt://broker.zendure.example:1883';
const LOCAL_BROKER_URL = 'mqtt://192.168.1.50:1883';

const COMMAND_KEYS = ['outputLimit', 'inputLimit', 'socSet', 'minSoc', 'acMode'];

const gladys = createFakeGladys();
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, poll_frequency: 30 });

beforeEach(() => {
  resetSolarflowRuntime();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch(),
    mqttLibrary: createFakeMqttLibrary(),
    energyMeters: createTestEnergyMeters().meters,
  });
});

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.ok(
      typeof bp.buildDevice === 'function' || typeof bp.buildDevices === 'function',
      'buildDevice or buildDevices must be a function',
    );
    assert.ok(
      typeof bp.deviceExternalId === 'function' || typeof bp.ownsDevice === 'function',
      'deviceExternalId or ownsDevice must be a function',
    );
  }
});

test('buildDiscoveredDevices returns one payload per supported Zendure device', async () => {
  const devices = await buildDiscoveredDevices(gladys, config);

  // The fake account has one SolarFlow 800 Pro and one unsupported model.
  assert.equal(devices.length, 1);
  const [device] = devices;
  assert.equal(device.name, 'Garage battery');
  assert.equal(device.external_id, `solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`);
  // The core only polls devices flagged should_poll, at one of its fixed
  // frequencies: 30 s from the config, snapped to milliseconds.
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 30000);
  // Ten measurements, then five writable settings.
  assert.equal(device.features.length, 15);
  // The device carries an explicit, globally-unique selector, and every
  // feature selector is composed with it.
  assert.equal(device.selector, 'zendure-solarflow-abc123');
  for (const feature of device.features) {
    assert.equal(feature.read_only, !COMMAND_KEYS.includes(feature.external_id.split(':').pop()));
    assert.equal(feature.has_feedback, !feature.read_only);
    assert.ok(feature.external_id.startsWith(device.external_id));
    assert.ok(feature.selector.startsWith(device.selector), 'feature selector is device-scoped');
  }
  assert.equal(device.features[0].selector, 'zendure-solarflow-abc123-battery-level');
});

test('feature names follow the feature_names option, selectors and ids do not', async () => {
  const [english] = await buildDiscoveredDevices(gladys, config);
  resetSolarflowRuntime();
  const [french] = await buildDiscoveredDevices(gladys, { ...config, feature_names: 'fr' });

  assert.equal(english.features[0].name, 'Battery level');
  assert.equal(french.features[0].name, 'Niveau de batterie');
  assert.deepEqual(
    french.features.map((f) => [f.external_id, f.selector]),
    english.features.map((f) => [f.external_id, f.selector]),
  );
});

test('discovers a newly-supported model (SolarFlow 2400) with the baseline features', async () => {
  const localGladys = createFakeGladys();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [FAKE_SOLARFLOW_DEVICE, FAKE_SOLARFLOW_2400_DEVICE],
    }),
    mqttLibrary: createFakeMqttLibrary(),
  });

  const devices = await buildDiscoveredDevices(localGladys, config);
  assert.equal(devices.length, 2);

  const sf2400 = devices.find(
    (device) => device.external_id === `solarflow:${FAKE_SOLARFLOW_2400_DEVICE.deviceKey}`,
  );
  assert.ok(sf2400, 'the SolarFlow 2400 device is discovered');
  assert.equal(sf2400.name, 'Attic battery');
  assert.equal(sf2400.features.length, 15);
  assert.equal(sf2400.selector, 'zendure-solarflow-sf2400a');
  assert.equal(sf2400.features[0].selector, 'zendure-solarflow-sf2400a-battery-level');

  // Its cloud telemetry is published on poll like any other model.
  await solarflow.onPoll(localGladys, config, sf2400);
  await flushStatesNow(localGladys);
  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${sf2400.external_id}:batteryLevel`], 55);
  assert.equal(byId[`${sf2400.external_id}:solarInputPower`], 1400);
});

test('device external_ids are unique across the catalog', async () => {
  const devices = await buildDiscoveredDevices(gladys, config);
  const ids = devices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
});

test('selectors are globally unique across several discovered devices', async () => {
  const localGladys = createFakeGladys();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [FAKE_SOLARFLOW_DEVICE, FAKE_SECOND_SOLARFLOW_DEVICE],
    }),
    mqttLibrary: createFakeMqttLibrary(),
  });

  const devices = await buildDiscoveredDevices(localGladys, config);
  assert.equal(devices.length, 2);

  // Collect every selector (devices + features): Gladys enforces global
  // uniqueness, so a clash here is exactly the 409 seen in the UI.
  const selectors = [];
  for (const device of devices) {
    selectors.push(device.selector);
    for (const feature of device.features) {
      selectors.push(feature.selector);
    }
  }
  assert.equal(new Set(selectors).size, selectors.length, 'all selectors must be unique');
  // The same feature on two devices yields distinct selectors.
  assert.notEqual(devices[0].features[0].selector, devices[1].features[0].selector);
});

test('syncDiscoveredDevices publishes the devices, a true status and cloud transports', async () => {
  const localGladys = createFakeGladys();

  const synced = await syncDiscoveredDevices(localGladys, config);

  assert.equal(synced, true);
  assert.equal(localGladys.discovered.length, 1);
  assert.equal(localGladys.discovered[0].length, 1);
  // A successful deviceList fetch reports connected: true (no message).
  assert.deepEqual(localGladys.connectionStatuses, [{ connected: true, message: undefined }]);
  // One publishTransports call, transport 'cloud' for the online device.
  assert.deepEqual(localGladys.transports, [
    [{ external_id: `solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`, transport: 'cloud' }],
  ]);
});

test('syncDiscoveredDevices flags a device with online === false as unreachable', async () => {
  const localGladys = createFakeGladys();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [
        FAKE_SOLARFLOW_DEVICE, // online: true
        FAKE_OFFLINE_SOLARFLOW_DEVICE, // online: false
        FAKE_SECOND_SOLARFLOW_DEVICE, // no online flag -> cloud by default
      ],
    }),
    mqttLibrary: createFakeMqttLibrary(),
  });

  await syncDiscoveredDevices(localGladys, config);

  assert.deepEqual(localGladys.transports.at(-1), [
    { external_id: `solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`, transport: 'cloud' },
    {
      external_id: `solarflow:${FAKE_OFFLINE_SOLARFLOW_DEVICE.deviceKey}`,
      transport: 'unreachable',
    },
    { external_id: `solarflow:${FAKE_SECOND_SOLARFLOW_DEVICE.deviceKey}`, transport: 'cloud' },
  ]);
});

test('syncDiscoveredDevices reports the local transport for a locally-served device', async () => {
  const localGladys = createFakeGladys();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [FAKE_SOLARFLOW_DEVICE, FAKE_LOCAL_SOLARFLOW_DEVICE],
    }),
    mqttLibrary: createFakeMqttLibrary(),
  });

  const localMqttConfig = normalizeConfig({
    cloud_key: FAKE_CLOUD_KEY,
    poll_frequency: 30,
    enable_local_mqtt: true,
  });
  await syncDiscoveredDevices(localGladys, localMqttConfig);

  assert.deepEqual(localGladys.transports.at(-1), [
    // No local broker advertised -> stays on the cloud transport.
    { external_id: `solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`, transport: 'cloud' },
    // Local broker advertised + option enabled -> local transport badge.
    { external_id: `solarflow:${FAKE_LOCAL_SOLARFLOW_DEVICE.deviceKey}`, transport: 'local' },
  ]);
});

test('syncDiscoveredDevices reports a false status when the cloud key is missing', async () => {
  const localGladys = createFakeGladys();

  const synced = await syncDiscoveredDevices(localGladys, normalizeConfig({}));

  assert.equal(synced, false);
  // Nothing published: no devices, no transports.
  assert.equal(localGladys.discovered.length, 0);
  assert.equal(localGladys.transports.length, 0);
  assert.equal(localGladys.connectionStatuses.length, 1);
  const [status] = localGladys.connectionStatuses;
  assert.equal(status.connected, false);
  assert.ok(status.message.en.includes('not configured'));
  assert.ok(status.message.fr, 'the message must also be provided in French');
});

test('syncDiscoveredDevices reports a false status when the Zendure cloud fails', async () => {
  const localGladys = createFakeGladys();
  setSolarflowDependencies({
    fetchImpl: async () => ({
      status: 500,
      async json() {
        return {};
      },
    }),
    mqttLibrary: createFakeMqttLibrary(),
  });

  await assert.rejects(() => syncDiscoveredDevices(localGladys, config), /HTTP 500/);

  assert.equal(localGladys.discovered.length, 0);
  const status = localGladys.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.ok(status.message.en.includes('unreachable'));
});

test('syncDiscoveredDevices survives a core without the new SDK endpoints', async () => {
  // Older Gladys cores return 404 on /connection_status and /device/transport:
  // the sync must still publish the devices and report success.
  const localGladys = createFakeGladys();
  localGladys.setConnectionStatus = async () => {
    throw new Error('404 Not Found');
  };
  localGladys.publishTransports = async () => {
    throw new Error('404 Not Found');
  };

  const synced = await syncDiscoveredDevices(localGladys, config);

  assert.equal(synced, true);
  assert.equal(localGladys.discovered.length, 1);
});

test('findBlueprintByDevice routes a solarflow device back to its blueprint', async () => {
  const [device] = await buildDiscoveredDevices(gladys, config);
  assert.equal(findBlueprintByDevice(gladys, device), solarflow);
});

test('findBlueprintByDevice returns undefined for an unknown device', () => {
  const found = findBlueprintByDevice(gladys, { external_id: 'does-not-exist' });
  assert.equal(found, undefined);
});

test('onPoll publishes telemetry from the cloud entry before any MQTT report', async () => {
  const localGladys = createFakeGladys();
  const [device] = await buildDiscoveredDevices(localGladys, config);

  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 47);
  assert.equal(byId[`${device.external_id}:batteryInputPower`], 150);
  assert.equal(byId[`${device.external_id}:batteryOutputPower`], 0);
  assert.equal(byId[`${device.external_id}:homeOutputPower`], 320);
  assert.equal(byId[`${device.external_id}:solarInputPower`], 470);
});

// --- Local MQTT source selection (issue #6) ----------------------------------

const localConfig = normalizeConfig({
  cloud_key: FAKE_CLOUD_KEY,
  poll_frequency: 30,
  enable_local_mqtt: true,
});

const LOCAL_SENSOR_TOPIC = (serial, metric) => `Zendure/sensor/${serial}/${metric}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    const value = condition();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timed out');
    }
    await delay(5);
  }
}

test('onPoll uses the local broker when local MQTT is enabled and reachable', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  // The fake device carries `enable: false`; reachability no longer depends on
  // that flag, only on the option + a `server` broker host.
  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  await solarflow.onPoll(localGladys, localConfig, device);
  await flushStatesNow(localGladys);

  // Exactly one broker connection was opened: the device's LOCAL broker.
  assert.equal(mqttLibrary.clients.length, 1);
  assert.equal(mqttLibrary.clients[0].url, LOCAL_BROKER_URL);
  assert.equal(mqttLibrary.clients[0].options.username, 'local-user');
  assert.equal(mqttLibrary.clients[0].options.password, 'local-pass');

  // Telemetry is still published (from the cloud entry until the first report).
  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 55);
});

test('the local broker URL is built from `server`, never from `ip`', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  // `ip` is a different, decoy address: it must never be used as a broker host.
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [{ ...FAKE_LOCAL_SOLARFLOW_DEVICE, ip: '10.9.9.9', server: '10.5.0.50' }],
    }),
    mqttLibrary,
  });

  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  await solarflow.onPoll(localGladys, localConfig, device);
  await flushStatesNow(localGladys);

  assert.equal(mqttLibrary.clients.length, 1);
  assert.equal(mqttLibrary.clients[0].url, 'mqtt://10.5.0.50:1883');
});

test('onPoll prefers a fresher local MQTT report (keyed by serial) over the cloud entry', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  await solarflow.onPoll(localGladys, localConfig, device);
  await flushStatesNow(localGladys);

  // Native local format: one plain scalar per topic, keyed by serial number.
  const localClient = mqttLibrary.clients[0];
  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('73'),
  );

  localGladys.published.length = 0;
  await solarflow.onPoll(localGladys, localConfig, device);
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 73);
});

test('a fresh local MQTT report is pushed in real time (keyed by serial)', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  // Populate the cloud data, then start the real-time push listeners.
  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  const stopPush = solarflow.startPush(localGladys, localConfig);

  // startPush connects and attaches its listener asynchronously.
  const localClient = await waitFor(() => mqttLibrary.clients[0]);
  assert.equal(localClient.url, LOCAL_BROKER_URL);
  await delay(20);

  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('66'),
  );

  const byId = await waitFor(() => {
    const map = Object.fromEntries(
      localGladys.published.map((s) => [s.featureExternalId, s.state]),
    );
    return map[`${device.external_id}:batteryLevel`] !== undefined ? map : null;
    // The paced publish channel ticks every 3.5 s: give it headroom.
  }, 6000);
  assert.equal(byId[`${device.external_id}:batteryLevel`], 66);

  stopPush();
});

test('onPoll falls back to the cloud broker when local MQTT is disabled', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  // Default config: enable_local_mqtt is false.
  const [device] = await buildDiscoveredDevices(localGladys, config);
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);

  assert.equal(mqttLibrary.clients.length, 1);
  assert.equal(mqttLibrary.clients[0].url, CLOUD_BROKER_URL);
});

test('onPoll falls back to the cloud broker when the device exposes no local params', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  // A device with the local flag on but no broker host/params.
  const deviceWithoutLocalParams = {
    deviceKey: 'NoLoc1',
    productKey: 'prodX',
    productModel: 'SolarFlow 800 Pro',
    deviceName: 'No-local battery',
    electricLevel: 40,
    enable: true,
  };
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [deviceWithoutLocalParams] }),
    mqttLibrary,
  });

  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  await solarflow.onPoll(localGladys, localConfig, device);
  await flushStatesNow(localGladys);

  assert.equal(mqttLibrary.clients.length, 1);
  assert.equal(mqttLibrary.clients[0].url, CLOUD_BROKER_URL);
});

test('onPoll prefers the cached MQTT payload over the cloud entry', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });

  const [device] = await buildDiscoveredDevices(localGladys, config);

  // First poll connects MQTT and subscribes the device.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  const client = mqttLibrary.clients[0];

  // A fresher report arrives on MQTT...
  client.emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 81 } })),
  );

  localGladys.published.length = 0;
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 81);
});

test('pushed reports feed the energy indexes and the energy remaining', async (t) => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });

  const [device] = await buildDiscoveredDevices(localGladys, config);
  const stopPush = solarflow.startPush(localGladys, config);
  const client = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);
  const topic = `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`;
  const report = (properties, extra = {}) =>
    client.emit('message', topic, Buffer.from(JSON.stringify({ properties, ...extra })));

  report(
    { electricLevel: 50, outputPackPower: 1200, solarInputPower: 600, packInputPower: 0 },
    { packData: [{ sn: 'C0A1' }, { sn: 'C0A2' }] }, // 2 x AB2000 = 3.84 kWh
  );
  t.mock.timers.tick(60 * 1000);
  report({ electricLevel: 51 });
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryChargeEnergy`], 0.02); // 1200 W x 1 min
  assert.equal(byId[`${device.external_id}:solarEnergy`], 0.01);
  assert.equal(byId[`${device.external_id}:batteryDischargeEnergy`], 0);
  assert.equal(byId[`${device.external_id}:batteryEnergyRemaining`], 1.96); // 51 % of 3.84
  stopPush();
});

test('onPoll does not republish the cached payload while the source broker is disconnected', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });

  const [device] = await buildDiscoveredDevices(localGladys, config);

  // First poll connects MQTT; a report fills the cache and is published.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  const client = mqttLibrary.clients[0];
  client.emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 81 } })),
  );

  // The broker connection drops (internet cut): the cache is now blind.
  client.emit('close');

  localGladys.published.length = 0;
  markPublishedStatesStale(); // the 30-min keep-alive would republish...
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);

  // ...but nothing is sent while the broker is down: stale data must not be
  // presented as fresh during an outage.
  assert.equal(localGladys.published.length, 0);
});

test('onPoll merges a partial local payload over the cloud snapshot', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  const localMqttConfig = normalizeConfig({
    cloud_key: FAKE_CLOUD_KEY,
    poll_frequency: 30,
    enable_local_mqtt: true,
  });
  const [device] = await buildDiscoveredDevices(localGladys, localMqttConfig);
  await solarflow.onPoll(localGladys, localMqttConfig, device);
  const localClient = mqttLibrary.clients.find((c) => c.url.includes('192.168.1.50'));

  // Only ONE metric arrives on the local broker: the local cache is partial.
  localClient.emit(
    'message',
    `Zendure/sensor/${FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber}/packInputPower`,
    Buffer.from('123'),
  );

  localGladys.published.length = 0;
  await solarflow.onPoll(localGladys, localMqttConfig, device);
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  // The fresh local metric wins...
  assert.equal(byId[`${device.external_id}:batteryInputPower`], 123);
  // ...and the metrics missing from the local cache fall back to the cloud
  // snapshot instead of disappearing ("no recent value" in the UI).
  assert.equal(
    byId[`${device.external_id}:batteryLevel`],
    FAKE_LOCAL_SOLARFLOW_DEVICE.electricLevel,
  );
  assert.equal(
    byId[`${device.external_id}:solarInputPower`],
    FAKE_LOCAL_SOLARFLOW_DEVICE.solarInputPower,
  );
});

test('unchanged values are re-published once the keep-alive interval elapses', async () => {
  const localGladys = createFakeGladys();
  const [device] = await buildDiscoveredDevices(localGladys, config);

  // First poll publishes everything.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  const firstCount = localGladys.published.length;
  assert.ok(firstCount > 0);

  // Second poll with identical values: deduplicated, nothing re-sent.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  assert.equal(localGladys.published.length, firstCount);

  // Once the keep-alive interval has elapsed, identical values are re-sent so
  // the core never flags a live feature as stale.
  markPublishedStatesStale();
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  assert.equal(localGladys.published.length, firstCount * 2);
});

test('resetTelemetryDedup forces an immediate full re-send of unchanged values', async () => {
  const localGladys = createFakeGladys();
  const [device] = await buildDiscoveredDevices(localGladys, config);

  // First poll publishes everything.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  const firstCount = localGladys.published.length;
  assert.ok(firstCount > 0);

  // Identical values are deduplicated on the next poll.
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  assert.equal(localGladys.published.length, firstCount);

  // A configuration change resets the dedup memory (via the registry hook):
  // the next poll re-sends EVERY value immediately, without waiting for the
  // 30-min keep-alive.
  resetTelemetryDedup();
  await solarflow.onPoll(localGladys, config, device);
  await flushStatesNow(localGladys);
  assert.equal(localGladys.published.length, firstCount * 2);
});

// --- Per-device dynamic source selection (local -> cloud fallback) -----------

test('the evaluator keeps a fresh local device on local and never connects the cloud', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  await buildDiscoveredDevices(localGladys, localConfig);
  const stopPush = solarflow.startPush(localGladys, localConfig);
  const localClient = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);

  // A fresh local payload arrives: the device is healthy on its local broker.
  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('70'),
  );
  await evaluateTelemetrySources(localGladys, localConfig);
  await evaluateTelemetrySources(localGladys, localConfig);

  // The device stays on 'local': no badge churn, and above all the CLOUD
  // broker was never connected (one consumer per Zendure account: the cloud
  // connection must stay down while every device is healthy locally).
  assert.equal(mqttLibrary.clients.length, 1);
  assert.equal(mqttLibrary.clients[0].url, LOCAL_BROKER_URL);
  assert.equal(localGladys.transports.length, 0);

  stopPush();
});

test('a locally-silent device falls back to the cloud (lazy connect) then recovers', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  const stopPush = solarflow.startPush(localGladys, localConfig);
  const localClient = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);

  // The device reports on its local broker, then goes silent.
  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('60'),
  );
  const start = Date.now();
  await evaluateTelemetrySources(localGladys, localConfig, start);
  // While the local payload is fresh, the cloud runtime is NOT created.
  assert.equal(mqttLibrary.clients.length, 1);

  // Rewind: past the local-silence timeout the evaluator lazily connects the
  // cloud broker and transitions the device to 'cloud' (startup grace).
  const fallbackNow = start + LOCAL_SILENCE_TIMEOUT_IN_MS + 5000;
  await evaluateTelemetrySources(localGladys, localConfig, fallbackNow);

  assert.equal(mqttLibrary.clients.length, 2);
  const cloudClient = mqttLibrary.clients[1];
  assert.equal(cloudClient.url, CLOUD_BROKER_URL);
  // A locally-reachable device on the cloud fallback is DEGRADED (SDK 0.9):
  // the badge stays "cloud" but carries the orange dot + a readable reason.
  assert.deepEqual(localGladys.transports.at(-1), [
    {
      external_id: device.external_id,
      transport: 'cloud',
      degraded: true,
      message: {
        en: 'Local telemetry is silent — running on the Zendure cloud fallback.',
        fr: 'Télémétrie locale muette — repli sur le cloud Zendure.',
        de: 'Die lokale Telemetrie schweigt — Betrieb über den Rückfall auf die Zendure-Cloud.',
        es: 'La telemetría local está en silencio — funcionando con el respaldo de la nube de Zendure.',
      },
    },
  ]);

  // The lazily-attached cloud listener publishes the cloud reports now that
  // the device's effective source is 'cloud'.
  localGladys.published.length = 0;
  cloudClient.emit(
    'message',
    `iot/${FAKE_LOCAL_SOLARFLOW_DEVICE.productKey}/${FAKE_LOCAL_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 42 } })),
  );
  await flushStatesNow(localGladys);
  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 42);

  // A second evaluation keeps 'cloud' without re-publishing the badge.
  const transportCallsAfterFallback = localGladys.transports.length;
  await evaluateTelemetrySources(localGladys, localConfig, fallbackNow + 1000);
  assert.equal(localGladys.transports.length, transportCallsAfterFallback);

  // A new local message IS proof of local health: the listener transitions
  // the device back to 'local' and publishes the 'local' badge.
  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('61'),
  );
  await waitFor(() => localGladys.transports.length > transportCallsAfterFallback);
  assert.deepEqual(localGladys.transports.at(-1), [
    { external_id: device.external_id, transport: 'local' },
  ]);

  // After two consecutive all-local evaluations the cloud broker is released
  // (one consumer per account: another instance may need it).
  await evaluateTelemetrySources(localGladys, localConfig);
  await evaluateTelemetrySources(localGladys, localConfig);
  assert.equal(cloudClient.ended, true);

  stopPush();
});

test('a battery silent on every source fires the reachability trigger, and again on return', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE] }),
    mqttLibrary,
  });

  const [device] = await buildDiscoveredDevices(localGladys, localConfig);
  const stopPush = solarflow.startPush(localGladys, localConfig);
  const localClient = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);
  const reportLocally = (value) =>
    localClient.emit(
      'message',
      LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
      Buffer.from(String(value)),
    );

  reportLocally(60);
  const start = Date.now();
  await evaluateTelemetrySources(localGladys, localConfig, start);
  // Silent locally (cloud fallback), then on the cloud too: unreachable.
  await evaluateTelemetrySources(
    localGladys,
    localConfig,
    start + LOCAL_SILENCE_TIMEOUT_IN_MS + 5000,
  );
  assert.equal(localGladys.sceneEvents.length, 0, 'a cloud fallback is not an event');
  await evaluateTelemetrySources(
    localGladys,
    localConfig,
    start + LOCAL_SILENCE_TIMEOUT_IN_MS + UNREACHABLE_TIMEOUT_IN_MS + 10000,
  );
  await waitFor(() => localGladys.sceneEvents.length === 1);
  assert.deepEqual(localGladys.sceneEvents[0], {
    key: REACHABILITY_TRIGGER,
    data: {
      device: device.external_id,
      state: 'unreachable',
      device_name: FAKE_LOCAL_SOLARFLOW_DEVICE.deviceName,
      source: 'unreachable',
    },
  });

  reportLocally(61);
  await waitFor(() => localGladys.sceneEvents.length === 2);
  assert.equal(localGladys.sceneEvents[1].data.state, 'reachable');
  assert.equal(localGladys.sceneEvents[1].data.source, 'local');
  stopPush();
});

// --- Control (scene actions, widget buttons) ----------------------------------

test('controlDevice publishes a properties/write with smartMode on the serving broker', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });
  const [device] = await buildDiscoveredDevices(localGladys, config);
  await solarflow.onPoll(localGladys, config, device); // connects the cloud broker
  const client = mqttLibrary.clients[0];

  const result = await controlDevice(localGladys, config, device.external_id, {
    kind: 'output_limit',
    watts: 5000, // above the 800 W rating of a SolarFlow 800 Pro
  });

  assert.deepEqual(result, { sent: true, applied: { outputLimit: 800 }, source: 'cloud' });
  const write = client.published.find((p) => p.topic.endsWith('/properties/write'));
  assert.equal(
    write.topic,
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/write`,
  );
  const body = JSON.parse(write.payload);
  assert.deepEqual(body.properties, { smartMode: 1, outputLimit: 800 });
  assert.equal(body.deviceId, FAKE_SOLARFLOW_DEVICE.deviceKey);

  // A second change of the same setting within the write interval is refused.
  await assert.rejects(
    controlDevice(localGladys, config, device.external_id, { kind: 'output_limit', watts: 300 }),
    /retry in \d+ s/,
  );
});

test('controlDevice refuses an unknown battery and sends nothing when already applied', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });
  const [device] = await buildDiscoveredDevices(localGladys, config);
  await solarflow.onPoll(localGladys, config, device);
  const client = mqttLibrary.clients[0];

  await assert.rejects(
    controlDevice(localGladys, config, 'solarflow:nope', { kind: 'ac_mode', mode: 'charge' }),
    /unknown Zendure battery/,
  );
  client.emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { acMode: 2 } })),
  );
  const result = await controlDevice(localGladys, config, device.external_id, {
    kind: 'ac_mode',
    mode: 'discharge',
  });
  assert.deepEqual(result, { sent: false, applied: {} });
  assert.equal(client.published.filter((p) => p.topic.endsWith('/properties/write')).length, 0);
});

// --- Device card control (writable settings) ----------------------------------

/** A discovered SolarFlow 800 Pro on the cloud broker, with command helpers. */
async function setupBattery({ deviceList } = {}) {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    mqttLibrary,
    ...(deviceList ? { fetchImpl: createFakeZendureFetch({ deviceList }) } : {}),
  });
  const [device] = await buildDiscoveredDevices(localGladys, config);
  await solarflow.onPoll(localGladys, config, device); // connects the cloud broker
  const client = mqttLibrary.clients[0];
  const featureOf = (key) =>
    device.features.find((feature) => feature.external_id === `${device.external_id}:${key}`);
  return {
    gladys: localGladys,
    device,
    featureOf,
    report(properties) {
      client.emit(
        'message',
        `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
        Buffer.from(JSON.stringify({ properties })),
      );
    },
    setValue(key, value, feature = featureOf(key)) {
      return solarflow.onSetValue(localGladys, { device, feature, value, config });
    },
    writes() {
      return client.published
        .filter((p) => p.topic.endsWith('/properties/write'))
        .map((p) => JSON.parse(p.payload).properties);
    },
    async publishedOf(key) {
      await flushStatesNow(localGladys);
      return localGladys.published
        .filter((s) => s.featureExternalId === `${device.external_id}:${key}`)
        .map((s) => s.state);
    },
  };
}

test('discovery declares the battery settings as writable features with feedback', async () => {
  const { device, featureOf } = await setupBattery();

  const outputLimit = featureOf('outputLimit');
  assert.equal(outputLimit.category, 'home-output');
  assert.equal(outputLimit.type, 'power-limit');
  assert.equal(outputLimit.unit, 'watt');
  assert.deepEqual([outputLimit.min, outputLimit.max], [0, 800]);
  assert.equal(outputLimit.read_only, false);
  assert.equal(outputLimit.has_feedback, true);
  assert.equal(outputLimit.selector, 'zendure-solarflow-abc123-output-limit');
  assert.equal(outputLimit.name, 'Output power limit');

  const inputLimit = featureOf('inputLimit');
  assert.deepEqual(
    [inputLimit.category, inputLimit.type, inputLimit.min, inputLimit.max],
    ['battery-storage', 'grid-charge-power-limit', 0, 1000],
  );
  assert.deepEqual(
    [featureOf('socSet').type, featureOf('socSet').min, featureOf('socSet').max],
    ['target-charge-limit', 70, 100],
  );
  assert.deepEqual(
    [featureOf('minSoc').type, featureOf('minSoc').min, featureOf('minSoc').max],
    ['target-discharge-limit', 0, 50],
  );
  const mode = featureOf('acMode');
  assert.equal(mode.type, 'mode');
  assert.equal(mode.unit, null);
  assert.deepEqual(mode.supported_options, [
    { value: 1, label: 'Charge', sort_order: 0 },
    { value: 2, label: 'Discharge', sort_order: 1 },
  ]);
  // Only the mode carries options; the measurements stay read-only.
  assert.equal(device.features.filter((f) => f.supported_options).length, 1);
  assert.equal(featureOf('batteryLevel').read_only, true);
  assert.equal(featureOf('batteryLevel').has_feedback, false);
});

test('the power limit range is widened by the maximum the battery reports', async () => {
  const { featureOf } = await setupBattery({
    deviceList: [{ ...FAKE_SOLARFLOW_DEVICE, inverseMaxPower: 1200, chargeMaxLimit: 600 }],
  });
  assert.equal(featureOf('outputLimit').max, 1200);
  // A lower report never narrows the rating.
  assert.equal(featureOf('inputLimit').max, 1000);
});

test('mode labels follow the feature_names option', async () => {
  const [device] = await buildDiscoveredDevices(gladys, { ...config, feature_names: 'fr' });
  const mode = device.features.find((f) => f.type === 'mode');
  assert.equal(mode.name, 'Mode AC');
  assert.deepEqual(
    mode.supported_options.map((option) => option.label),
    ['Charge', 'Décharge'],
  );
});

test('the settings states come from the telemetry (SoC scale, mode)', async () => {
  const battery = await setupBattery();
  battery.report({ outputLimit: 600, inputLimit: 400, socSet: 1000, minSoc: 100, acMode: 2 });
  await solarflow.onPoll(battery.gladys, config, battery.device);

  assert.deepEqual(await battery.publishedOf('outputLimit'), [600]);
  assert.deepEqual(await battery.publishedOf('inputLimit'), [400]);
  // Tenths of a percent on this firmware: 1000 -> 100 %, 100 -> 10 %.
  assert.deepEqual(await battery.publishedOf('socSet'), [100]);
  assert.deepEqual(await battery.publishedOf('minSoc'), [10]);
  assert.deepEqual(await battery.publishedOf('acMode'), [2]);

  // Percent firmware, and an acMode outside the zenSDK contract.
  battery.report({ socSet: 90, minSoc: 20, acMode: 0 });
  await solarflow.onPoll(battery.gladys, config, battery.device);
  assert.deepEqual(await battery.publishedOf('socSet'), [100, 90]);
  assert.deepEqual(await battery.publishedOf('minSoc'), [10, 20]);
  assert.deepEqual(await battery.publishedOf('acMode'), [2]);
});

test('a SoC level is not published before the battery reports its scale', async () => {
  const battery = await setupBattery();
  battery.report({ minSoc: 100 });
  await solarflow.onPoll(battery.gladys, config, battery.device);
  assert.deepEqual(await battery.publishedOf('minSoc'), []);
});

test('onSetValue clamps the output limit, writes it in smart mode and reports it back', async () => {
  const battery = await setupBattery();
  await battery.setValue('outputLimit', 5000);
  assert.deepEqual(battery.writes(), [{ smartMode: 1, outputLimit: 800 }]);
  assert.deepEqual(await battery.publishedOf('outputLimit'), [800]);

  await battery.setValue('inputLimit', '350');
  assert.deepEqual(battery.writes().at(-1), { smartMode: 1, inputLimit: 350 });
  assert.deepEqual(await battery.publishedOf('inputLimit'), [350]);
});

test('onSetValue refuses a write within the throttle and re-publishes the real value', async () => {
  const battery = await setupBattery();
  battery.report({ outputLimit: 300 });
  await battery.setValue('outputLimit', 500);
  assert.deepEqual(await battery.publishedOf('outputLimit'), [500]);

  await assert.rejects(battery.setValue('outputLimit', 600), /retry in \d+ s/);
  assert.equal(battery.writes().length, 1);
  // The battery still reports 300: that is what the card shows again.
  assert.deepEqual(await battery.publishedOf('outputLimit'), [500, 300]);
});

test('onSetValue sends nothing for a value already applied, and re-publishes it', async () => {
  const battery = await setupBattery();
  battery.report({ outputLimit: 400 });
  await solarflow.onPoll(battery.gladys, config, battery.device);
  assert.deepEqual(await battery.publishedOf('outputLimit'), [400]);

  await battery.setValue('outputLimit', 403); // within the 5 W tolerance
  assert.deepEqual(battery.writes(), []);
  // Unchanged, but sent again: the card may show the value the user tried.
  assert.deepEqual(await battery.publishedOf('outputLimit'), [400, 400]);
});

test('onSetValue converts and clamps the SoC levels to the battery scale', async () => {
  const battery = await setupBattery();
  await assert.rejects(battery.setValue('socSet', 95), /not reported its SoC settings/);

  battery.report({ socSet: 1000, minSoc: 100 });
  await battery.setValue('socSet', 95);
  assert.deepEqual(battery.writes(), [{ socSet: 950 }]);
  assert.deepEqual(await battery.publishedOf('socSet'), [95]);

  // The SoC levels share one 30 s throttle (one `soc` setting).
  await assert.rejects(battery.setValue('minSoc', 80), /retry in \d+ s/);
  resetSolarflowRuntime();
  const other = await setupBattery();
  other.report({ socSet: 1000, minSoc: 100 });
  await other.setValue('minSoc', 80); // above the 50 % zenSDK maximum
  assert.deepEqual(other.writes(), [{ minSoc: 500 }]);
  assert.deepEqual(await other.publishedOf('minSoc'), [50]);
});

test('onSetValue maps the battery mode to acMode and refuses the modes Zendure lacks', async () => {
  const battery = await setupBattery();
  battery.report({ acMode: 2 });
  await battery.setValue('acMode', 1); // CHARGE
  assert.deepEqual(battery.writes(), [{ acMode: 1 }]);
  assert.deepEqual(await battery.publishedOf('acMode'), [1]);

  for (const mode of [0, 3, 4, 5, 'auto']) {
    await assert.rejects(battery.setValue('acMode', mode), /charge or discharge only/);
  }
  assert.equal(battery.writes().length, 1);
  // Each refusal re-publishes the reported mode (still 2 until the next report).
  assert.equal((await battery.publishedOf('acMode')).at(-1), 2);
});

test('onSetValue rejects a feature that is not a Zendure setting', async () => {
  const battery = await setupBattery();
  await assert.rejects(battery.setValue('batteryLevel', 50), /not a writable Zendure setting/);
  await assert.rejects(
    battery.setValue('outputLimit', 1, { external_id: `${battery.device.external_id}:toString` }),
    /not a writable Zendure setting/,
  );
  await assert.rejects(
    battery.setValue('outputLimit', 100, {
      external_id: 'solarflow:XyZ789:outputLimit',
    }),
    /not a writable Zendure setting/,
  );
  await assert.rejects(battery.setValue('outputLimit', 100, null), /not a writable/);
  assert.deepEqual(battery.writes(), []);
});

test('onSetValue fails cleanly on a battery missing from the account', async () => {
  const battery = await setupBattery();
  await assert.rejects(
    solarflow.onSetValue(battery.gladys, {
      device: { external_id: 'solarflow:nope' },
      feature: { external_id: 'solarflow:nope:outputLimit' },
      value: 100,
      config,
    }),
    /unknown Zendure battery/,
  );
});

test('a device created or updated in Gladys gets its unchanged values again', async () => {
  const battery = await setupBattery();
  battery.report({ outputLimit: 400 });
  await solarflow.onPoll(battery.gladys, config, battery.device);
  await solarflow.onPoll(battery.gladys, config, battery.device);
  assert.deepEqual(await battery.publishedOf('outputLimit'), [400]); // deduplicated

  solarflow.forgetPublishedDevice(battery.device);
  await solarflow.onPoll(battery.gladys, config, battery.device);
  assert.deepEqual(await battery.publishedOf('outputLimit'), [400, 400]);
});

test('the discovered devices pass the SDK fake Gladys validation', async () => {
  const sdkGladys = createSdkFakeGladys();
  const devices = await buildDiscoveredDevices(sdkGladys, config);
  const result = await sdkGladys.publishDiscoveredDevices(devices);
  assert.equal(result.count, 1);
});

// --- Telemetry watchdog summary (pure helper) ---------------------------------

test('buildTelemetrySummary lists silent devices with their labels', () => {
  const now = 1_000_000_000;
  const fresh = now - 60 * 1000;
  const stale = now - TELEMETRY_WATCHDOG_INTERVAL_IN_MS - 1;

  const summary = buildTelemetrySummary(
    [
      { label: 'Garage battery (AbC123, SN SN-1)', lastPayloadAt: fresh },
      { label: 'Balcony battery (XyZ789, SN SN-2)', lastPayloadAt: stale },
      { label: 'Cellar battery (OfF456, SN SN-3)', lastPayloadAt: null },
    ],
    now,
  );

  assert.equal(
    summary,
    '1/3 device(s) reported in the last 5 min; ' +
      'silent: Balcony battery (XyZ789, SN SN-2), Cellar battery (OfF456, SN SN-3)',
  );
});

test('buildTelemetrySummary reports the all-reporting case', () => {
  const now = Date.now();
  const summary = buildTelemetrySummary(
    [
      { label: 'A', lastPayloadAt: now - 1000 },
      { label: 'B', lastPayloadAt: now - 2000 },
    ],
    now,
  );
  assert.equal(summary, 'all 2 device(s) reporting');
});
