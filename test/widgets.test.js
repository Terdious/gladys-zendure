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
  FAKE_SOLARFLOW_2400_DEVICE,
  FAKE_HTTP_SOLARFLOW_DEVICE,
  FAKE_HTTP_REPORT,
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
  // No default heading: the card already shows the widget name.
  assert.ok(!one.components.some((c) => c.type === 'text'));
  // Plain average without known packs: (47 + 62) / 2 for both, 62 for one.
  assert.equal(all.components.find((c) => c.type === 'gauge').value, 55);
  assert.equal(one.components.find((c) => c.type === 'gauge').value, 62);
});

test('the group widget lists 9 batteries and a "+N more" row past 10', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...FAKE_SOLARFLOW_DEVICE,
    id: `many-${i}`,
    deviceKey: `Many${i}`,
    snNumber: `SN-MANY-${i}`,
    deviceName: `Battery ${i + 1}`,
  }));
  setSolarflowDependencies({ fetchImpl: createFakeZendureFetch({ deviceList: many }) });
  const content = await WIDGETS[GROUP_WIDGET].get(gladys, { settings: {}, config });
  // Nothing dropped by the core (no warning about extra rows).
  assert.deepEqual(validateWidgetContent(content), []);
  const { items } = content.components.find((c) => c.type === 'status');
  assert.equal(items.length, 10);
  assert.equal(items[8].label, 'Battery 9');
  assert.deepEqual(items[9].label, {
    en: '+3 more',
    fr: '+3 autres',
    de: '+3 weitere',
    es: '+3 más',
  });

  // Exactly 10: every battery listed, no summary row.
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: many.slice(0, 10) }),
  });
  resetSolarflowRuntime();
  const ten = await WIDGETS[GROUP_WIDGET].get(gladys, { settings: {}, config });
  const tenItems = ten.components.find((c) => c.type === 'status').items;
  assert.equal(tenItems.length, 10);
  assert.equal(tenItems[9].label, 'Battery 10');
});

// --- Battery-less devices, AC-only models, remaining time ---------------------

/** A device served by its local API, answering `report`. */
async function localApiBattery(rawDevice, report) {
  resetSolarflowRuntime();
  const zenSdk = createFakeZenSdkFetch({ reports: { [rawDevice.ip]: report } });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [rawDevice] }),
    mqttLibrary,
    localFetchImpl: zenSdk,
  });
  const [device] = await buildDiscoveredDevices(gladys, config);
  const stop = solarflow.startPush(gladys, config);
  for (let i = 0; i < 200 && zenSdk.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { device, stop };
}

const tiles = (content) =>
  content.components.filter((c) => c.type === 'value' || c.type === 'gauge');
const statusValues = (content) =>
  Object.fromEntries(
    content.components.find((c) => c.type === 'status').items.map((i) => [i.label.en, i.value]),
  );

test('the battery widget gauge carries its % unit, and shows the remaining time', async () => {
  const { device, stop } = await localApiBattery(FAKE_HTTP_SOLARFLOW_DEVICE, FAKE_HTTP_REPORT);
  const content = await WIDGETS[BATTERY_WIDGET].get(gladys, {
    settings: { device: device.external_id },
    config,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauge = content.components.find((c) => c.type === 'gauge');
  assert.equal(gauge.unit, '%');
  assert.equal(gauge.value, 64);
  // Discharging at 250 W, the device says 135 min to its floor.
  const status = statusValues(content);
  assert.equal(status['Empty in'], '2 h 15');
  assert.equal(status.Source.en, 'Local (API)');
  assert.equal(status['Output limit'], '600 W');
  stop();
});

test('a device without a battery pack only shows solar, home output and output limit', async () => {
  const noPack = {
    properties: {
      electricLevel: 0,
      packNum: 0,
      packInputPower: 0,
      outputPackPower: 0,
      solarInputPower: 310,
      outputHomePower: 300,
      outputLimit: 800,
    },
    packData: [],
  };
  const { device, stop } = await localApiBattery(FAKE_HTTP_SOLARFLOW_DEVICE, noPack);
  const content = await WIDGETS[BATTERY_WIDGET].get(gladys, {
    settings: { device: device.external_id },
    config,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    tiles(content).map((c) => c.device_feature ?? c.type),
    [`${device.external_id}:solarInputPower`, `${device.external_id}:homeOutputPower`],
  );
  const status = statusValues(content);
  assert.deepEqual(Object.keys(status), ['Source', 'Battery pack', 'Output limit']);
  assert.equal(status['Output limit'], '800 W');
  const buttons = content.components.filter((c) => c.type === 'button');
  assert.equal(buttons.length, 1, 'no "Mode & levels" button');
  assert.deepEqual(
    buttons[0].action.fields.map((f) => f.key),
    ['output_limit'],
  );
  stop();
});

test('battery presence unknown yet keeps every battery figure', async () => {
  // A SolarFlow 800 straight from the cloud entry: no packNum, no packData.
  const sf800 = { ...FAKE_SECOND_SOLARFLOW_DEVICE, productModel: 'SolarFlow 800' };
  setSolarflowDependencies({ fetchImpl: createFakeZendureFetch({ deviceList: [sf800] }) });
  const [device] = await buildDiscoveredDevices(gladys, config);
  const content = await WIDGETS[BATTERY_WIDGET].get(gladys, {
    settings: { device: device.external_id },
    config,
  });
  assert.equal(tiles(content).length, 5);
  assert.equal(content.components.filter((c) => c.type === 'button').length, 2);
});

test('an AC-coupled model has no solar tile', async () => {
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [{ ...FAKE_SOLARFLOW_2400_DEVICE, solarInputPower: 0 }],
    }),
  });
  const [device] = await buildDiscoveredDevices(gladys, config);
  const battery = await WIDGETS[BATTERY_WIDGET].get(gladys, {
    settings: { device: device.external_id },
    config,
  });
  assert.deepEqual(validateWidgetContent(battery), []);
  const labels = tiles(battery).map((c) => c.label.en);
  assert.deepEqual(labels, ['Battery', 'Charging', 'Discharging', 'To the home']);

  const group = await WIDGETS[GROUP_WIDGET].get(gladys, { settings: {}, config });
  assert.ok(!tiles(group).some((c) => c.label.en === 'Solar'));
});

test('the group leaves battery-less devices out of the level and the stored energy', async () => {
  const noPack = {
    ...FAKE_HTTP_SOLARFLOW_DEVICE,
    deviceKey: 'NoPack1',
    snNumber: 'SN-NOPACK',
    deviceName: 'Inverter only',
    ip: '192.168.1.81',
  };
  resetSolarflowRuntime();
  const zenSdk = createFakeZenSdkFetch({
    reports: {
      [FAKE_HTTP_SOLARFLOW_DEVICE.ip]: FAKE_HTTP_REPORT,
      '192.168.1.81': {
        properties: { electricLevel: 0, packNum: 0, solarInputPower: 200, outputHomePower: 190 },
      },
    },
  });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_HTTP_SOLARFLOW_DEVICE, noPack] }),
    mqttLibrary,
    localFetchImpl: zenSdk,
  });
  const devices = await buildDiscoveredDevices(gladys, config);
  const stop = solarflow.startPush(gladys, config);
  for (let i = 0; i < 200 && zenSdk.calls.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));

  const both = await WIDGETS[GROUP_WIDGET].get(gladys, { settings: {}, config });
  assert.deepEqual(validateWidgetContent(both), []);
  // 64 % for the only battery, not (64 + 0) / 2; 64 % of 1.92 kWh stored.
  assert.equal(both.components.find((c) => c.type === 'gauge').value, 64);
  const tile = (content, en) => tiles(content).find((c) => c.label.en === en)?.value;
  assert.equal(tile(both, 'Stored'), 1.23);
  assert.equal(tile(both, 'Solar'), 430);
  assert.equal(tile(both, 'To the home'), 670);
  // Natural order of the names by default: "Inverter only" first.
  const rows = both.components.find((c) => c.type === 'status').items;
  assert.equal(rows[0].label, 'Inverter only');
  assert.equal(rows[0].value, '190 W');
  assert.equal(rows[1].value, '64 % · ↓ 2 h 15');

  // A group of battery-less devices only: no battery figure at all.
  const inverters = await WIDGETS[GROUP_WIDGET].get(gladys, {
    settings: { devices: [devices[1].external_id] },
    config,
  });
  assert.deepEqual(validateWidgetContent(inverters), []);
  assert.equal(
    inverters.components.find((c) => c.type === 'gauge'),
    undefined,
  );
  assert.deepEqual(
    tiles(inverters).map((c) => c.label.en),
    ['To the home', 'Solar'],
  );
  stop();
});
