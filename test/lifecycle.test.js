// -----------------------------------------------------------------------------
// Device lifecycle (issue #21): a battery deleted in Gladys is no longer
// tracked at all — local API polling, broker subscriptions, source evaluation,
// cloud fallback, watchdog, widgets, scenes, diagnostic — the ignore-set
// survives a restart (free configuration key), the discovery keeps listing
// the battery, and creating it again resumes everything without a restart.
// Every request goes to in-process fakes.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveredDevices,
  describeBatteries,
  describeDiagnostics,
  handleDeviceCreated,
  handleDeviceDeleted,
  restoreDeviceLifecycle,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  flushStatesNow,
  evaluateTelemetrySources,
  controlDevice,
  pollLocalHttpNow,
  getLocalHttpStats,
  LOCAL_SILENCE_TIMEOUT_IN_MS,
  TELEMETRY_WATCHDOG_INTERVAL_IN_MS,
} from '../src/devices/solarflow.js';
import {
  IGNORED_DEVICES_CONFIG_KEY,
  ignoreEntryOf,
  parseIgnoredDevices,
  serializeIgnoredDevices,
} from '../src/devices/ignored.js';
import { buildFleetDiagnostic } from '../src/diagnostic.js';
import { ZENSDK_FAILURES_BEFORE_DOWN } from '../src/zendure/zensdk.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createFakeZenSdkFetch,
  createTestEnergyMeters,
  FAKE_CLOUD_KEY,
  FAKE_HTTP_SOLARFLOW_DEVICE,
  FAKE_HTTP_REPORT,
  FAKE_LOCAL_SOLARFLOW_DEVICE,
  FAKE_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

// A second battery on its local API, the one that gets deleted.
const FAKE_SECOND_HTTP_DEVICE = {
  ...FAKE_HTTP_SOLARFLOW_DEVICE,
  deviceKey: 'HtTp801',
  snNumber: 'SN-HTTP-801',
  deviceName: 'Misbehaving battery',
  ip: '192.168.1.81',
};
const KEPT_IP = FAKE_HTTP_SOLARFLOW_DEVICE.ip;
const DELETED_IP = FAKE_SECOND_HTTP_DEVICE.ip;
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
const localMqttConfig = normalizeConfig({
  cloud_key: FAKE_CLOUD_KEY,
  enable_local_http: false,
  enable_local_mqtt: true,
});

let gladys;
let mqttLibrary;
let zenSdk;
let stopPush = null;

function setup({
  deviceList = [FAKE_HTTP_SOLARFLOW_DEVICE, FAKE_SECOND_HTTP_DEVICE],
  reports = { [KEPT_IP]: FAKE_HTTP_REPORT, [DELETED_IP]: FAKE_HTTP_REPORT },
} = {}) {
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

/** Discover, start the push and wait for it to settle. */
async function startWith(cfg = config) {
  const devices = await buildDiscoveredDevices(gladys, cfg);
  stopPush = solarflow.startPush(gladys, cfg);
  await waitFor(() => zenSdk.calls.length > 0 || mqttLibrary.clients.length > 0);
  await delay(30);
  return devices;
}

/** Restart the push subscriptions, like index.js after a re-creation. */
async function restartPush(cfg = config) {
  stopPush?.();
  stopPush = solarflow.startPush(gladys, cfg);
  await delay(30);
}

const callsTo = (host) => zenSdk.calls.filter((call) => call.host === host).length;

test('the ignore-set helpers parse, serialize and name entries defensively', () => {
  assert.deepEqual(
    [...parseIgnoredDevices('["solarflow:B","solarflow:A"]')],
    ['solarflow:B', 'solarflow:A'],
  );
  assert.deepEqual([...parseIgnoredDevices(['solarflow:A', '', 3])], ['solarflow:A']);
  assert.equal(parseIgnoredDevices('{not json').size, 0);
  assert.equal(parseIgnoredDevices(undefined).size, 0);
  assert.equal(parseIgnoredDevices('{"a":1}').size, 0);
  assert.equal(
    serializeIgnoredDevices(new Set(['solarflow:B', 'solarflow:A'])),
    '["solarflow:A","solarflow:B"]',
  );
  const realIds = { externalId: (suffix) => `ext:zendure:${suffix}` };
  assert.equal(
    ignoreEntryOf(realIds, { external_id: 'ext:zendure:solarflow:AbC123' }),
    'solarflow:AbC123',
  );
  assert.equal(ignoreEntryOf(realIds, { external_id: 'ext:other:solarflow:AbC123' }), null);
  assert.equal(ignoreEntryOf(realIds, {}), null);
});

test('deleting a battery on the cloud fallback releases the cloud and stops everything at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const [kept, deleted] = await startWith();
  await pollLocalHttpNow();

  // The second battery's local API goes silent for good: the cloud broker
  // is lazily connected for it (the field case of the issue).
  zenSdk.fail(DELETED_IP);
  for (let i = 0; i < ZENSDK_FAILURES_BEFORE_DOWN; i += 1) {
    await pollLocalHttpNow();
  }
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS + 1000);
  zenSdk.recover(KEPT_IP);
  await pollLocalHttpNow();
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 1);
  const cloudClient = mqttLibrary.clients[0];
  assert.equal(gladys.transports.at(-1)[0].external_id, deleted.external_id);
  assert.equal(gladys.transports.at(-1)[0].transport, 'cloud');
  // A value of the deleted battery is waiting in the paced channel.
  cloudClient.emit(
    'message',
    `iot/${FAKE_SECOND_HTTP_DEVICE.productKey}/${FAKE_SECOND_HTTP_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 41 } })),
  );

  // The user deletes it in Gladys.
  const log = t.mock.method(console, 'log', () => {});
  assert.equal(await handleDeviceDeleted(gladys, config, deleted), true);
  // Saved in the free configuration key.
  assert.deepEqual(gladys.configWrites.at(-1), {
    [IGNORED_DEVICES_CONFIG_KEY]: '["solarflow:HtTp801"]',
  });
  // No remaining battery needs the cloud: released at once, with no hold
  // time for a battery that is gone (Home Assistant gets its session back).
  assert.equal(cloudClient.ended, true);
  assert.ok(cloudClient.unsubscriptions.some((topic) => topic.includes('HtTp801')));
  // Its local API is no longer polled.
  assert.equal(getLocalHttpStats().trackedDevices, 1);
  const before = callsTo(DELETED_IP);
  await pollLocalHttpNow();
  assert.equal(callsTo(DELETED_IP), before);
  // The ignored device is logged in one line.
  const lines = log.mock.calls.map((call) => String(call.arguments.join(' ')));
  assert.ok(
    lines.some((line) =>
      line.includes('1 device(s) ignored (deleted in Gladys): Misbehaving battery (HtTp801)'),
    ),
  );

  // Its queued value is dropped, nothing of it is published any more.
  gladys.published.length = 0;
  await flushStatesNow(gladys);
  assert.ok(!gladys.published.some((s) => s.featureExternalId.startsWith(deleted.external_id)));

  // Later evaluations never bring the cloud back for it.
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS * 4);
  await pollLocalHttpNow();
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 1, 'no new cloud connection');

  // Widgets, scenes, badges and diagnostic leave it out; the discovery keeps
  // it, so it can be created again from the Discover tab.
  assert.deepEqual(
    (await describeBatteries(gladys, config)).map((battery) => battery.externalId),
    [kept.external_id],
  );
  await assert.rejects(
    controlDevice(gladys, config, deleted.external_id, { kind: 'output_limit', watts: 300 }),
    /was deleted in Gladys/,
  );
  assert.deepEqual(
    (await solarflow.buildTransports(gladys, config)).map((entry) => entry.external_id),
    [kept.external_id],
  );
  assert.equal((await buildDiscoveredDevices(gladys, config)).length, 2);
  const snapshot = await describeDiagnostics(gladys, config);
  assert.deepEqual(
    snapshot.devices.map((device) => device.name),
    ['Shed inverter'],
  );
  const report = buildFleetDiagnostic(snapshot);
  assert.equal(report.match(/Ignored \(deleted in Gladys\)/g).length, 1);
  assert.match(report, /1 battery\(ies\): Misbehaving battery \(/);
  assert.ok(!report.includes('HtTp801'), 'the device key stays masked');

  // A second deletion event for the same device changes nothing.
  const writes = gladys.configWrites.length;
  assert.equal(await handleDeviceDeleted(gladys, config, deleted), false);
  assert.equal(gladys.configWrites.length, writes);
});

test('creating the battery again from Discover resumes it without a restart', async () => {
  const [, deleted] = await startWith();
  await handleDeviceDeleted(gladys, config, deleted);
  assert.equal(getLocalHttpStats().trackedDevices, 1);
  await pollLocalHttpNow();
  await flushStatesNow(gladys);

  gladys.transports.length = 0;
  assert.equal(await handleDeviceCreated(gladys, config, deleted), true);
  assert.deepEqual(gladys.configWrites.at(-1), { [IGNORED_DEVICES_CONFIG_KEY]: '[]' });
  // Its transport badge is published again.
  assert.ok(gladys.transports.at(-1).some((entry) => entry.external_id === deleted.external_id));
  await restartPush();
  assert.equal(getLocalHttpStats().trackedDevices, 2);

  // Its values are published at once, although they did not change since
  // the deletion (the dedup memory of the device was forgotten).
  gladys.published.length = 0;
  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  const byId = Object.fromEntries(gladys.published.map((s) => [s.featureExternalId, s.state]));
  assert.equal(byId[`${deleted.external_id}:batteryLevel`], 64);
  assert.equal((await describeBatteries(gladys, config)).length, 2);

  // Creating a device that was never deleted only re-sends its values.
  assert.equal(await handleDeviceCreated(gladys, config, deleted), false);
});

test('the ignore-set survives a restart, and a device present in Gladys again leaves it', async () => {
  const [, deleted] = await startWith();
  await handleDeviceDeleted(gladys, config, deleted);
  const savedConfig = { ...gladys.config };
  stopPush();
  stopPush = null;

  // Container restart: a fresh runtime, the configuration read back.
  resetSolarflowRuntime();
  mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({ energyMeters: createTestEnergyMeters().meters });
  setup();
  gladys = createFakeGladys();
  await restoreDeviceLifecycle(gladys, savedConfig);
  assert.equal(gladys.configWrites.length, 0, 'nothing to save: unchanged');
  await startWith();
  assert.equal(callsTo(DELETED_IP), 0, 'the deleted battery is not even probed');
  assert.equal(getLocalHttpStats().trackedDevices, 1);
  assert.equal((await describeBatteries(gladys, config)).length, 1);

  // Another restart, the device was created again while the integration was
  // down (its creation event missed): it is tracked again.
  stopPush();
  stopPush = null;
  resetSolarflowRuntime();
  setSolarflowDependencies({ energyMeters: createTestEnergyMeters().meters });
  setup();
  gladys = createFakeGladys();
  gladys.devices.push({ external_id: deleted.external_id });
  await restoreDeviceLifecycle(gladys, savedConfig);
  assert.deepEqual(gladys.configWrites.at(-1), { [IGNORED_DEVICES_CONFIG_KEY]: '[]' });
  await startWith();
  assert.equal(getLocalHttpStats().trackedDevices, 2);
});

test('a deleted local-MQTT battery is unsubscribed, and its broker released when unused', async () => {
  setup({ deviceList: [FAKE_LOCAL_SOLARFLOW_DEVICE, FAKE_SOLARFLOW_DEVICE], reports: {} });
  const devices = await startWith(localMqttConfig);
  const localDevice = devices.find((d) =>
    d.external_id.endsWith(FAKE_LOCAL_SOLARFLOW_DEVICE.deviceKey),
  );
  const localClient = mqttLibrary.clients.find(
    (client) => client.url === 'mqtt://192.168.1.50:1883',
  );
  const cloudClient = mqttLibrary.clients.find((client) => client !== localClient);
  assert.ok(localClient.subscriptions.some((topic) => topic.includes('SN-LOCAL-1')));

  await handleDeviceDeleted(gladys, localMqttConfig, localDevice);
  assert.ok(localClient.unsubscriptions.some((topic) => topic.includes('SN-LOCAL-1')));
  // Its broker served no other battery: disconnected.
  assert.equal(localClient.ended, true);
  // The cloud broker still serves the cloud-only battery.
  assert.equal(cloudClient.ended, false);
  assert.ok(cloudClient.unsubscriptions.some((topic) => topic.includes('LoC456')));

  // A local message arriving late is dropped.
  gladys.published.length = 0;
  localClient.emit('message', 'Zendure/sensor/SN-LOCAL-1/electricLevel', Buffer.from('33'));
  await flushStatesNow(gladys);
  assert.equal(gladys.published.length, 0);
});

test('the watchdog no longer reports a deleted battery as silent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  setup({ reports: { [KEPT_IP]: FAKE_HTTP_REPORT } });
  const [, deleted] = await startWith();
  await handleDeviceDeleted(gladys, config, deleted);
  const log = t.mock.method(console, 'log', () => {});
  t.mock.timers.tick(TELEMETRY_WATCHDOG_INTERVAL_IN_MS);
  const lines = log.mock.calls.map((call) => String(call.arguments.join(' ')));
  const httpLine = lines.find((line) => line.includes('telemetry(local http)'));
  assert.ok(httpLine, 'the watchdog reported');
  assert.ok(!httpLine.includes('Misbehaving battery'), httpLine);
});

test('the registry routes the lifecycle events to the blueprint only for its devices', async () => {
  assert.equal(await handleDeviceDeleted(gladys, config, { external_id: 'other:thing' }), false);
  assert.equal(await handleDeviceCreated(gladys, config, { external_id: 'other:thing' }), false);
  assert.equal(findBlueprintByDevice(gladys, { external_id: 'other:thing' }), undefined);
  assert.equal(gladys.configWrites.length, 0);
});
