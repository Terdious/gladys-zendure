import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { WIDGETS, BATTERY_WIDGET, GROUP_WIDGET, BATTERY_ACTIONS } from '../src/widgets.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
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
  createTestEnergyMeters,
  createFakeZenSdkFetch,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_DEVICE,
  FAKE_SECOND_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
let gladys;
let mqttLibrary;

beforeEach(() => {
  resetSolarflowRuntime();
  gladys = createFakeGladys();
  mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [FAKE_SOLARFLOW_DEVICE, FAKE_SECOND_SOLARFLOW_DEVICE],
    }),
    mqttLibrary,
    energyMeters: createTestEnergyMeters().meters,
    // Never the network: every local HTTP API is unreachable unless a test
    // injects its own fake.
    localFetchImpl: createFakeZenSdkFetch(),
  });
});

function report(properties, extra = {}) {
  mqttLibrary.clients[0].emit(
    'message',
    `iot/${FAKE_SOLARFLOW_DEVICE.productKey}/${FAKE_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties, ...extra })),
  );
}

async function connectedDevices() {
  const devices = await buildDiscoveredDevices(gladys, config);
  await solarflow.onPoll(gladys, config, devices[0]); // connects the cloud broker
  return devices;
}

test('every widgets key has a handler, and vice versa', () => {
  assert.deepEqual(
    Object.keys(WIDGETS).sort(),
    manifest.widgets.map((widget) => widget.key).sort(),
  );
});

test('the battery widget content is valid, bound to the battery features, with its settings', async () => {
  const [device] = await connectedDevices();
  report(
    { electricLevel: 47, outputLimit: 600, inputLimit: 800, acMode: 2, socSet: 1000, minSoc: 100 },
    { packData: [{ sn: 'C1' }, { sn: 'C2' }] },
  );

  const content = await WIDGETS[BATTERY_WIDGET].get(gladys, {
    settings: { device: device.external_id },
    config,
  });
  assert.deepEqual(validateWidgetContent(content), []);

  const featureIds = new Set(device.features.map((feature) => feature.external_id));
  for (const component of content.components.filter((c) => c.device_feature)) {
    assert.ok(featureIds.has(component.device_feature), `${component.device_feature} is published`);
  }
  const status = content.components.find((c) => c.type === 'status');
  const values = status.items.map((item) => item.value);
  assert.ok(values.includes('600 W'));
  assert.ok(values.includes('10 – 100 %'), 'SoC settings shown in percent, not tenths');
  assert.ok(values.includes('1.8 / 3.84 kWh'));

  const powerForm = content.components.find(
    (c) => c.type === 'button' && c.action.key === BATTERY_ACTIONS.POWER_LIMITS,
  );
  assert.equal(powerForm.action.fields[0].default, 600);
  assert.equal(powerForm.action.params.device, device.external_id);
});

test('the battery widget asks for a battery when none is configured', async () => {
  const content = await WIDGETS[BATTERY_WIDGET].get(gladys, { settings: {}, config });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].type, 'text');
});

test('a widget form sends one command per filled field', async () => {
  const [device] = await connectedDevices();
  report({ outputLimit: 600, inputLimit: 800 });
  const toast = await WIDGETS[BATTERY_WIDGET].action(gladys, {
    actionKey: BATTERY_ACTIONS.POWER_LIMITS,
    params: { device: device.external_id },
    values: { output_limit: 300, input_limit: 800 }, // input unchanged
    config,
  });
  assert.match(toast.en, /Sent to the battery/);
  const writes = mqttLibrary.clients[0].published.filter((p) =>
    p.topic.endsWith('/properties/write'),
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].payload).properties, { smartMode: 1, outputLimit: 300 });
  for (const text of Object.values(toast)) {
    assert.ok(text.length <= 200);
  }
});

test('the group widget sums the selected batteries, every battery when none is selected', async () => {
  const devices = await connectedDevices();
  const all = await WIDGETS[GROUP_WIDGET].get(gladys, { settings: { title: 'Phase L1' }, config });
  assert.deepEqual(validateWidgetContent(all), []);
  assert.equal(all.components[0].text, 'Phase L1');
  const tile = (content, en) =>
    content.components.find((c) => c.type === 'value' && c.label.en === en).value;
  // Raw cloud entries: 0 + 210 W charging, 470 + 90 W solar.
  assert.equal(tile(all, 'Charging'), 210);
  assert.equal(tile(all, 'Solar'), 560);
  assert.equal(all.components.find((c) => c.type === 'status').items.length, 2);

  const one = await WIDGETS[GROUP_WIDGET].get(gladys, {
    settings: { devices: [devices[1].external_id] },
    config,
  });
  assert.deepEqual(validateWidgetContent(one), []);
  assert.equal(tile(one, 'Solar'), 90);
  assert.equal(one.components[0].text.en, 'Batteries');
  // Plain average without known packs: (47 + 62) / 2 for both, 62 for one.
  assert.equal(all.components.find((c) => c.type === 'gauge').value, 55);
  assert.equal(one.components.find((c) => c.type === 'gauge').value, 62);
});
