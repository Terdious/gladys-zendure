// -----------------------------------------------------------------------------
// The zenSDK local HTTP transport in the device layer: source selection,
// telemetry, fallback to the cloud and return, control writes, addresses.
// Every request goes to an in-process fake (createFakeZenSdkFetch).
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiscoveredDevices, describeBatteries } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  flushStatesNow,
  evaluateTelemetrySources,
  controlDevice,
  pollLocalHttpNow,
  getLocalHttpStats,
  LOCAL_HTTP_SILENT_MESSAGE,
  LOCAL_SILENCE_TIMEOUT_IN_MS,
  CLOUD_HOLD_TIME_IN_MS,
} from '../src/devices/solarflow.js';
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
} from './helpers/fakeZendure.js';

const IP = FAKE_HTTP_SOLARFLOW_DEVICE.ip;
const CLOUD_BROKER_URL = 'mqtt://broker.zendure.example:1883';
// The defaults: local HTTP API on, local MQTT off.
const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });

let gladys;
let mqttLibrary;
let zenSdk;
let stopPush = null;

function setup({
  deviceList = [FAKE_HTTP_SOLARFLOW_DEVICE],
  reports = { [IP]: FAKE_HTTP_REPORT },
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

/** Discover, start the push (HTTP probe included) and wait for it to settle. */
async function startWith(cfg = config) {
  const devices = await buildDiscoveredDevices(gladys, cfg);
  stopPush = solarflow.startPush(gladys, cfg);
  await waitFor(() => zenSdk.calls.length > 0);
  await delay(30);
  return devices;
}

const publishedById = () =>
  Object.fromEntries(gladys.published.map((s) => [s.featureExternalId, s.state]));

test('a device answering on its local API is served by it, and the cloud broker stays idle', async () => {
  const [device] = await startWith();

  // Only the local API was used: no MQTT connection at all, so Home
  // Assistant keeps the account's single cloud session to itself.
  assert.equal(mqttLibrary.clients.length, 0);
  assert.equal(zenSdk.calls[0].url, `http://${IP}/properties/report`);

  await pollLocalHttpNow();
  await flushStatesNow(gladys);
  const byId = publishedById();
  assert.equal(byId[`${device.external_id}:batteryLevel`], 64);
  assert.equal(byId[`${device.external_id}:batteryInputPower`], 250);
  assert.equal(byId[`${device.external_id}:homeOutputPower`], 480);
  // The complete report carries packData: the stored energy is known.
  assert.equal(byId[`${device.external_id}:batteryEnergyRemaining`], 1.23);

  // onPoll reads the same cache, still without any broker.
  gladys.published.length = 0;
  await solarflow.onPoll(gladys, config, device);
  assert.equal(mqttLibrary.clients.length, 0);

  assert.deepEqual(await solarflow.buildTransports(gladys, config), [
    { external_id: device.external_id, transport: 'local' },
  ]);
  const [battery] = await describeBatteries(gladys, config);
  assert.equal(battery.source, 'http');
  assert.equal(battery.degraded, false);
  assert.deepEqual(battery.settings, {
    outputLimit: 600,
    inputLimit: 800,
    acMode: 2,
    socSet: 100,
    minSoc: 10,
  });
  assert.deepEqual(battery.remainingTime, { direction: 'discharge', minutes: 135 });
});

/** Fail the local API of a host until the runtime counts it as down. */
async function failLocalApi(host = IP) {
  zenSdk.fail(host);
  for (let i = 0; i < ZENSDK_FAILURES_BEFORE_DOWN; i += 1) {
    await pollLocalHttpNow();
  }
}

test('a device whose local API stops answering falls back to the cloud, then returns', async (t) => {
  // Only the clock is mocked (timers stay real): the silence and hold
  // windows are crossed with tick().
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const [device] = await startWith();
  await pollLocalHttpNow();

  await failLocalApi();
  await evaluateTelemetrySources(gladys, config);
  // A blip is not an outage: still served locally (pending), no cloud, and
  // onPoll does not open it either nor republish the blind cache.
  assert.equal(mqttLibrary.clients.length, 0);
  assert.equal((await describeBatteries(gladys, config))[0].source, 'http');
  await flushStatesNow(gladys);
  gladys.published.length = 0;
  await solarflow.onPoll(gladys, config, device);
  await flushStatesNow(gladys);
  assert.equal(gladys.published.length, 0, 'blind cache not republished');
  // A command meanwhile is tried on the local API (it may be back), never
  // through a cloud connection opened for it.
  await assert.rejects(
    controlDevice(gladys, config, device.external_id, { kind: 'output_limit', watts: 300 }),
    /local HTTP write failed/,
  );
  assert.equal(mqttLibrary.clients.length, 0);

  // Silent past the local-silence window: now the cloud takes over.
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS + 1000);
  await evaluateTelemetrySources(gladys, config);

  // Lazy cloud connection, degraded badge with the local-API reason.
  assert.equal(mqttLibrary.clients.length, 1);
  const cloudClient = mqttLibrary.clients[0];
  assert.equal(cloudClient.url, CLOUD_BROKER_URL);
  assert.deepEqual(gladys.transports.at(-1), [
    {
      external_id: device.external_id,
      transport: 'cloud',
      degraded: true,
      message: LOCAL_HTTP_SILENT_MESSAGE,
    },
  ]);

  // The cloud reports are published meanwhile.
  await delay(10);
  gladys.published.length = 0;
  cloudClient.emit(
    'message',
    `iot/${FAKE_HTTP_SOLARFLOW_DEVICE.productKey}/${FAKE_HTTP_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 41 } })),
  );
  await flushStatesNow(gladys);
  assert.equal(publishedById()[`${device.external_id}:batteryLevel`], 41);

  // The API answers again: back on local at once, but the cloud broker is
  // held for CLOUD_HOLD_TIME_IN_MS after the last device needed it.
  zenSdk.recover(IP);
  await pollLocalHttpNow();
  await waitFor(() => gladys.transports.at(-1)?.[0]?.transport === 'local');
  assert.deepEqual(gladys.transports.at(-1), [
    { external_id: device.external_id, transport: 'local' },
  ]);
  await evaluateTelemetrySources(gladys, config);
  await evaluateTelemetrySources(gladys, config);
  assert.equal(cloudClient.ended, false, 'held after the recovery');

  // Past the hold time, every device still local: released.
  t.mock.timers.tick(CLOUD_HOLD_TIME_IN_MS);
  await pollLocalHttpNow();
  await evaluateTelemetrySources(gladys, config);
  assert.equal(cloudClient.ended, true);
});

test('a new blip within the hold time reuses the held cloud broker', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const [device] = await startWith();
  await pollLocalHttpNow();
  await failLocalApi();
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS + 1000);
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 1);

  zenSdk.recover(IP);
  await pollLocalHttpNow();
  t.mock.timers.tick(CLOUD_HOLD_TIME_IN_MS - 60 * 1000);
  await pollLocalHttpNow();
  await evaluateTelemetrySources(gladys, config);
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients[0].ended, false);

  // Down again for good within the hold: the same connection serves it.
  await failLocalApi();
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS + 1000);
  mqttLibrary.clients[0].emit(
    'message',
    `iot/${FAKE_HTTP_SOLARFLOW_DEVICE.productKey}/${FAKE_HTTP_SOLARFLOW_DEVICE.deviceKey}/properties/report`,
    Buffer.from(JSON.stringify({ properties: { electricLevel: 41 } })),
  );
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 1, 'no reconnection');
  assert.equal(gladys.transports.at(-1)[0].transport, 'cloud');
  assert.equal(gladys.transports.at(-1)[0].external_id, device.external_id);
});

test('startup grace: a device missing the probe is pending, not served by the cloud', async () => {
  // The first answers are lost (Wi-Fi blip at startup), the next ones arrive.
  setup({ reports: {} });
  const [device] = await startWith();
  assert.equal(mqttLibrary.clients.length, 0);
  assert.equal((await describeBatteries(gladys, config))[0].source, 'http');
  assert.deepEqual(await solarflow.buildTransports(gladys, config), [
    { external_id: device.external_id, transport: 'local' },
  ]);
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 0);

  // onPoll during the grace stays local: its fresh-properties request is the
  // one that gets the first answer.
  zenSdk.setReport(IP, FAKE_HTTP_REPORT);
  await solarflow.onPoll(gladys, config, device);
  await pollLocalHttpNow(); // joins the request in flight
  const result = await controlDevice(gladys, config, device.external_id, {
    kind: 'output_limit',
    watts: 300,
  });
  assert.equal(result.source, 'http');
  await evaluateTelemetrySources(gladys, config);
  assert.equal(mqttLibrary.clients.length, 0, 'the cloud was never connected');
});

test('control falls through to the next source when the local API is down', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const [device] = await startWith();
  await pollLocalHttpNow();
  await failLocalApi();
  t.mock.timers.tick(LOCAL_SILENCE_TIMEOUT_IN_MS + 1000);

  // The evaluator still says 'http' (it has not run): the write goes to the
  // cloud broker, not to the dead host.
  const posts = () => zenSdk.calls.filter((call) => call.method === 'POST').length;
  const result = await controlDevice(gladys, config, device.external_id, {
    kind: 'output_limit',
    watts: 300,
  });
  assert.equal(result.source, 'cloud');
  assert.equal(posts(), 0);
  assert.equal(mqttLibrary.clients.length, 1);
});

test('control goes through POST /properties/write with every guard kept', async () => {
  const [device] = await startWith();
  await pollLocalHttpNow();

  const result = await controlDevice(gladys, config, device.external_id, {
    kind: 'output_limit',
    watts: 5000, // above the 800 W rating of a SolarFlow 800
  });
  assert.deepEqual(result, { sent: true, applied: { outputLimit: 800 }, source: 'http' });
  const writes = () => zenSdk.calls.filter((call) => call.method === 'POST');
  assert.equal(writes()[0].url, `http://${IP}/properties/write`);
  assert.deepEqual(writes()[0].body, {
    id: 1,
    sn: FAKE_HTTP_SOLARFLOW_DEVICE.snNumber,
    properties: { smartMode: 1, outputLimit: 800 },
  });
  // A fresh report is asked for right away.
  assert.equal(zenSdk.calls.at(-1).path, '/properties/report');

  // Throttle: the same setting again within its interval is refused.
  await assert.rejects(
    controlDevice(gladys, config, device.external_id, { kind: 'output_limit', watts: 300 }),
    /retry in \d+ s/,
  );
  // Unchanged values are not re-sent (the report says inputLimit 800).
  assert.deepEqual(
    await controlDevice(gladys, config, device.external_id, { kind: 'input_limit', watts: 800 }),
    { sent: false, applied: {} },
  );
  // The SoC scale comes from the device's report (tenths of a percent here).
  await controlDevice(gladys, config, device.external_id, { kind: 'soc_limits', max_soc: 90 });
  assert.deepEqual(writes().at(-1).body.properties, { socSet: 900 });
  assert.equal(writes().at(-1).body.id, 2);
  assert.equal(mqttLibrary.clients.length, 0, 'no broker involved');
});

test('a new IP address from a refreshed device list is polled from then on', async () => {
  await startWith();
  const newIp = '192.168.1.123';
  zenSdk.setReport(newIp, FAKE_HTTP_REPORT);
  const moved = { ...FAKE_HTTP_SOLARFLOW_DEVICE, ip: newIp };
  setSolarflowDependencies({ fetchImpl: createFakeZendureFetch({ deviceList: [moved] }) });

  // A new scan refreshes the cloud device list.
  await buildDiscoveredDevices(gladys, config);
  const before = zenSdk.calls.length;
  await pollLocalHttpNow();
  assert.deepEqual(
    zenSdk.calls.slice(before).map((call) => call.host),
    [newIp],
  );
  assert.equal(getLocalHttpStats().trackedDevices, 1);
  assert.equal((await describeBatteries(gladys, config))[0].source, 'http');
});

test('the push cleanup stops the local API polling, and a new start resumes it', async () => {
  const [device] = await startWith();
  assert.equal(getLocalHttpStats().connected, true);
  stopPush();
  stopPush = null;
  assert.equal(getLocalHttpStats().connected, false);
  // The cache survives the stop.
  assert.equal((await describeBatteries(gladys, config))[0].values.batteryLevel, 64);

  const before = zenSdk.calls.length;
  stopPush = solarflow.startPush(gladys, config);
  await waitFor(() => getLocalHttpStats().connected === true);
  assert.ok(zenSdk.calls.length > before, 'probed again');
  assert.equal(mqttLibrary.clients.length, 0);
  assert.deepEqual(await solarflow.buildTransports(gladys, config), [
    { external_id: device.external_id, transport: 'local' },
  ]);
});

test('without an ip the mDNS name is tried, and an address override wins', async () => {
  const withoutIp = { ...FAKE_HTTP_SOLARFLOW_DEVICE, ip: '' };
  setup({ deviceList: [withoutIp], reports: {} });
  await startWith();
  assert.equal(
    zenSdk.calls[0].url,
    'http://zendure-SolarFlow800-SN-HTTP-800.local/properties/report',
  );

  stopPush();
  resetSolarflowRuntime();
  setup({ deviceList: [withoutIp], reports: { '10.1.1.1': FAKE_HTTP_REPORT } });
  const withOverride = normalizeConfig({
    cloud_key: FAKE_CLOUD_KEY,
    // Spaces around "=" and a lower-case serial are fine; the unknown serial
    // and the malformed pair are logged and ignored.
    local_http_addresses: 'sn-http-800 = 10.1.1.1, SN-UNKNOWN=10.9.9.9, junk',
  });
  await startWith(withOverride);
  assert.equal(zenSdk.calls[0].url, 'http://10.1.1.1/properties/report');
  const [battery] = await describeBatteries(gladys, withOverride);
  assert.equal(battery.source, 'http');
});

test('a device whose local API never answered stays a plain cloud device', async () => {
  setup({ reports: {} });
  const [device] = await startWith();

  // Pending until it missed ZENSDK_FAILURES_BEFORE_DOWN requests (startup
  // grace), then served by the cloud, and not flagged degraded: local access
  // is on by default and may simply not exist on this network.
  assert.equal(mqttLibrary.clients.length, 0);
  for (let i = 0; i < ZENSDK_FAILURES_BEFORE_DOWN; i += 1) {
    await pollLocalHttpNow();
  }
  await evaluateTelemetrySources(gladys, config);
  await waitFor(() => mqttLibrary.clients.length === 1);
  assert.equal(mqttLibrary.clients[0].url, CLOUD_BROKER_URL);
  assert.deepEqual(await solarflow.buildTransports(gladys, config), [
    { external_id: device.external_id, transport: 'cloud' },
  ]);
  await evaluateTelemetrySources(gladys, config);
  assert.deepEqual(await solarflow.buildTransports(gladys, config), [
    { external_id: device.external_id, transport: 'cloud' },
  ]);

  // It starts answering later: it moves to its local API by itself.
  zenSdk.setReport(IP, FAKE_HTTP_REPORT);
  await pollLocalHttpNow();
  await waitFor(() => gladys.transports.at(-1)?.[0]?.transport === 'local');
});

test('the local API is not used when the option is off, nor for the Hyper 2000', async () => {
  const hyper = {
    ...FAKE_HTTP_SOLARFLOW_DEVICE,
    deviceKey: 'Hyp1',
    snNumber: 'SN-HYPER',
    productModel: 'Hyper 2000',
    ip: '192.168.1.81',
  };
  setup({ deviceList: [FAKE_HTTP_SOLARFLOW_DEVICE, hyper] });
  const off = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, enable_local_http: false });
  await buildDiscoveredDevices(gladys, off);
  stopPush = solarflow.startPush(gladys, off);
  await waitFor(() => mqttLibrary.clients.length === 1);
  await delay(20);
  assert.equal(zenSdk.calls.length, 0);

  stopPush();
  resetSolarflowRuntime();
  setup({ deviceList: [hyper] });
  stopPush = solarflow.startPush(gladys, config);
  await waitFor(() => mqttLibrary.clients.length === 1);
  await delay(20);
  assert.equal(zenSdk.calls.length, 0, 'the Hyper 2000 has no zenSDK local API');
});

test('a configured local broker stands by behind the local API and takes over first', async () => {
  const both = { ...FAKE_LOCAL_SOLARFLOW_DEVICE, ip: '192.168.1.90' };
  const withMqtt = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, enable_local_mqtt: true });
  setup({ deviceList: [both], reports: { '192.168.1.90': FAKE_HTTP_REPORT } });
  const [device] = await startWith(withMqtt);
  await pollLocalHttpNow();

  // The local broker is connected (standby), the cloud is not.
  assert.deepEqual(
    mqttLibrary.clients.map((client) => client.url),
    ['mqtt://192.168.1.50:1883'],
  );
  // While the API serves the device, a local MQTT message does not move it.
  mqttLibrary.clients[0].emit(
    'message',
    `Zendure/sensor/${both.snNumber}/electricLevel`,
    Buffer.from('12'),
  );
  assert.equal((await describeBatteries(gladys, withMqtt))[0].source, 'http');

  zenSdk.fail('192.168.1.90');
  for (let i = 0; i < ZENSDK_FAILURES_BEFORE_DOWN; i += 1) {
    await pollLocalHttpNow();
  }
  await evaluateTelemetrySources(gladys, withMqtt);
  // Local MQTT, not the cloud: still a plain local badge.
  assert.deepEqual(gladys.transports.at(-1), [
    { external_id: device.external_id, transport: 'local' },
  ]);
  assert.equal((await describeBatteries(gladys, withMqtt))[0].source, 'local');
  assert.equal(mqttLibrary.clients.length, 1, 'no cloud connection');
});
