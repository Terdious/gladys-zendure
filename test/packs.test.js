// -----------------------------------------------------------------------------
// Battery packs as separate devices (issue #16, opt-in `enable_pack_devices`):
// one Gladys device per pack serial, its values scaled per source (raw
// `packData` of the local API / cloud / legacy local JSON, pre-scaled native
// local topics), published through the paced channel, the parent device
// unchanged. Multi-pack fixtures; every request goes to in-process fakes.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiscoveredDevices, handleDeviceDeleted } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  flushStatesNow,
  pollLocalHttpNow,
} from '../src/devices/solarflow.js';
import {
  PACK_DEVICE_TYPE,
  PACK_FEATURES,
  packDeviceNameOf,
  packListOf,
  packValuesOf,
  signedInt16,
} from '../src/zendure/packs.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createFakeZenSdkFetch,
  createTestEnergyMeters,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_2400_DEVICE,
  FAKE_LOCAL_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

// A SolarFlow 2400 AC on its local API, with three packs (AB3000X-like).
const AC2400 = {
  ...FAKE_SOLARFLOW_2400_DEVICE,
  snNumber: 'SN-2400-AC',
  ip: '192.168.1.24',
};
const PACKS = [
  {
    sn: 'FO4HPACK0001',
    packType: 300,
    socLevel: 64,
    maxTemp: 3011,
    totalVol: 5210,
    batcur: 65504,
    power: 65370,
    soh: 1000,
  },
  {
    sn: 'FO4HPACK0002',
    packType: 300,
    socLevel: 58,
    maxTemp: 2981,
    totalVol: 5198,
    batcur: 32,
    power: 166,
    soh: 990,
  },
  {
    sn: 'FO4HPACK0003',
    packType: 300,
    socLevel: 71,
    maxTemp: 2961,
    totalVol: 5225,
    batcur: 0,
    power: 0,
    soh: 1000,
  },
];
const AC2400_REPORT = {
  properties: {
    electricLevel: 64,
    packInputPower: 300,
    outputPackPower: 0,
    outputHomePower: 500,
    solarInputPower: 200,
    packNum: 3,
  },
  packData: PACKS,
};

const offConfig = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
const onConfig = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, enable_pack_devices: true });
const localOnConfig = normalizeConfig({
  cloud_key: FAKE_CLOUD_KEY,
  enable_local_http: false,
  enable_local_mqtt: true,
  enable_pack_devices: 'true',
});

let gladys;
let mqttLibrary;
let zenSdk;
let stopPush = null;

function setup({ deviceList = [AC2400], reports = { [AC2400.ip]: AC2400_REPORT } } = {}) {
  zenSdk = createFakeZenSdkFetch({ reports });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList }),
    mqttLibrary,
    localFetchImpl: zenSdk,
  });
}

beforeEach(() => {
  stopPush?.();
  stopPush = null;
  resetSolarflowRuntime();
  gladys = createFakeGladys();
  mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ energyMeters: createTestEnergyMeters().meters });
  setup();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discover once (bootstrap), start the push, let it settle, discover again. */
async function startWith(cfg) {
  await buildDiscoveredDevices(gladys, cfg);
  stopPush = solarflow.startPush(gladys, cfg);
  await delay(40);
  return buildDiscoveredDevices(gladys, cfg);
}

const publishedById = () =>
  Object.fromEntries(gladys.published.map((s) => [s.featureExternalId, s.state]));
const packId = (sn) => `${PACK_DEVICE_TYPE}:${sn}`;

test('pack values: raw packData and pre-scaled local values give the same units', () => {
  assert.equal(signedInt16(65504), -32);
  assert.equal(signedInt16(32), 32);
  assert.equal(signedInt16(null), null);
  assert.deepEqual(packValuesOf(PACKS[0], { scaled: false }), {
    level: 64,
    temperature: 28,
    voltage: 52.1,
    current: -3.2,
    power: -166,
  });
  assert.deepEqual(
    packValuesOf(
      { socLevel: 63, maxTemp: 27.5, totalVol: 52.13, batcur: -3.1, power: -160 },
      { scaled: true },
    ),
    { level: 63, temperature: 27.5, voltage: 52.13, current: -3.1, power: -160 },
  );
  // A local value still in raw units is recognized (decikelvin, centivolts).
  assert.deepEqual(packValuesOf({ maxTemp: 3011, totalVol: 5210 }, { scaled: true }), {
    level: null,
    temperature: 28,
    voltage: 52.1,
    current: null,
    power: null,
  });
  // Placeholders and glitches are never published.
  assert.deepEqual(
    packValuesOf({ socLevel: 140, maxTemp: 0, totalVol: 99999, batcur: 'x' }, { scaled: false }),
    { level: null, temperature: null, voltage: null, current: null, power: null },
  );
  assert.equal(packListOf({ properties: { packData: [{ sn: 'A' }, { sn: '' }, null] } }).length, 1);
  assert.equal(packDeviceNameOf('Attic battery', 2, 'de'), 'Attic battery — Pack 2');
  assert.equal(packDeviceNameOf('Attic battery', 2, 'xx'), 'Attic battery — pack 2');
});

test('the option is off by default: no pack device, no pack state', async () => {
  assert.equal(offConfig.enable_pack_devices, false);
  const devices = await startWith(offConfig);
  assert.equal(devices.length, 1);
  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  assert.ok(gladys.published.length > 0);
  assert.ok(!gladys.published.some((s) => s.featureExternalId.startsWith(PACK_DEVICE_TYPE)));
});

test('on: one device per pack, named after its battery, the parent unchanged', async () => {
  const [parentOff] = await startWith(offConfig);
  stopPush();
  resetSolarflowRuntime();
  setSolarflowDependencies({ energyMeters: createTestEnergyMeters().meters });
  setup();

  const devices = await startWith(onConfig);
  assert.equal(devices.length, 4);
  const [parent, ...packs] = devices;
  // The battery's own device is exactly the one without the option.
  assert.deepEqual(parent, parentOff);

  assert.deepEqual(
    packs.map((pack) => pack.name),
    ['Attic battery — pack 1', 'Attic battery — pack 2', 'Attic battery — pack 3'],
  );
  assert.deepEqual(
    packs.map((pack) => pack.external_id),
    PACKS.map((pack) => packId(pack.sn)),
  );
  const ids = devices.flatMap((device) => [
    device.external_id,
    ...device.features.map((feature) => feature.external_id),
  ]);
  assert.equal(new Set(ids).size, ids.length, 'no external id collision');
  const selectors = devices.flatMap((device) => [
    device.selector,
    ...device.features.map((feature) => feature.selector),
  ]);
  assert.equal(new Set(selectors).size, selectors.length, 'no selector collision');
  for (const pack of packs) {
    assert.ok(!pack.external_id.startsWith(`${parent.external_id}:`));
    assert.equal(pack.should_poll, false);
    assert.deepEqual(
      pack.features.map((feature) => [feature.category, feature.type, feature.unit]),
      [
        ['battery', 'integer', 'percent'],
        ['device-temperature-sensor', 'decimal', 'celsius'],
        ['energy-sensor', 'voltage', 'volt'],
        ['energy-sensor', 'current', 'ampere'],
        ['energy-sensor', 'power', 'watt'],
      ],
    );
    // Never the home battery category the energy dashboards aggregate.
    assert.ok(pack.features.every((feature) => feature.category !== 'battery-storage'));
    assert.ok(pack.features.every((feature) => feature.read_only === true));
  }
  assert.equal(PACK_FEATURES.length, 5);

  // Feature names follow the feature_names option.
  const french = await buildDiscoveredDevices(gladys, { ...onConfig, feature_names: 'fr' });
  assert.equal(french[1].features[0].name, 'Niveau du pack');
  assert.equal(french[1].name, 'Attic battery — pack 1');
});

test('the local API report publishes every pack, raw values scaled, through the paced channel', async () => {
  const [parent] = await startWith(onConfig);
  await pollLocalHttpNow();
  gladys.published.length = 0;
  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  const byId = publishedById();
  assert.equal(byId[`${packId(PACKS[0].sn)}:level`], 64);
  assert.equal(byId[`${packId(PACKS[0].sn)}:temperature`], 28);
  assert.equal(byId[`${packId(PACKS[0].sn)}:voltage`], 52.1);
  assert.equal(byId[`${packId(PACKS[0].sn)}:current`], -3.2);
  assert.equal(byId[`${packId(PACKS[0].sn)}:power`], -166);
  assert.equal(byId[`${packId(PACKS[1].sn)}:current`], 3.2);
  assert.equal(byId[`${packId(PACKS[2].sn)}:level`], 71);
  // The parent's own features still come from the same report.
  assert.equal(byId[`${parent.external_id}:batteryLevel`], 64);
  assert.equal(byId[`${parent.external_id}:batteryMaxTemperature`], 28);

  // onPoll of the battery re-publishes its packs too (the keep-alive path).
  gladys.published.length = 0;
  await solarflow.onPoll(gladys, onConfig, parent);
  await flushStatesNow(gladys);
  // Unchanged values: deduplicated, nothing new to send.
  assert.ok(!gladys.published.some((s) => s.featureExternalId.startsWith(PACK_DEVICE_TYPE)));
  // A pack device itself is never polled.
  await solarflow.onPoll(gladys, onConfig, { external_id: packId(PACKS[0].sn) });
});

test('the local broker: legacy JSON names the packs, native pack topics update them', async () => {
  const legacyPacks = [
    { sn: 'CO4FPACKL001', socLevel: 50, maxTemp: 2981, totalVol: 5200, batcur: 20 },
    { sn: 'CO4FPACKL002', socLevel: 52, maxTemp: 2991, totalVol: 5210, batcur: 21 },
  ];
  setup({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE], reports: {} });
  await startWith(localOnConfig);
  const localClient = mqttLibrary.clients.find(
    (client) => client.url === 'mqtt://192.168.1.50:1883',
  );
  assert.ok(localClient);
  const { productKey, deviceKey } = FAKE_LOCAL_SOLARFLOW_DEVICE;

  // A legacy JSON report with its packData.
  localClient.emit(
    'message',
    `iot/${productKey}/${deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 51 }, packData: legacyPacks })),
  );
  await flushStatesNow(gladys);
  let byId = publishedById();
  assert.equal(byId[`${packId('CO4FPACKL001')}:voltage`], 52);
  assert.equal(byId[`${packId('CO4FPACKL002')}:current`], 2.1);
  // The parent's hottest pack now comes from the local report as well.
  assert.equal(byId[`solarflow:${deviceKey}:batteryMaxTemperature`], 26);
  // The packs' native topics are now subscribed.
  assert.ok(localClient.subscriptions.includes('Zendure/sensor/CO4FPACKL001/#'));
  assert.ok(localClient.subscriptions.includes('Zendure/sensor/CO4FPACKL002/#'));

  // Native per-pack messages, already scaled: they win for that pack.
  gladys.published.length = 0;
  const topic = (metric) => `Zendure/sensor/CO4FPACKL001/CO4FPACKL001_${metric}`;
  localClient.emit('message', topic('socLevel'), Buffer.from('49'));
  localClient.emit('message', topic('totalVol'), Buffer.from('52.13'));
  localClient.emit('message', topic('batcur'), Buffer.from('-3.1'));
  localClient.emit('message', topic('maxTemp'), Buffer.from('27.5'));
  localClient.emit('message', topic('power'), Buffer.from('-162'));
  await flushStatesNow(gladys);
  byId = publishedById();
  assert.equal(byId[`${packId('CO4FPACKL001')}:level`], 49);
  assert.equal(byId[`${packId('CO4FPACKL001')}:voltage`], 52.13);
  assert.equal(byId[`${packId('CO4FPACKL001')}:current`], -3.1);
  assert.equal(byId[`${packId('CO4FPACKL001')}:temperature`], 27.5);
  assert.equal(byId[`${packId('CO4FPACKL001')}:power`], -162);
  // A pack message is not the battery's own telemetry.
  assert.ok(!Object.keys(byId).some((id) => id.startsWith(`solarflow:${deviceKey}:`)));

  // Discovery lists the two learned packs.
  const devices = await buildDiscoveredDevices(gladys, localOnConfig);
  assert.deepEqual(
    devices.slice(1).map((device) => device.name),
    ['Local battery — pack 1', 'Local battery — pack 2'],
  );

  // Deleting one pack device in Gladys stops it (issue #21), not its sibling.
  await handleDeviceDeleted(gladys, localOnConfig, { external_id: packId('CO4FPACKL001') });
  assert.ok(localClient.unsubscriptions.includes('Zendure/sensor/CO4FPACKL001/#'));
  gladys.published.length = 0;
  localClient.emit('message', topic('socLevel'), Buffer.from('47'));
  localClient.emit(
    'message',
    `iot/${productKey}/${deviceKey}/properties/report`,
    Buffer.from(
      JSON.stringify({ packData: legacyPacks.map((pack) => ({ ...pack, socLevel: 40 })) }),
    ),
  );
  await flushStatesNow(gladys);
  byId = publishedById();
  assert.equal(byId[`${packId('CO4FPACKL001')}:level`], undefined);
  assert.equal(byId[`${packId('CO4FPACKL002')}:level`], 40);
});

test('the cloud device list names packs but never publishes their stale values', async () => {
  const cloudOnly = {
    ...FAKE_SOLARFLOW_2400_DEVICE,
    packData: [{ sn: 'CLOUDPACK1', socLevel: 12 }],
  };
  setup({ deviceList: [cloudOnly], reports: {} });
  const devices = await startWith(onConfig);
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Attic battery', 'Attic battery — pack 1'],
  );
  await solarflow.onPoll(gladys, onConfig, devices[0]);
  await flushStatesNow(gladys);
  assert.ok(!gladys.published.some((s) => s.featureExternalId.startsWith(PACK_DEVICE_TYPE)));

  // A cloud report does publish them.
  const cloudClient = mqttLibrary.clients[0];
  cloudClient.emit(
    'message',
    `iot/${cloudOnly.productKey}/${cloudOnly.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: {}, packData: [{ sn: 'CLOUDPACK1', socLevel: 33 }] })),
  );
  await flushStatesNow(gladys);
  assert.equal(publishedById()[`${packId('CLOUDPACK1')}:level`], 33);
});

test('turning the option off lists no pack any more and stops their states', async () => {
  await startWith(onConfig);
  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  assert.ok(gladys.published.some((s) => s.featureExternalId.startsWith(PACK_DEVICE_TYPE)));

  // The configuration update restarts the push with the option off.
  stopPush();
  stopPush = solarflow.startPush(gladys, offConfig);
  await delay(40);
  const devices = await buildDiscoveredDevices(gladys, offConfig);
  assert.equal(devices.length, 1);
  gladys.published.length = 0;
  zenSdk.setReport(AC2400.ip, {
    properties: { ...AC2400_REPORT.properties, electricLevel: 10 },
    packData: PACKS.map((pack) => ({ ...pack, socLevel: 10 })),
  });
  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  assert.ok(gladys.published.length > 0);
  assert.ok(!gladys.published.some((s) => s.featureExternalId.startsWith(PACK_DEVICE_TYPE)));
});
