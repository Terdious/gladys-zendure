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
  CLOUD_HOLD_TIME_IN_MS,
  UNREACHABLE_TIMEOUT_IN_MS,
  REACHABILITY_TRIGGER,
  controlDevice,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
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
  createFakeZenSdkFetch,
} from './helpers/fakeZendure.js';

const BASELINE_FEATURE_KEYS = [
  'batteryLevel',
  'batteryInputPower',
  'batteryOutputPower',
  'homeOutputPower',
  'solarInputPower',
  'batteryChargeEnergy',
  'batteryDischargeEnergy',
  'homeOutputEnergy',
  'solarEnergy',
  'batteryEnergyRemaining',
];
const EXTRA_FEATURE_KEYS = [
  'offGridPower',
  'offGridEnergy',
  'gridInputPower',
  'gridInputEnergy',
  'deviceTemperature',
  'batteryMaxTemperature',
  'remainingDischargeTime',
  'remainingChargeTime',
];

const CLOUD_BROKER_URL = 'mqtt://broker.zendure.example:1883';
const LOCAL_BROKER_URL = 'mqtt://192.168.1.50:1883';

const gladys = createFakeGladys();
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, poll_frequency: 30 });

beforeEach(() => {
  resetSolarflowRuntime();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch(),
    mqttLibrary: createFakeMqttLibrary(),
    energyMeters: createTestEnergyMeters().meters,
    // Never the network: every local HTTP API is unreachable unless a test
    // injects its own fake.
    localFetchImpl: createFakeZenSdkFetch(),
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
  // The ten features of the earlier releases first, in their order (their
  // external ids never change), then the off-grid, grid charging and
  // temperature ones an "Update" adds to an existing device.
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    [...BASELINE_FEATURE_KEYS, ...EXTRA_FEATURE_KEYS],
  );
  // The device carries an explicit, globally-unique selector, and every
  // feature selector is composed with it.
  assert.equal(device.selector, 'zendure-solarflow-abc123');
  for (const feature of device.features) {
    assert.equal(feature.read_only, true);
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
  assert.equal(sf2400.features.length, 18);
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

test('off-grid, grid charging and temperatures are published and integrated per model', async (t) => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  // A SolarFlow 800 (no off-grid port), spelled without spaces.
  const sf800 = {
    deviceKey: 'Sf800X',
    productKey: 'prodY',
    productModel: 'SolarFlow800',
    deviceName: 'Shed battery',
  };
  setSolarflowDependencies({
    mqttLibrary,
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_SOLARFLOW_DEVICE, sf800] }),
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });

  const devices = await buildDiscoveredDevices(localGladys, config);
  const pro = devices.find((d) => d.external_id.endsWith(FAKE_SOLARFLOW_DEVICE.deviceKey));
  const plain = devices.find((d) => d.external_id.endsWith(sf800.deviceKey));
  assert.ok(plain, 'the spacing variant is discovered');
  assert.ok(!plain.features.some((f) => f.external_id.endsWith(':offGridPower')));
  assert.ok(plain.features.some((f) => f.external_id.endsWith(':gridInputEnergy')));
  const temperature = pro.features.find((f) => f.external_id.endsWith(':deviceTemperature'));
  assert.equal(temperature.category, 'device-temperature-sensor');
  assert.equal(temperature.type, 'decimal');
  assert.equal(temperature.unit, 'celsius');
  assert.equal(temperature.selector, 'zendure-solarflow-abc123-device-temperature');

  const stopPush = solarflow.startPush(localGladys, config);
  const client = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);
  const report = (device, properties, extra = {}) =>
    client.emit(
      'message',
      `iot/${device.productKey}/${device.deviceKey}/properties/report`,
      Buffer.from(JSON.stringify({ properties, ...extra })),
    );

  report(
    FAKE_SOLARFLOW_DEVICE,
    { gridOffPower: 300, gridInputPower: 900, hyperTmp: 3051 },
    {
      packData: [
        { sn: 'C0A1', maxTemp: 2981 },
        { sn: 'C0A2', maxTemp: 3011 },
      ],
    },
  );
  report(sf800, { gridOffPower: 500, gridInputPower: 600, packNum: 0, remainOutTime: 30 });
  report(FAKE_SOLARFLOW_DEVICE, { remainOutTime: 95, remainInputTime: 59940 });
  t.mock.timers.tick(60 * 1000);
  report(FAKE_SOLARFLOW_DEVICE, { gridOffPower: -100 });
  report(sf800, { gridInputPower: 0 });
  await flushStatesNow(localGladys);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${pro.external_id}:offGridPower`], 0, 'negative: clamped');
  assert.equal(byId[`${pro.external_id}:offGridEnergy`], 0.005); // 300 W x 1 min
  assert.equal(byId[`${pro.external_id}:gridInputPower`], 900);
  assert.equal(byId[`${pro.external_id}:gridInputEnergy`], 0.015); // 900 W x 1 min
  assert.equal(byId[`${pro.external_id}:deviceTemperature`], 32);
  assert.equal(byId[`${pro.external_id}:batteryMaxTemperature`], 28);
  assert.equal(byId[`${plain.external_id}:gridInputEnergy`], 0.01);
  // No feature, no state: the off-grid power of a model without the port is ignored.
  assert.equal(`${plain.external_id}:offGridPower` in byId, false);
  assert.equal(`${plain.external_id}:offGridEnergy` in byId, false);
  assert.equal(`${plain.external_id}:deviceTemperature` in byId, false, 'not reported');
  // Remaining time: minutes as reported, the "no estimate" sentinel and a hub
  // without any pack publish nothing.
  assert.equal(byId[`${pro.external_id}:remainingDischargeTime`], 95);
  assert.equal(`${pro.external_id}:remainingChargeTime` in byId, false, 'sentinel');
  assert.equal(`${plain.external_id}:remainingDischargeTime` in byId, false, 'no pack');
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

test('a locally-silent device falls back to the cloud (lazy connect) then recovers', async (t) => {
  // Only the clock is mocked (timers stay real), to cross the hold time.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
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

  // The cloud broker is held CLOUD_HOLD_TIME_IN_MS after the last device
  // needed it, then released after two consecutive all-local evaluations
  // (one consumer per account: another instance may need it).
  await evaluateTelemetrySources(localGladys, localConfig);
  await evaluateTelemetrySources(localGladys, localConfig);
  assert.equal(cloudClient.ended, false);
  t.mock.timers.tick(fallbackNow + 1000 + CLOUD_HOLD_TIME_IN_MS - Date.now());
  localClient.emit(
    'message',
    LOCAL_SENSOR_TOPIC(FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber, 'electricLevel'),
    Buffer.from('62'),
  );
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
