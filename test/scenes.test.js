import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SCENE_ACTIONS } from '../src/scenes.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  REACHABILITY_TRIGGER,
  ALERT_TRIGGER,
} from '../src/devices/solarflow.js';
import { ALERT_KINDS } from '../src/zendure/alerts.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createTestEnergyMeters,
  createFakeZenSdkFetch,
  FAKE_CLOUD_KEY,
} from './helpers/fakeZendure.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
let mqttLibrary;

beforeEach(() => {
  resetSolarflowRuntime();
  mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch(),
    mqttLibrary,
    energyMeters: createTestEnergyMeters().meters,
    // Never the network: every local HTTP API is unreachable unless a test
    // injects its own fake.
    localFetchImpl: createFakeZenSdkFetch(),
  });
});

test('every scene_actions key has a handler, and vice versa', () => {
  const declared = manifest.scene_actions.map((action) => action.key);
  assert.deepEqual(Object.keys(SCENE_ACTIONS).sort(), [...declared].sort());
});

test('the scene triggers are the reachability and alert ones the code fires', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key),
    [REACHABILITY_TRIGGER, ALERT_TRIGGER],
  );
  const trigger = manifest.scene_triggers[0];
  // Every key the evaluator publishes is a declared field or variable.
  const declared = [...trigger.fields, ...trigger.variables].map((entry) => entry.key);
  for (const key of ['device', 'state', 'device_name', 'source']) {
    assert.ok(declared.includes(key), `${key} is declared`);
  }
});

test('the alert trigger declares every kind, state and key the code publishes', () => {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === ALERT_TRIGGER);
  const field = (key) => trigger.fields.find((entry) => entry.key === key);
  assert.equal(field('device').source, 'devices');
  assert.deepEqual(
    field('kind').options.map((option) => option.value),
    Object.keys(ALERT_KINDS),
  );
  assert.deepEqual(
    field('state').options.map((option) => option.value),
    ['started', 'ended'],
  );
  const declared = [...trigger.fields, ...trigger.variables].map((entry) => entry.key);
  for (const key of ['device', 'kind', 'state', 'device_name', 'value', 'source']) {
    assert.ok(declared.includes(key), `${key} is declared`);
  }
  // A filter left empty matches any value: none is required.
  assert.ok(trigger.fields.every((entry) => entry.required !== true));
});

test('every action output the handlers return is declared', async () => {
  const gladys = createFakeGladys();
  const [device] = await buildDiscoveredDevices(gladys, config);
  await solarflow.onPoll(gladys, config, device);
  const outputs = await SCENE_ACTIONS.set_output_limit(gladys, {
    fields: { device: device.external_id, watts: 300 },
    config,
  });
  assert.deepEqual(outputs, { sent: true, watts: 300 });
  const declared = manifest.scene_actions
    .find((action) => action.key === 'set_output_limit')
    .outputs.map((output) => output.key);
  assert.deepEqual(Object.keys(outputs).sort(), [...declared].sort());
  const write = mqttLibrary.clients[0].published.find((p) => p.topic.endsWith('/properties/write'));
  assert.deepEqual(JSON.parse(write.payload).properties, { smartMode: 1, outputLimit: 300 });
});
