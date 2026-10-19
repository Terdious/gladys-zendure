// -----------------------------------------------------------------------------
// "Battery alert" scene trigger (#43): the status codes of a battery (fault,
// heating, calibration, low temperature, reverse flow) fire the trigger on
// their confirmed transitions only — never at startup, never on a blink,
// never for a battery deleted in Gladys nor from a pack. In-process fakes
// only.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_CONFIRM_DELAY_IN_MS,
  ALERT_KINDS,
  alertStateOf,
  createAlertTracker,
} from '../src/zendure/alerts.js';
import { buildDiscoveredDevices, handleDeviceDeleted } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  pollLocalHttpNow,
  ALERT_TRIGGER,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createFakeZenSdkFetch,
  createTestEnergyMeters,
  FAKE_CLOUD_KEY,
  FAKE_HTTP_REPORT,
  FAKE_HTTP_SOLARFLOW_DEVICE,
  FAKE_SOLARFLOW_DEVICE,
  FAKE_SECOND_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
const DELAY = ALERT_CONFIRM_DELAY_IN_MS;

let mqttLibrary;
let stopPush = null;

afterEach(() => {
  stopPush?.();
  stopPush = null;
});

beforeEach(() => {
  resetSolarflowRuntime();
  mqttLibrary = createFakeMqttLibrary();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({
      deviceList: [FAKE_SOLARFLOW_DEVICE, FAKE_SECOND_SOLARFLOW_DEVICE],
    }),
    mqttLibrary,
    energyMeters: createTestEnergyMeters().meters,
    localFetchImpl: createFakeZenSdkFetch(),
  });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Counts its attempts: the tests mock Date.
async function waitFor(condition, attempts = 400) {
  for (let i = 0; i < attempts; i += 1) {
    const value = condition();
    if (value) {
      return value;
    }
    await delay(5);
  }
  throw new Error('waitFor timed out');
}

// --- Kind mapping ---------------------------------------------------------------

test('each alert kind reads its documented property, flat or under properties', () => {
  const cases = [
    ['heating', 'heatState'],
    ['calibration', 'socStatus'],
    ['low_temperature', 'lowTemperature'],
    ['reverse_flow', 'reverseState'],
  ];
  for (const [kind, property] of cases) {
    assert.deepEqual(ALERT_KINDS[kind].properties, [property]);
    assert.deepEqual(alertStateOf(kind, { [property]: 1 }), { active: true, value: 1 }, kind);
    assert.deepEqual(alertStateOf(kind, { properties: { [property]: 0 } }), {
      active: false,
      value: 0,
    });
    // Local MQTT values arrive as text.
    assert.deepEqual(alertStateOf(kind, { [property]: '1' }), { active: true, value: 1 });
    assert.equal(alertStateOf(kind, { electricLevel: 50 }), null, `${kind} not reported`);
  }
  assert.deepEqual(Object.keys(ALERT_KINDS).sort(), [
    'calibration',
    'fault',
    'heating',
    'low_temperature',
    'reverse_flow',
  ]);
});

test('a fault is is_error = 1 or a fault level above 0, valued by the level', () => {
  assert.equal(alertStateOf('fault', { electricLevel: 50 }), null);
  assert.deepEqual(alertStateOf('fault', { is_error: 0 }), { active: false, value: 0 });
  assert.deepEqual(alertStateOf('fault', { is_error: 1 }), { active: true, value: 1 });
  assert.deepEqual(alertStateOf('fault', { properties: { faultLevel: 3 } }), {
    active: true,
    value: 3,
  });
  assert.deepEqual(alertStateOf('fault', { is_error: 1, faultLevel: 0 }), {
    active: true,
    value: 0,
  });
  assert.deepEqual(alertStateOf('fault', { is_error: 0, faultLevel: 2 }), {
    active: true,
    value: 2,
  });
  assert.deepEqual(alertStateOf('fault', { is_error: 0, faultLevel: 0 }), {
    active: false,
    value: 0,
  });
});

// --- Edge detection and debounce -------------------------------------------------

test('the first value is the initial state: no event, even when the alert is on', () => {
  const tracker = createAlertTracker();
  assert.deepEqual(tracker.observe('A', { heatState: 1, socStatus: 0 }, 0), []);
  assert.deepEqual(tracker.observe('A', { heatState: 1, socStatus: 0 }, DELAY * 10), []);
});

test('a change fires once it held over two reports and the confirm delay', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { heatState: 0 }, 0);
  assert.deepEqual(tracker.observe('A', { heatState: 1 }, 1000), [], 'candidate');
  assert.deepEqual(tracker.observe('A', { heatState: 1 }, 1000 + DELAY - 1), [], 'too early');
  assert.deepEqual(tracker.observe('A', { heatState: 1 }, 1000 + DELAY), [
    { kind: 'heating', state: 'started', value: 1 },
  ]);
  // Once: a held state is not a new event.
  assert.deepEqual(tracker.observe('A', { heatState: 1 }, 1000 + DELAY * 3), []);
  // And the end, under the same rule.
  assert.deepEqual(tracker.observe('A', { heatState: 0 }, DELAY * 4), []);
  assert.deepEqual(tracker.observe('A', { heatState: 0 }, DELAY * 5), [
    { kind: 'heating', state: 'ended', value: 0 },
  ]);
});

test('a single report past the delay is not enough: it only opens the candidate', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { socStatus: 0 }, 0);
  assert.deepEqual(tracker.observe('A', { socStatus: 1 }, DELAY * 10), []);
  assert.deepEqual(tracker.observe('A', { socStatus: 1 }, DELAY * 11), [
    { kind: 'calibration', state: 'started', value: 1 },
  ]);
});

test('a flapping code never fires: a report of the stable state drops the candidate', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { reverseState: 0 }, 0);
  let now = 0;
  for (let i = 0; i < 20; i += 1) {
    now += DELAY / 2;
    assert.deepEqual(tracker.observe('A', { reverseState: i % 2 === 0 ? 1 : 0 }, now), []);
  }
});

test('reports without the code leave its state alone', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { electricLevel: 40 }, 0);
  // The first report WITH the code is its initial state.
  assert.deepEqual(tracker.observe('A', { lowTemperature: 1 }, 1000), []);
  tracker.observe('A', { lowTemperature: 0 }, 2000);
  assert.deepEqual(tracker.observe('A', { electricLevel: 41 }, 2000 + DELAY), []);
  assert.deepEqual(tracker.observe('A', { lowTemperature: 0 }, 2000 + DELAY), [
    { kind: 'low_temperature', state: 'ended', value: 0 },
  ]);
});

test('a fault level change while in fault is not a new event; the value is the latest', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { is_error: 0, faultLevel: 0 }, 0);
  tracker.observe('A', { is_error: 1, faultLevel: 1 }, 1000);
  assert.deepEqual(tracker.observe('A', { is_error: 1, faultLevel: 2 }, 1000 + DELAY), [
    { kind: 'fault', state: 'started', value: 2 },
  ]);
  assert.deepEqual(tracker.observe('A', { is_error: 1, faultLevel: 3 }, 1000 + DELAY * 2), []);
});

test('devices and kinds are tracked apart, and a forgotten device starts over silently', () => {
  const tracker = createAlertTracker();
  tracker.observe('A', { heatState: 0, socStatus: 0 }, 0);
  tracker.observe('B', { heatState: 1 }, 0);
  tracker.observe('A', { heatState: 1, socStatus: 1 }, 1000);
  tracker.observe('B', { heatState: 1 }, 1000);
  const transitions = tracker.observe('A', { heatState: 1, socStatus: 1 }, 1000 + DELAY);
  assert.deepEqual(
    transitions.map((transition) => transition.kind),
    ['heating', 'calibration'],
  );
  assert.deepEqual(tracker.observe('B', { heatState: 1 }, 1000 + DELAY), []);

  tracker.forget('A');
  assert.deepEqual(tracker.observe('A', { heatState: 0 }, DELAY * 5), []);
  assert.deepEqual(tracker.observe('A', { heatState: 0 }, DELAY * 7), []);
});

// --- Through the push listener --------------------------------------------------

/** Discover, start the cloud push, and give a reporter per battery. */
async function startCloud(gladys) {
  const devices = await buildDiscoveredDevices(gladys, config);
  stopPush = solarflow.startPush(gladys, config);
  const client = await waitFor(() => mqttLibrary.clients[0]);
  await delay(20);
  const reporterOf =
    ({ productKey, deviceKey }) =>
    (properties, extra = {}) =>
      client.emit(
        'message',
        `iot/${productKey}/${deviceKey}/properties/report`,
        Buffer.from(JSON.stringify({ properties, ...extra })),
      );
  return { devices, reporterOf };
}

test('a cloud report sequence fires battery_alert with the reachability-like payload', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const gladys = createFakeGladys();
  const { devices, reporterOf } = await startCloud(gladys);
  const report = reporterOf(FAKE_SOLARFLOW_DEVICE);

  // Heating already on at startup: not an event.
  report({ heatState: 1, is_error: 0, faultLevel: 0 });
  t.mock.timers.tick(DELAY);
  report({ heatState: 1, is_error: 0, faultLevel: 0 });
  await delay(10);
  assert.deepEqual(gladys.sceneEvents, []);

  // A fault appears and holds.
  report({ heatState: 1, is_error: 1, faultLevel: 2 });
  t.mock.timers.tick(DELAY);
  report({ heatState: 1, is_error: 1, faultLevel: 2 });
  await waitFor(() => gladys.sceneEvents.length === 1);
  assert.deepEqual(gladys.sceneEvents[0], {
    key: ALERT_TRIGGER,
    data: {
      device: devices[0].external_id,
      kind: 'fault',
      state: 'started',
      device_name: FAKE_SOLARFLOW_DEVICE.deviceName,
      value: 2,
      source: 'cloud',
    },
  });

  // The heating stops: its end is an event too.
  report({ heatState: 0 });
  t.mock.timers.tick(DELAY);
  report({ heatState: 0 });
  await waitFor(() => gladys.sceneEvents.length === 2);
  assert.deepEqual(
    { kind: gladys.sceneEvents[1].data.kind, state: gladys.sceneEvents[1].data.state },
    { kind: 'heating', state: 'ended' },
  );
});

test('the heating of a pack (packData) is not a battery alert', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const gladys = createFakeGladys();
  const { reporterOf } = await startCloud(gladys);
  const report = reporterOf(FAKE_SOLARFLOW_DEVICE);
  const packs = (heatState) => ({ packData: [{ sn: 'PACK1', socLevel: 50, heatState }] });

  report({ electricLevel: 50 }, packs(0));
  t.mock.timers.tick(DELAY);
  report({ electricLevel: 50 }, packs(1));
  t.mock.timers.tick(DELAY);
  report({ electricLevel: 50 }, packs(1));
  await delay(10);
  assert.deepEqual(gladys.sceneEvents, []);
});

test('a battery deleted in Gladys fires no alert', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const gladys = createFakeGladys();
  const { devices, reporterOf } = await startCloud(gladys);
  const kept = reporterOf(FAKE_SOLARFLOW_DEVICE);
  const deleted = reporterOf(FAKE_SECOND_SOLARFLOW_DEVICE);
  kept({ socStatus: 0 });
  deleted({ socStatus: 0 });

  t.mock.method(console, 'log', () => {});
  const deletedDevice = devices.find((device) =>
    device.external_id.endsWith(FAKE_SECOND_SOLARFLOW_DEVICE.deviceKey),
  );
  assert.equal(await handleDeviceDeleted(gladys, config, deletedDevice), true);

  for (const report of [kept, deleted]) {
    report({ socStatus: 1 });
  }
  t.mock.timers.tick(DELAY);
  for (const report of [kept, deleted]) {
    report({ socStatus: 1 });
  }
  await waitFor(() => gladys.sceneEvents.length === 1);
  await delay(10);
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].data.device_name, FAKE_SOLARFLOW_DEVICE.deviceName);
  assert.equal(gladys.sceneEvents[0].data.kind, 'calibration');
});

test('an alert seen on the local API has the source "local"', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const host = FAKE_HTTP_SOLARFLOW_DEVICE.ip;
  const zenSdk = createFakeZenSdkFetch({
    reports: { [host]: { ...FAKE_HTTP_REPORT, properties: { ...FAKE_HTTP_REPORT.properties } } },
  });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_HTTP_SOLARFLOW_DEVICE] }),
    localFetchImpl: zenSdk,
  });
  const gladys = createFakeGladys();
  await buildDiscoveredDevices(gladys, config);
  stopPush = solarflow.startPush(gladys, config);
  await waitFor(() => zenSdk.calls.length > 0);
  await delay(30);
  const withLowTemperature = (lowTemperature) => ({
    ...FAKE_HTTP_REPORT,
    properties: { ...FAKE_HTTP_REPORT.properties, lowTemperature },
  });

  zenSdk.setReport(host, withLowTemperature(0));
  await pollLocalHttpNow();
  zenSdk.setReport(host, withLowTemperature(1));
  await pollLocalHttpNow();
  t.mock.timers.tick(DELAY);
  await pollLocalHttpNow();
  await waitFor(() => gladys.sceneEvents.length === 1);
  assert.equal(gladys.sceneEvents[0].key, ALERT_TRIGGER);
  assert.equal(gladys.sceneEvents[0].data.kind, 'low_temperature');
  assert.equal(gladys.sceneEvents[0].data.state, 'started');
  assert.equal(gladys.sceneEvents[0].data.value, 1);
  assert.equal(gladys.sceneEvents[0].data.source, 'local');
});
