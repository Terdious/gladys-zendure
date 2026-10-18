// -----------------------------------------------------------------------------
// The site widgets (`site`, `energy_today`): pure content builders over
// battery snapshots (the shape describeBatteries returns), the phase
// assignment, the local day of a timezone, and the widget handlers end to
// end on the fake runtime. Every content goes through the SDK validator: []
// means the core renders it exactly as sent (no budget drop, no truncation).
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { WIDGETS, SITE_WIDGET, ENERGY_TODAY_WIDGET } from '../src/widgets.js';
import {
  DEFAULT_TIMEZONE,
  LAYOUTS,
  PHASE_SETTINGS,
  resolveTimezone,
  siteSelection,
  startOfLocalDay,
} from '../src/dashboard/common.js';
import {
  DEFAULT_IMBALANCE_THRESHOLD,
  siteContent,
  siteRemainingTime,
  sourceCounts,
} from '../src/dashboard/site.js';
import { energyTodayContent } from '../src/dashboard/energyToday.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  applySavingsTariff,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { buildTariff } from '../src/zendure/savings.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createTestEnergyMeters,
  createFakeZenSdkFetch,
  FAKE_CLOUD_KEY,
  FAKE_SOLARFLOW_DEVICE,
  FAKE_SECOND_SOLARFLOW_DEVICE,
  FAKE_HTTP_SOLARFLOW_DEVICE,
  FAKE_HTTP_REPORT,
} from './helpers/fakeZendure.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const widgetOf = (key) => manifest.widgets.find((widget) => widget.key === key);
const settingOf = (widgetKey, key) => widgetOf(widgetKey).settings.find((s) => s.key === key);

// --- Battery snapshots ---------------------------------------------------------

const MODELS = {
  ac2400: { model: 'SolarFlow 2400 AC', hasSolar: false, capacityKwh: 2.4 },
  pro2400: { model: 'SolarFlow 2400 Pro', hasSolar: true, capacityKwh: 2.4 },
  pro800: { model: 'SolarFlow 800 Pro', hasSolar: true, capacityKwh: 1.92 },
  sf800: { model: 'SolarFlow 800', hasSolar: true, capacityKwh: null, hasBattery: false },
};

/** One snapshot as describeBatteries builds it. */
function snapshot(id, kind, overrides = {}) {
  const { values: valueOverrides, settings: settingOverrides, ...rest } = overrides;
  const base = MODELS[kind];
  const values = {
    batteryLevel: base.hasBattery === false ? null : 50,
    batteryInputPower: 0, // discharge
    batteryOutputPower: 0, // charge
    homeOutputPower: 0,
    solarInputPower: base.hasSolar ? 0 : null,
    ...valueOverrides,
  };
  const capacityKwh = base.capacityKwh;
  return {
    externalId: `ext:zendure:solarflow:${id}`,
    name: id,
    model: base.model,
    source: 'http',
    degraded: false,
    values,
    hasBattery: base.hasBattery ?? true,
    hasSolar: base.hasSolar,
    capacityKwh,
    remainingKwh:
      capacityKwh !== null && values.batteryLevel !== null
        ? Math.round(values.batteryLevel * capacityKwh) / 100
        : null,
    remainingTime: null,
    settings: {
      outputLimit: 800,
      inputLimit: 800,
      acMode: 2,
      socSet: 100,
      minSoc: 10,
      ...settingOverrides,
    },
    energyReady: true,
    energySince: () => null,
    ...rest,
  };
}

/** The user's site: 17 devices on three phases. */
function threePhaseSite() {
  const l1 = [
    snapshot('AC-1', 'ac2400', {
      values: { batteryLevel: 80, batteryInputPower: 600, homeOutputPower: 600 },
    }),
    snapshot('AC-2', 'ac2400', {
      values: { batteryLevel: 60, batteryInputPower: 400, homeOutputPower: 400 },
    }),
    snapshot('PRO-1', 'pro2400', {
      values: {
        batteryLevel: 70,
        solarInputPower: 900,
        batteryOutputPower: 500,
        homeOutputPower: 400,
      },
    }),
    snapshot('P8-1', 'pro800', {
      values: { batteryLevel: 40, homeOutputPower: 100, solarInputPower: 100 },
    }),
    snapshot('P8-2', 'pro800', {
      values: { batteryLevel: 40, homeOutputPower: 100, solarInputPower: 100 },
    }),
    snapshot('INV-1', 'sf800', { values: { solarInputPower: 300, homeOutputPower: 290 } }),
  ];
  const l2 = [
    snapshot('AC-3', 'ac2400', {
      values: { batteryLevel: 50, batteryInputPower: 300, homeOutputPower: 300 },
    }),
    snapshot('AC-4', 'ac2400', { source: 'cloud', degraded: true, values: { batteryLevel: 50 } }),
    snapshot('PRO-2', 'pro2400', {
      values: { batteryLevel: 50, solarInputPower: 600, homeOutputPower: 600 },
    }),
    snapshot('P8-3', 'pro800', { values: { batteryLevel: 50 } }),
    snapshot('P8-4', 'pro800', { values: { batteryLevel: 50 } }),
    snapshot('INV-2', 'sf800', { values: { solarInputPower: 200, homeOutputPower: 190 } }),
  ];
  const l3 = [
    snapshot('AC-5', 'ac2400', { values: { batteryLevel: 30, batteryOutputPower: 1200 } }),
    snapshot('PRO-3', 'pro2400', {
      values: { batteryLevel: 30, solarInputPower: 400, homeOutputPower: 400 },
    }),
    // Unreachable: its last powers are stale, left out of the sums.
    snapshot('P8-5', 'pro800', {
      source: 'unreachable',
      values: { batteryLevel: 20, homeOutputPower: 777 },
    }),
    snapshot('P8-6', 'pro800', { values: { batteryLevel: 30 } }),
    snapshot('INV-3', 'sf800', { values: { solarInputPower: 0, homeOutputPower: 0 } }),
  ];
  const all = [...l1, ...l2, ...l3];
  const ids = (list) => list.map((battery) => battery.externalId);
  return {
    all,
    settings: {
      layout: LAYOUTS.THREE_PHASE,
      phase_l1: ids(l1),
      phase_l2: ids(l2),
      phase_l3: ids(l3),
      imbalance_threshold: 500,
    },
  };
}

const tilesOf = (content) =>
  Object.fromEntries(
    content.components
      .filter((c) => c.type === 'value' || c.type === 'gauge')
      .map((c) => [c.label.en, c.value]),
  );
const rowsOf = (content) => content.components.find((c) => c.type === 'status').items;
const rowOf = (content, en) =>
  rowsOf(content).find((row) =>
    (typeof row.label === 'string' ? row.label : row.label.en).startsWith(en),
  );
const en = (text) => (typeof text === 'string' ? text : text.en);

// --- Manifest ties ---------------------------------------------------------------

test('the site widgets settings match the code: layouts, phase keys, defaults', () => {
  for (const key of [SITE_WIDGET, ENERGY_TODAY_WIDGET]) {
    const keys = widgetOf(key).settings.map((s) => s.key);
    for (const phase of PHASE_SETTINGS) {
      assert.ok(keys.includes(phase.key), `${key}.${phase.key}`);
      assert.equal(settingOf(key, phase.key).source, 'devices');
    }
    assert.deepEqual(
      settingOf(key, 'layout').options.map((o) => o.value),
      Object.values(LAYOUTS),
    );
    assert.equal(settingOf(key, 'layout').default, LAYOUTS.SINGLE_PHASE);
  }
  assert.equal(settingOf(SITE_WIDGET, 'imbalance_threshold').default, DEFAULT_IMBALANCE_THRESHOLD);
  assert.equal(settingOf(ENERGY_TODAY_WIDGET, 'timezone').default, DEFAULT_TIMEZONE);
});

// --- Site widget, three-phase ----------------------------------------------------

test('three-phase site: per-phase rows, balance warning, site totals, sources', () => {
  const { all, settings } = threePhaseSite();
  const selection = siteSelection(all, settings);
  const content = siteContent('My site', selection, { threshold: 500 });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.length, 8);

  const tiles = tilesOf(content);
  // Unreachable P8-5 (777 W) left out of the home output.
  assert.equal(tiles['To the home'], 600 + 400 + 400 + 100 + 100 + 290 + 300 + 600 + 190 + 400);
  assert.equal(tiles.Charging, 500 + 1200);
  assert.equal(tiles.Discharging, 600 + 400 + 300);
  assert.equal(tiles.Solar, 900 + 100 + 100 + 300 + 600 + 200 + 400);
  // Capacity-weighted level over the 14 packs (the three SF 800 have none).
  const packs = all.filter((b) => b.hasBattery);
  const capacity = packs.reduce((t, b) => t + b.capacityKwh, 0);
  const weighted = packs.reduce((t, b) => t + b.values.batteryLevel * b.capacityKwh, 0) / capacity;
  assert.equal(tiles.Battery, Math.round(weighted));
  assert.equal(tiles.Stored, Math.round(packs.reduce((t, b) => t + b.remainingKwh, 0) * 100) / 100);

  const l1 = rowOf(content, 'L1');
  assert.equal(l1.label, 'L1 (6) · 60 %');
  assert.equal(l1.value, '⌂ 1890 · ↑ 500 · ↓ 1000 · ☀ 1400 W');
  assert.equal(rowOf(content, 'L3').color, 'warning', 'one battery of L3 is unreachable');
  const balance = rowOf(content, 'Phase balance');
  // L1 1890 W, L2 1090 W, L3 400 W: 1490 W apart, over the 500 W threshold.
  assert.equal(balance.value.en, 'Δ 1490 W · L1 highest');
  assert.equal(balance.color, 'warning');
  assert.equal(rowOf(content, 'Sources').value.en, '15 local · 1 cloud · 1 unreachable');
  assert.equal(rowOf(content, 'Sources').color, 'danger');
  assert.equal(rowOf(content, 'Unreachable').value, '1: P8-5');
  assert.equal(rowOf(content, 'Cloud fallback').value, '1: AC-4');
  assert.match(en(rowOf(content, 'Stored / capacity').value), /^\d+(\.\d+)? \/ 30\.72 kWh$/);
  // Net discharge: 1300 W out, 1700 W in => charging.
  assert.ok(rowOf(content, 'Full in'));
  assert.deepEqual(sourceCounts(all), { local: 15, cloud: 1, unreachable: 1 });
});

test('three-phase site: a balanced site, under the threshold, is a success', () => {
  const batteries = ['A', 'B', 'C'].map((id, i) =>
    snapshot(id, 'pro800', { values: { homeOutputPower: 300 + i * 50 } }),
  );
  const selection = siteSelection(batteries, {
    layout: 'three_phase',
    phase_l1: [batteries[0].externalId],
    phase_l2: [batteries[1].externalId],
    phase_l3: [batteries[2].externalId],
  });
  const content = siteContent('Site', selection, { threshold: 500 });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(rowOf(content, 'Phase balance').color, 'success');
  assert.equal(rowOf(content, 'Phase balance').value.en, 'Δ 100 W · L3 highest');
});

test('three-phase assignment mistakes: twice, nowhere, deleted device', () => {
  const batteries = ['A', 'B', 'C', 'D'].map((id) => snapshot(id, 'pro800'));
  const [a, b, c] = batteries.map((battery) => battery.externalId);
  const selection = siteSelection(batteries, {
    layout: 'three_phase',
    phase_l1: [a, b],
    phase_l2: [b, 'ext:zendure:solarflow:gone'],
    phase_l3: [c],
  });
  assert.deepEqual(
    selection.phases.map((phase) => phase.batteries.map((battery) => battery.name)),
    [['A', 'B'], [], ['C']],
  );
  const content = siteContent('Site', selection);
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(rowOf(content, 'L2').value.en, 'No battery');
  assert.equal(rowOf(content, 'In several phases').value, '1: B');
  assert.equal(rowOf(content, 'In no phase').value, '1: D');
  assert.equal(rowOf(content, 'Not found').value.en, '1 selected device(s)');
});

test('the site status never exceeds the 10 rows the core keeps', () => {
  const { all, settings } = threePhaseSite();
  // Every battery unreachable or in fallback, some twice, some nowhere.
  const broken = all.map((battery, i) =>
    i % 2 ? { ...battery, source: 'unreachable' } : { ...battery, source: 'cloud', degraded: true },
  );
  const selection = siteSelection(broken, {
    ...settings,
    phase_l3: [...settings.phase_l1.slice(0, 2), 'ext:zendure:solarflow:gone'],
  });
  const content = siteContent('Site', selection);
  assert.deepEqual(validateWidgetContent(content), []);
  const rows = rowsOf(content);
  assert.equal(rows.length, 10);
  assert.match(rows[9].label.en, /^\+\d+ more$/);
});

test('site remaining time: the energy to the floors over the net power', () => {
  // 2 x 2.4 kWh at 60 %, floor 10 %: 2.4 kWh to give at 1200 W = 2 h.
  const batteries = ['A', 'B'].map((id) =>
    snapshot(id, 'ac2400', { values: { batteryLevel: 60, batteryInputPower: 600 } }),
  );
  assert.deepEqual(siteRemainingTime(batteries), { direction: 'discharge', minutes: 120 });
  // Charging to 100 % at 960 W: 2 x 0.96 kWh = 2 h.
  const charging = ['A', 'B'].map((id) =>
    snapshot(id, 'ac2400', { values: { batteryLevel: 60, batteryOutputPower: 480 } }),
  );
  assert.deepEqual(siteRemainingTime(charging), { direction: 'charge', minutes: 120 });
  assert.equal(siteRemainingTime([snapshot('idle', 'ac2400')]), null);
  // Unknown limits: no estimate rather than a wrong one.
  const unknown = [
    snapshot('U', 'ac2400', { values: { batteryInputPower: 500 }, settings: { minSoc: null } }),
  ];
  assert.equal(siteRemainingTime(unknown), null);
});

test('single-phase site: one total, no phase rows; AC-only and pack-less rules', () => {
  const batteries = [
    snapshot('AC', 'ac2400', {
      values: { batteryLevel: 80, batteryInputPower: 500, homeOutputPower: 500 },
    }),
    snapshot('INV', 'sf800', { values: { solarInputPower: 250, homeOutputPower: 240 } }),
  ];
  const content = siteContent('Site', siteSelection(batteries, {}));
  assert.deepEqual(validateWidgetContent(content), []);
  const tiles = tilesOf(content);
  assert.equal(tiles.Battery, 80, 'the pack-less inverter stays out of the level');
  assert.equal(tiles['To the home'], 740);
  assert.equal(tiles.Solar, 250);
  assert.equal(tiles.Stored, 1.92);
  assert.equal(rowOf(content, 'L1'), undefined);
  assert.equal(rowOf(content, 'Phase balance'), undefined);

  // AC-coupled only: no solar figure at all; pack-less only: no battery figure.
  const acOnly = siteContent('Site', siteSelection([batteries[0]], {}));
  assert.ok(!('Solar' in tilesOf(acOnly)));
  const inverters = siteContent('Site', siteSelection([batteries[1]], {}));
  assert.deepEqual(Object.keys(tilesOf(inverters)), ['Solar', 'To the home']);
  assert.equal(rowOf(inverters, 'Stored'), undefined);
  assert.deepEqual(validateWidgetContent(inverters), []);
});

// --- Local day -------------------------------------------------------------------

test('the local midnight follows the timezone and its clock changes', () => {
  const at = (iso) => new Date(iso).getTime();
  // Summer time (UTC+2).
  assert.equal(
    startOfLocalDay(at('2026-10-17T12:00:00Z'), 'Europe/Paris'),
    at('2026-10-16T22:00:00Z'),
  );
  // Back to winter time on 2026-10-25: the day starts in summer time.
  assert.equal(
    startOfLocalDay(at('2026-10-25T12:00:00Z'), 'Europe/Paris'),
    at('2026-10-24T22:00:00Z'),
  );
  // Spring forward on 2026-03-29: the day starts in winter time.
  assert.equal(
    startOfLocalDay(at('2026-03-29T12:00:00Z'), 'Europe/Paris'),
    at('2026-03-28T23:00:00Z'),
  );
  // Just after midnight, a half-hour offset, and UTC.
  assert.equal(
    startOfLocalDay(at('2026-10-16T22:10:00Z'), 'Europe/Paris'),
    at('2026-10-16T22:00:00Z'),
  );
  assert.equal(
    startOfLocalDay(at('2026-10-17T12:00:00Z'), 'Asia/Kolkata'),
    at('2026-10-16T18:30:00Z'),
  );
  assert.equal(startOfLocalDay(at('2026-10-17T12:00:00Z'), 'UTC'), at('2026-10-17T00:00:00Z'));
  assert.equal(resolveTimezone('America/Toronto'), 'America/Toronto');
  assert.equal(resolveTimezone('Not/AZone'), DEFAULT_TIMEZONE);
  assert.equal(resolveTimezone(''), DEFAULT_TIMEZONE);
});

// --- Energy today ----------------------------------------------------------------

const MINUTE = 60 * 1000;
const NOW = new Date('2026-10-17T10:00:00Z').getTime(); // 12:00 in Paris
const MIDNIGHT = new Date('2026-10-16T22:00:00Z').getTime();

/** Snapshots wired to real meters, fed with a constant power profile. */
function meteredSite(profile, { from = MIDNIGHT - 60 * MINUTE } = {}) {
  const { meters } = createTestEnergyMeters();
  for (let at = from; at <= NOW; at += 5 * MINUTE) {
    for (const { id, powers } of profile) {
      meters.update(id, powers, at);
    }
  }
  return profile.map(({ id, kind }) =>
    snapshot(id, kind, { energySince: (since) => meters.energySince(id, since) }),
  );
}

test('energy today: per phase, since the local midnight, with a 30-minute chart', () => {
  const batteries = meteredSite([
    {
      id: 'A',
      kind: 'pro2400',
      powers: { homeOutputPower: 600, solarInputPower: 1000, batteryOutputPower: 400 },
    },
    { id: 'B', kind: 'ac2400', powers: { homeOutputPower: 300, batteryInputPower: 300 } },
    { id: 'C', kind: 'sf800', powers: { homeOutputPower: 150, solarInputPower: 160 } },
  ]);
  const [a, b, c] = batteries.map((battery) => battery.externalId);
  const selection = siteSelection(batteries, {
    layout: 'three_phase',
    phase_l1: [a],
    phase_l2: [b],
    phase_l3: [c],
  });
  const content = energyTodayContent('Energy today', selection, {
    now: NOW,
    timeZone: 'Europe/Paris',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const tiles = tilesOf(content);
  // 12 h since midnight (the hour before is yesterday's).
  assert.equal(tiles['To the home'], 12.6); // 12 h x (600 + 300 + 150) W
  assert.equal(tiles.Solar, 13.92); // 12 h x (1000 + 160) W
  assert.equal(tiles.Charged, 4.8);
  assert.equal(tiles.Discharged, 3.6);
  assert.equal(rowOf(content, 'L1').value, '⌂ 7.2 · ↑ 4.8 · ↓ 0 · ☀ 12 kWh');
  assert.equal(rowOf(content, 'L3').value, '⌂ 1.8 · ☀ 1.9 kWh');
  assert.equal(rowOf(content, 'Phase balance').value.en, 'Δ 5.4 kWh · L1 highest');
  assert.equal(rowOf(content, 'Counted since').value, '00:00 · Europe/Paris');

  const chart = content.components.find((c) => c.type === 'chart');
  assert.deepEqual(
    chart.series.map((s) => s.name),
    ['L1', 'L2', 'L3'],
  );
  // 24 full slots and the one just started: 300 Wh per slot at 600 W.
  assert.equal(chart.series[0].points.length, 25);
  assert.deepEqual(chart.series[0].points[0], { t: '2026-10-16T22:00:00.000Z', v: 300 });
});

test('energy today: counted since the first data of the day, single-phase', () => {
  // The integration was installed at 08:12 Paris time.
  const batteries = meteredSite(
    [{ id: 'A', kind: 'ac2400', powers: { homeOutputPower: 800, batteryInputPower: 800 } }],
    { from: new Date('2026-10-17T06:12:00Z').getTime() },
  );
  const content = energyTodayContent('Today', siteSelection(batteries, {}), {
    now: NOW,
    timeZone: 'Europe/Paris',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(rowOf(content, 'Counted since').value, '08:00 · Europe/Paris');
  assert.equal(rowOf(content, 'Counted since').color, 'info');
  assert.ok(!('Solar' in tilesOf(content)), 'AC-coupled: no solar tile');
  assert.equal(content.components.find((c) => c.type === 'chart').series.length, 1);

  // No data today at all: zeros, and the row says so.
  const silent = energyTodayContent('Today', siteSelection([snapshot('S', 'pro800')], {}), {
    now: NOW,
    timeZone: 'Europe/Paris',
  });
  assert.deepEqual(validateWidgetContent(silent), []);
  assert.equal(rowOf(silent, 'Counted since').value.en, 'No data today');
  assert.equal(
    silent.components.find((c) => c.type === 'chart'),
    undefined,
  );
});

// --- Handlers on the fake runtime ------------------------------------------------

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
    localFetchImpl: createFakeZenSdkFetch(),
  });
});

test('the site handler: every battery by default, phases from the settings', async () => {
  const devices = await buildDiscoveredDevices(gladys, config);
  const all = await WIDGETS[SITE_WIDGET].get(gladys, { settings: {}, config });
  assert.deepEqual(validateWidgetContent(all), []);
  assert.equal(all.components[0].text.en, 'Zendure site');
  assert.equal(tilesOf(all).Solar, 560);

  const three = await WIDGETS[SITE_WIDGET].get(gladys, {
    settings: {
      title: 'Home',
      layout: 'three_phase',
      phase_l1: [devices[0].external_id],
      phase_l2: [devices[1].external_id],
      phase_l3: [],
      imbalance_threshold: 100,
    },
    config,
  });
  assert.deepEqual(validateWidgetContent(three), []);
  assert.equal(three.components[0].text, 'Home');
  assert.equal(rowOf(three, 'L3').value.en, 'No battery');
  assert.ok(rowOf(three, 'Phase balance'));

  const unassigned = await WIDGETS[SITE_WIDGET].get(gladys, {
    settings: { layout: 'three_phase' },
    config,
  });
  assert.deepEqual(validateWidgetContent(unassigned), []);
  assert.match(unassigned.components[0].text.en, /Assign the batteries of each phase/);
});

test('the energy handler waits for the meters, then counts the local API reports', async () => {
  const before = await WIDGETS[ENERGY_TODAY_WIDGET].get(gladys, { settings: {}, config });
  assert.deepEqual(validateWidgetContent(before), []);
  assert.match(before.components[0].text.en, /energy meters are loading/);

  resetSolarflowRuntime();
  const zenSdk = createFakeZenSdkFetch({
    reports: { [FAKE_HTTP_SOLARFLOW_DEVICE.ip]: FAKE_HTTP_REPORT },
  });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_HTTP_SOLARFLOW_DEVICE] }),
    mqttLibrary,
    localFetchImpl: zenSdk,
    energyMeters: createTestEnergyMeters().meters,
  });
  await buildDiscoveredDevices(gladys, config);
  const stop = solarflow.startPush(gladys, config);
  for (let i = 0; i < 200 && zenSdk.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const content = await WIDGETS[ENERGY_TODAY_WIDGET].get(gladys, {
    settings: { timezone: 'UTC' },
    config,
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].text.en, 'Energy today');
  assert.match(rowOf(content, 'Counted since').value, / · UTC$/);
  stop();
});

// --- Energy today: the savings estimate ----------------------------------------

/** Snapshots wired to real meters with a tariff, like meteredSite. */
function savingsSite(profile, tariffConfig) {
  const { meters } = createTestEnergyMeters();
  const { tariff } = buildTariff(normalizeConfig(tariffConfig));
  meters.setTariff(tariff);
  for (let at = MIDNIGHT - 60 * MINUTE; at <= NOW; at += 5 * MINUTE) {
    for (const { id, powers } of profile) {
      meters.update(id, powers, at);
    }
  }
  return {
    tariff,
    batteries: profile.map(({ id, kind }) =>
      snapshot(id, kind, {
        energySince: (since) => meters.energySince(id, since),
        savingsAt: (now) => meters.savingsOf(id, now),
      }),
    ),
  };
}

const BASE_TARIFF = { tariff_mode: 'base', price_base: 0.2 };

test('energy today: the savings tile and rows, marked as an estimate', () => {
  const { tariff, batteries } = savingsSite(
    [
      {
        id: 'A',
        kind: 'pro2400',
        powers: { homeOutputPower: 600, solarInputPower: 1000, batteryOutputPower: 400 },
      },
      { id: 'B', kind: 'ac2400', powers: { homeOutputPower: 300, batteryInputPower: 300 } },
    ],
    BASE_TARIFF,
  );
  const content = energyTodayContent('Energy today', siteSelection(batteries, {}), {
    now: NOW,
    timeZone: 'Europe/Paris',
    savings: { tariff, tariffError: null },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(content.components.length <= 8);
  const tiles = tilesOf(content);
  // 12 h today: A sends 600 W of solar straight to the home, B 300 W out of
  // its pack (stored before the tariff: valued at 0, the opportunity cost).
  // (7.2 + 3.6) kWh x 0.20. The month also holds the hour before midnight.
  assert.equal(tiles['Saved today (estimate)'], 2.16);
  assert.match(rowOf(content, 'Savings (estimate)').value.en, /^Month 2\.34 € · Year 2\.34 €$/);
  assert.equal(rowOf(content, 'Battery time-shift').value, '0.72 € · 3.6 kWh');
  assert.equal(rowOf(content, 'Direct solar').value, '1.44 € · 7.2 kWh');
  assert.equal(rowOf(content, 'Grid charging (paid)').value, '0.00 € · 0 kWh');
  assert.equal(rowOf(content, 'Exported, not valued').value.en, '0 kWh: grid meter (soon)');
  assert.ok(rowOf(content, 'Counted since'), 'the energy rows stay');

  // Resale on: the export row says the revenue needs the grid meter.
  const resale = savingsSite(
    [{ id: 'A', kind: 'pro2400', powers: { homeOutputPower: 600, solarInputPower: 600 } }],
    { ...BASE_TARIFF, resale_enabled: true, resale_price: 0.04 },
  );
  const sold = energyTodayContent('Energy today', siteSelection(resale.batteries, {}), {
    now: NOW,
    timeZone: 'Europe/Paris',
    savings: { tariff: resale.tariff, tariffError: null },
  });
  assert.deepEqual(validateWidgetContent(sold), []);
  assert.equal(rowOf(sold, 'Resale').value.en, 'Needs the grid meter (soon)');
  assert.equal(rowOf(sold, 'Exported, not valued'), undefined);
});

test('energy today: three-phase savings per phase, within the status budget', () => {
  const { tariff, batteries } = savingsSite(
    [
      { id: 'A', kind: 'pro2400', powers: { homeOutputPower: 600, solarInputPower: 600 } },
      { id: 'B', kind: 'ac2400', powers: { homeOutputPower: 300, batteryInputPower: 300 } },
      { id: 'C', kind: 'sf800', powers: { homeOutputPower: 150, solarInputPower: 160 } },
      { id: 'D', kind: 'pro800', powers: { homeOutputPower: 100, solarInputPower: 100 } },
    ],
    {
      ...BASE_TARIFF,
      tariff_mode: 'peak_offpeak',
      price_peak: 0.2,
      price_offpeak: 0.1,
      offpeak_hours: '22:00-06:00',
    },
  );
  const [a, b, c] = batteries.map((battery) => battery.externalId);
  // Worst case: every alert row (a missing device, a duplicate, D unassigned).
  const selection = siteSelection(batteries, {
    layout: 'three_phase',
    phase_l1: [a, 'ext:zendure:solarflow:gone'],
    phase_l2: [b, a],
    phase_l3: [c],
  });
  const content = energyTodayContent('Energy today', selection, {
    now: NOW,
    timeZone: 'Europe/Paris',
    savings: { tariff, tariffError: null },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const rows = rowsOf(content);
  assert.ok(rows.length <= 10);
  assert.ok(!rows.some((row) => en(row.label).startsWith('+')), 'nothing hidden behind "+N"');
  // 6 h off-peak (0.10) then 6 h peak (0.20): L1 600 W of solar to the
  // home, L2 300 W out of a pack stored before the tariff (cost 0), L3 150 W.
  assert.equal(rowOf(content, 'Today L1 · L2 · L3').value, '1.08 € · 0.54 € · 0.27 €');
  for (const label of ['Not found', 'In several phases', 'In no phase', 'Counted since']) {
    assert.ok(rowOf(content, label), `${label} kept`);
  }
  assert.ok(rowOf(content, 'Savings (estimate)'));
});

test('the energy handler: savings with a tariff, off per instance, a warning when invalid', async () => {
  const zenSdk = createFakeZenSdkFetch({
    reports: { [FAKE_HTTP_SOLARFLOW_DEVICE.ip]: FAKE_HTTP_REPORT },
  });
  resetSolarflowRuntime();
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList: [FAKE_HTTP_SOLARFLOW_DEVICE] }),
    mqttLibrary,
    localFetchImpl: zenSdk,
    energyMeters: createTestEnergyMeters().meters,
  });
  const withTariff = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, ...BASE_TARIFF });
  await buildDiscoveredDevices(gladys, withTariff);
  const stop = solarflow.startPush(gladys, withTariff);
  for (let i = 0; i < 200 && zenSdk.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const get = (settings, cfg) =>
    WIDGETS[ENERGY_TODAY_WIDGET].get(gladys, { settings, config: cfg });

  const shown = await get({}, withTariff);
  assert.deepEqual(validateWidgetContent(shown), []);
  assert.ok('Saved today (estimate)' in tilesOf(shown));
  assert.ok(rowOf(shown, 'Savings (estimate)'));

  const hidden = await get({ show_savings: false }, withTariff);
  assert.ok(!('Saved today (estimate)' in tilesOf(hidden)));
  assert.equal(rowOf(hidden, 'Savings (estimate)'), undefined);

  const none = await get({}, config);
  assert.equal(rowOf(none, 'Savings (estimate)'), undefined);

  const invalid = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, tariff_mode: 'base' });
  applySavingsTariff(invalid);
  const warned = await get({}, invalid);
  assert.deepEqual(validateWidgetContent(warned), []);
  assert.equal(rowOf(warned, 'Savings (estimate)').value.en, 'Tariff invalid: see the logs');
  assert.equal(rowOf(warned, 'Savings (estimate)').color, 'warning');
  stop();
});

test('the show_savings setting is declared on the energy widget, on by default', () => {
  const setting = settingOf(ENERGY_TODAY_WIDGET, 'show_savings');
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, true);
  assert.equal(manifest.widgets.length, 4, 'no new widget (the store allows 5)');
});
