import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

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
  // 30 s from the config, snapped to the Gladys poll frequency in milliseconds.
  assert.equal(device.poll_frequency, 30000);
  assert.equal(device.features.length, 5);
  for (const feature of device.features) {
    assert.equal(feature.read_only, true);
    assert.ok(feature.external_id.startsWith(device.external_id));
  }
});

test('device external_ids are unique across the catalog', async () => {
  const devices = await buildDiscoveredDevices(gladys, config);
  const ids = devices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
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

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 47);
  assert.equal(byId[`${device.external_id}:batteryInputPower`], 150);
  assert.equal(byId[`${device.external_id}:batteryOutputPower`], 0);
  assert.equal(byId[`${device.external_id}:homeOutputPower`], 320);
  assert.equal(byId[`${device.external_id}:solarInputPower`], 470);
});

test('onPoll prefers the cached MQTT payload over the cloud entry', async () => {
  const localGladys = createFakeGladys();
  const mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ mqttLibrary });

  const [device] = await buildDiscoveredDevices(localGladys, config);

  // First poll connects MQTT and subscribes the device.
  await solarflow.onPoll(localGladys, config, device);
  const client = mqttLibrary.clients[0];

  // A fresher report arrives on MQTT...
  client.emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 81 } })),
  );

  localGladys.published.length = 0;
  await solarflow.onPoll(localGladys, config, device);

  const byId = Object.fromEntries(localGladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${device.external_id}:batteryLevel`], 81);
});
