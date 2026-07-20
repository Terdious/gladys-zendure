import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
  syncDiscoveredDevices,
} from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  flushStatesNow,
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
} from './helpers/fakeZendure.js';

const CLOUD_BROKER_URL = 'mqtt://broker.zendure.example:1883';
const LOCAL_BROKER_URL = 'mqtt://192.168.1.50:1883';

const gladys = createFakeGladys();
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, poll_frequency: 30 });

beforeEach(() => {
  resetSolarflowRuntime();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch(),
    mqttLibrary: createFakeMqttLibrary(),
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
  assert.equal(device.features.length, 5);
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
  assert.equal(sf2400.features.length, 5);
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
  });
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
