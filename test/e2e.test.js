// -----------------------------------------------------------------------------
// End-to-end test: the REAL @gladysassistant/integration-sdk client connected
// to a fake Gladys core (WebSocket + REST), with a fake Zendure cloud (fetch)
// and a fake MQTT broker (mqtt.js library), exercising:
//   1. connection + discovery (scan request -> POST /discovered_device);
//   2. polling (device.poll -> POST /state from the cloud/MQTT payload);
//   3. real-time push (MQTT report -> POST /state).
// The wiring mirrors index.js (which starts a singleton at import time and is
// therefore not importable from a test).
// -----------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GladysIntegration } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from '../src/config.js';
import {
  syncDiscoveredDevices,
  findBlueprintByDevice,
  DEVICE_BLUEPRINTS,
} from '../src/devices/index.js';
import { setSolarflowDependencies, resetSolarflowRuntime } from '../src/devices/solarflow.js';
import { startFakeGladysCore, waitFor } from './helpers/fakeGladysCore.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

const SELECTOR = 'zendure';

let core;
let gladys;
let mqttLibrary;
let config = normalizeConfig();
let pushCleanups = [];
let discoveredDevice;

before(async () => {
  core = await startFakeGladysCore({
    config: { cloud_key: FAKE_CLOUD_KEY, poll_frequency: 30 },
  });

  mqttLibrary = createFakeMqttLibrary();
  resetSolarflowRuntime();
  setSolarflowDependencies({ fetchImpl: createFakeZendureFetch(), mqttLibrary });

  gladys = new GladysIntegration({
    hostApiUrl: core.url,
    token: 'integration-token',
    selector: SELECTOR,
  });

  // Same wiring as index.js.
  gladys.onScanRequest(async () => {
    await syncDiscoveredDevices(gladys, config);
  });
  gladys.onPoll(async (device) => {
    const blueprint = findBlueprintByDevice(gladys, device);
    await blueprint.onPoll(gladys, config, device);
  });
  gladys.on('connected', async () => {
    config = normalizeConfig(await gladys.getConfig());
    if (await syncDiscoveredDevices(gladys, config)) {
      pushCleanups = DEVICE_BLUEPRINTS.filter((bp) => typeof bp.startPush === 'function').map(
        (bp) => bp.startPush(gladys, config),
      );
    }
  });

  await gladys.connect();
});

after(async () => {
  for (const cleanup of pushCleanups) {
    cleanup();
  }
  resetSolarflowRuntime();
  await gladys.disconnect();
  await core.close();
});

test('discovery publishes the SolarFlow device to the core', async () => {
  // The 'connected' handler publishes a first discovery on its own.
  await waitFor(() => core.state.discovered.length >= 1);

  // A user-triggered scan publishes it again.
  core.send('external-integration.scan-request', {});
  await waitFor(() => core.state.discovered.length >= 2);

  const devices = core.state.discovered.at(-1);
  assert.equal(devices.length, 1);
  discoveredDevice = devices[0];

  assert.equal(
    discoveredDevice.external_id,
    `ext:${SELECTOR}:solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`,
  );
  assert.equal(discoveredDevice.name, 'Garage battery');
  // The core only polls devices flagged should_poll, at one of its fixed
  // frequencies: 30 s from the config, snapped to milliseconds.
  assert.equal(discoveredDevice.should_poll, true);
  assert.equal(discoveredDevice.poll_frequency, 30000);
  assert.equal(discoveredDevice.features.length, 5);
  assert.equal(discoveredDevice.selector, 'zendure-solarflow-abc123');
  for (const feature of discoveredDevice.features) {
    assert.equal(feature.read_only, true);
    assert.ok(feature.external_id.startsWith(discoveredDevice.external_id));
    assert.ok(feature.selector.startsWith(discoveredDevice.selector));
  }
});

test('discovery reports the connection status and the transport badges to the core', async () => {
  // The connected handler and the scan both go through syncDiscoveredDevices,
  // which POSTs /connection_status and /device/transport after the devices.
  await waitFor(() => core.state.connectionStatuses.length >= 1);
  await waitFor(() => core.state.transports.length >= 1);

  const status = core.state.connectionStatuses.at(-1);
  assert.equal(status.connected, true);

  // On the wire the SDK renames external_id to device_external_id.
  const transports = core.state.transports.at(-1);
  assert.deepEqual(transports, [
    {
      device_external_id: `ext:${SELECTOR}:solarflow:${FAKE_SOLARFLOW_DEVICE.deviceKey}`,
      transport: 'cloud',
    },
  ]);
});

test('polling publishes telemetry states to the core', async () => {
  core.state.states.length = 0;

  core.send('external-integration.device.poll', {
    message_id: 'poll-1',
    device: discoveredDevice,
  });

  await waitFor(() => core.state.states.length >= 5);
  const byId = Object.fromEntries(
    core.state.states.map((s) => [s.device_feature_external_id, s.state]),
  );
  const prefix = discoveredDevice.external_id;
  assert.equal(byId[`${prefix}:batteryLevel`], 47);
  assert.equal(byId[`${prefix}:batteryInputPower`], 150);
  assert.equal(byId[`${prefix}:batteryOutputPower`], 0);
  assert.equal(byId[`${prefix}:homeOutputPower`], 320);
  assert.equal(byId[`${prefix}:solarInputPower`], 470);

  // The poll was acked to the core.
  const ack = await waitFor(() => core.state.commandResults.find((r) => r.message_id === 'poll-1'));
  assert.equal(ack.success, true);
});

test('an MQTT report is pushed to the core in real time', async () => {
  // startPush connected the fake broker: drive its client directly.
  const client = await waitFor(() => mqttLibrary.clients[0]);
  core.state.states.length = 0;

  client.emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 81, outputHomePower: 250 } })),
  );

  await waitFor(() => core.state.states.length >= 2);
  const byId = Object.fromEntries(
    core.state.states.map((s) => [s.device_feature_external_id, s.state]),
  );
  const prefix = discoveredDevice.external_id;
  assert.equal(byId[`${prefix}:batteryLevel`], 81);
  assert.equal(byId[`${prefix}:homeOutputPower`], 250);
});
