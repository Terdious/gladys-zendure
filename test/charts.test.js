// Live charts of the dashboard widgets (src/dashboard/charts.js), the 5-minute
// history of the energy meters behind them, the order of the group list and
// the chart setting of the "Energy today" widget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import {
  CHART_HOURS,
  DEFAULT_CHART_HOURS,
  LIVE_CHARTS,
  SORTS,
  chartHoursOf,
  historyOf,
  liveChart,
  sortBatteries,
} from '../src/dashboard/charts.js';
import { LAYOUTS } from '../src/dashboard/common.js';
import { ENERGY_CHARTS, energyTodayContent } from '../src/dashboard/energyToday.js';
import { siteContent } from '../src/dashboard/site.js';
import { groupContent } from '../src/widgets.js';
import { HISTORY_RETENTION_IN_MS, HISTORY_STEP_IN_MS } from '../src/zendure/energy.js';
import { createTestEnergyMeters } from './helpers/fakeZendure.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const settingOf = (widgetKey, key) =>
  manifest.widgets.find((widget) => widget.key === widgetKey).settings.find((s) => s.key === key);

const MINUTE = 60 * 1000;
const NOW = new Date('2026-10-17T10:00:00Z').getTime();

/** A battery snapshot with a metered history (power profile held steady). */
function metered(meters, id, { powers, level = 50, capacityKwh = 2.4, hasSolar = true }) {
  return {
    externalId: `ext:zendure:solarflow:${id}`,
    name: id,
    source: 'http',
    degraded: false,
    values: {
      batteryLevel: level,
      batteryOutputPower: powers.batteryOutputPower ?? 0,
      batteryInputPower: powers.batteryInputPower ?? 0,
      solarInputPower: powers.solarInputPower ?? 0,
      homeOutputPower: powers.homeOutputPower ?? 0,
    },
    hasBattery: true,
    hasSolar,
    capacityKwh,
    remainingKwh: (level * capacityKwh) / 100,
    remainingTime: null,
    settings: { minSoc: 10, socSet: 100 },
    energyReady: true,
    energySince: (since) => meters.energySince(id, since),
    historySince: (since) => meters.historySince(id, since),
  };
}

/** Feed the meters one payload a minute from `from` to NOW. */
function feed(meters, profile, from) {
  for (let at = from; at <= NOW; at += MINUTE) {
    for (const { id, powers, level } of profile) {
      meters.update(id, powers, at, { level: typeof level === 'function' ? level(at) : level });
    }
  }
}

test('history: average power per 5-minute step and the level at its start', () => {
  const { meters } = createTestEnergyMeters();
  feed(
    meters,
    [{ id: 'A', powers: { homeOutputPower: 600, batteryInputPower: 600 }, level: 40 }],
    NOW - 30 * MINUTE,
  );
  const history = meters.historySince('A', NOW - 30 * MINUTE);
  // Six closed steps and the open one (NOW is a boundary: it covers nothing).
  assert.equal(history.length, 7);
  for (const step of history.slice(0, 6)) {
    assert.equal(step.watts.homeOutputEnergy, 600);
    assert.equal(step.watts.batteryDischargeEnergy, 600);
    assert.equal(step.watts.batteryChargeEnergy, 0);
    assert.equal(step.level, 40);
  }
  assert.equal(history[6].watts, null);
  assert.equal(history[1].at - history[0].at, HISTORY_STEP_IN_MS);
});

test('history: the open step averages what it covered, a silence leaves a hole', () => {
  const { meters } = createTestEnergyMeters();
  const minute = (n) => NOW + n * MINUTE; // NOW is a step boundary
  // Back from a silence 2 minutes into a step, reporting 300 W until +8.
  for (let n = 2; n <= 8; n += 1) {
    meters.update('A', { homeOutputPower: 300 }, minute(n));
  }
  let history = meters.historySince('A', 0);
  // The first step got 3 minutes at 300 W: 180 W over the step. The open
  // step covered 3 minutes so far: 300 W.
  assert.deepEqual(
    history.map((step) => [step.at, step.watts.homeOutputEnergy]),
    [
      [minute(0), 180],
      [minute(5), 300],
    ],
  );
  // Silent past the integration gap, back at +15 until +17.
  for (let n = 15; n <= 17; n += 1) {
    meters.update('A', { homeOutputPower: 300 }, minute(n));
  }
  history = meters.historySince('A', 0);
  // The step the silence started in holds its energy up to the silence, the
  // silent step has no snapshot (a hole in the chart).
  assert.deepEqual(
    history.map((step) => [step.at, step.watts.homeOutputEnergy]),
    [
      [minute(0), 180],
      [minute(5), 180],
      [minute(15), 300],
    ],
  );
});

test('history: kept for a day, saved and loaded with the totals', async () => {
  const { meters, dataDir } = createTestEnergyMeters();
  for (let at = NOW - 30 * 60 * MINUTE; at <= NOW; at += 2 * MINUTE) {
    meters.update('A', { homeOutputPower: 100 }, at, { level: 77 });
  }
  const before = meters.historySince('A', 0);
  assert.ok(before[0].at >= NOW - HISTORY_RETENTION_IN_MS);
  assert.ok(before.length <= HISTORY_RETENTION_IN_MS / HISTORY_STEP_IN_MS + 1);
  await meters.save();

  const { createEnergyMeters } = await import('../src/zendure/energy.js');
  const reloaded = createEnergyMeters({ dataDir });
  await reloaded.load();
  const after = reloaded.historySince('A', 0);
  assert.equal(after.length, before.length);
  // The closed steps read the same; the open one waits for a new payload.
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  assert.equal(after[after.length - 1].watts, null);
  assert.equal(after[0].level, 77);
});

test('group history: powers summed, level weighted by the capacities', () => {
  const { meters } = createTestEnergyMeters();
  feed(
    meters,
    [
      { id: 'A', powers: { homeOutputPower: 400, batteryInputPower: 400 }, level: 80 },
      { id: 'B', powers: { homeOutputPower: 200, solarInputPower: 200 }, level: 20 },
    ],
    NOW - 15 * MINUTE,
  );
  const batteries = [
    metered(meters, 'A', { powers: {}, capacityKwh: 2.4 }),
    metered(meters, 'B', { powers: {}, capacityKwh: 0.8 }),
  ];
  const [first] = historyOf(batteries, NOW - 15 * MINUTE);
  assert.equal(first.watts.homeOutputEnergy, 600);
  assert.equal(first.watts.batteryDischargeEnergy, 400);
  assert.equal(first.watts.solarEnergy, 200);
  // (80 x 2.4 + 20 x 0.8) / 3.2 = 65.
  assert.equal(first.level, 65);
});

test('live chart: flows summed, or one line per phase for home and level', () => {
  const { meters } = createTestEnergyMeters();
  feed(
    meters,
    [
      { id: 'A', powers: { homeOutputPower: 400 }, level: 80 },
      { id: 'B', powers: { homeOutputPower: 200 }, level: 20 },
    ],
    NOW - 2 * 60 * MINUTE,
  );
  const a = metered(meters, 'A', { powers: {} });
  const b = metered(meters, 'B', { powers: {}, hasSolar: false });
  const phases = [
    { label: 'L1', batteries: [a] },
    { label: 'L2', batteries: [b] },
    { label: 'L3', batteries: [] },
  ];
  const options = { batteries: [a, b], phases, hours: 1, now: NOW };

  const power = liveChart(LIVE_CHARTS.POWER, options);
  assert.deepEqual(
    power.series.map((series) => series.name.en),
    ['Charge', 'Discharge', 'Solar', 'Home'],
  );
  // One hour of 5-minute steps (the open one at NOW has no power yet).
  assert.equal(power.series[3].points.length, 12);
  assert.equal(power.series[3].points[0].v, 600);

  const home = liveChart(LIVE_CHARTS.HOME, options);
  assert.deepEqual(
    home.series.map((series) => series.name),
    ['L1', 'L2'],
  );
  assert.equal(home.unit, 'W');
  const level = liveChart(LIVE_CHARTS.LEVEL, options);
  assert.equal(level.unit, '%');
  assert.equal(level.series[1].points[0].v, 20);

  assert.equal(liveChart(LIVE_CHARTS.NONE, options), null);
  // Nothing recorded (fresh install): no empty chart.
  const fresh = { ...a, historySince: () => [] };
  assert.equal(liveChart(LIVE_CHARTS.POWER, { ...options, batteries: [fresh], phases: [] }), null);
});

test('group and site widgets: the chart fits the content budget', () => {
  const { meters } = createTestEnergyMeters();
  feed(
    meters,
    [{ id: 'A', powers: { homeOutputPower: 400, solarInputPower: 400 }, level: 80 }],
    NOW - 60 * MINUTE,
  );
  const a = metered(meters, 'A', { powers: { homeOutputPower: 400, solarInputPower: 400 } });

  const group = groupContent('Phase L1', [a], { chart: LIVE_CHARTS.POWER, hours: 6, now: NOW });
  assert.deepEqual(validateWidgetContent(group), []);
  assert.equal(group.components.length, 8);
  assert.ok(group.components.some((c) => c.type === 'chart'));
  // With the solar tile, the stored energy moves to the first row.
  assert.equal(group.components.filter((c) => c.label?.en === 'Stored').length, 0);
  const rows = group.components.find((c) => c.type === 'status').items;
  assert.equal(rows[0].label.en, 'Stored');
  assert.equal(rows[0].value, '1.2 kWh');

  const noChart = groupContent('Phase L1', [a], { chart: LIVE_CHARTS.NONE, now: NOW });
  assert.ok(!noChart.components.some((c) => c.type === 'chart'));
  assert.ok(noChart.components.some((c) => c.label?.en === 'Stored'));

  const selection = {
    layout: LAYOUTS.THREE_PHASE,
    batteries: [a],
    phases: [
      { label: 'L1', batteries: [a] },
      { label: 'L2', batteries: [] },
      { label: 'L3', batteries: [] },
    ],
    missing: 0,
    duplicates: [],
    unassigned: [],
    fromConfig: true,
    notice: null,
  };
  const site = siteContent('Site', selection, { chart: LIVE_CHARTS.HOME, hours: 3, now: NOW });
  assert.deepEqual(validateWidgetContent(site), []);
  assert.equal(site.components.length, 8);
  const chart = site.components.find((c) => c.type === 'chart');
  assert.deepEqual(
    chart.series.map((series) => series.name),
    ['L1'],
  );
  // The stored energy stays in the "Stored / capacity" row.
  assert.ok(
    site.components
      .find((c) => c.type === 'status')
      .items.some((row) => row.label.en === 'Stored / capacity'),
  );
});

test('group list: natural order of the names by default, or the chosen order', () => {
  const battery = (name, level, home) => ({
    externalId: `ext:${name}`,
    name,
    values: { batteryLevel: level, homeOutputPower: home },
  });
  const list = [
    battery('SolarFlow 800 Pro L1', 25, 100),
    battery('SolarFlow 800 L1.10', 0, 0),
    battery('SolarFlow 2400 L1', 23, 300),
    battery('SolarFlow 800 L1.2', 0, 50),
  ];
  const names = (batteries) => batteries.map((b) => b.name);
  assert.deepEqual(names(sortBatteries(list)), [
    'SolarFlow 800 L1.2',
    'SolarFlow 800 L1.10',
    'SolarFlow 800 Pro L1',
    'SolarFlow 2400 L1',
  ]);
  assert.deepEqual(names(sortBatteries(list, SORTS.LEVEL)), [
    'SolarFlow 800 Pro L1',
    'SolarFlow 2400 L1',
    'SolarFlow 800 L1.2',
    'SolarFlow 800 L1.10',
  ]);
  assert.equal(sortBatteries(list, SORTS.POWER)[0].name, 'SolarFlow 2400 L1');
  const picked = ['ext:SolarFlow 2400 L1', 'ext:SolarFlow 800 L1.10'];
  assert.deepEqual(names(sortBatteries(list, SORTS.SELECTION, picked)).slice(0, 2), [
    'SolarFlow 2400 L1',
    'SolarFlow 800 L1.10',
  ]);
  // The input list is left as it was.
  assert.equal(list[0].name, 'SolarFlow 800 Pro L1');
});

test('energy today: the chart setting picks the flow, or the site flows', () => {
  const { meters } = createTestEnergyMeters();
  const MIDNIGHT = new Date('2026-10-16T22:00:00Z').getTime();
  feed(
    meters,
    [
      { id: 'A', powers: { homeOutputPower: 400, batteryOutputPower: 100, solarInputPower: 500 } },
      { id: 'B', powers: { homeOutputPower: 200 } },
    ],
    MIDNIGHT,
  );
  const a = metered(meters, 'A', { powers: {} });
  const b = metered(meters, 'B', { powers: {} });
  const selection = {
    layout: LAYOUTS.THREE_PHASE,
    batteries: [a, b],
    phases: [
      { label: 'L1', batteries: [a] },
      { label: 'L2', batteries: [b] },
      { label: 'L3', batteries: [] },
    ],
    missing: 0,
    duplicates: [],
    unassigned: [],
    fromConfig: true,
    notice: null,
  };
  const chartOf = (chart) =>
    energyTodayContent('Today', selection, {
      now: NOW,
      timeZone: 'Europe/Paris',
      chart,
    }).components.find((c) => c.type === 'chart');

  const solar = chartOf(ENERGY_CHARTS.SOLAR);
  assert.equal(solar.title.en, 'Solar, per 30 min');
  // 500 W over 30 minutes: 250 Wh per slot on L1, none on L2.
  assert.equal(solar.series[0].points[0].v, 250);
  assert.equal(solar.series[1].points[0].v, 0);
  const flows = chartOf(ENERGY_CHARTS.FLOWS);
  assert.deepEqual(
    flows.series.map((series) => series.name.en),
    ['Charged', 'Discharged', 'Solar', 'To the home'],
  );
  assert.equal(flows.series[3].points[0].v, 300);
  assert.equal(chartOf(ENERGY_CHARTS.NONE), undefined);
  assert.deepEqual(
    validateWidgetContent(
      energyTodayContent('Today', selection, {
        now: NOW,
        timeZone: 'Europe/Paris',
        chart: ENERGY_CHARTS.FLOWS,
      }),
    ),
    [],
  );
});

test('the chart settings of the manifest match the code', () => {
  for (const key of ['battery_group', 'site']) {
    assert.deepEqual(
      settingOf(key, 'chart')
        .options.map((option) => option.value)
        .sort(),
      Object.values(LIVE_CHARTS).sort(),
      key,
    );
    assert.deepEqual(
      settingOf(key, 'chart_hours').options.map((option) => option.value),
      CHART_HOURS,
    );
    assert.equal(settingOf(key, 'chart_hours').default, String(DEFAULT_CHART_HOURS));
  }
  assert.equal(settingOf('battery_group', 'chart').default, LIVE_CHARTS.POWER);
  assert.equal(settingOf('site', 'chart').default, LIVE_CHARTS.HOME);
  assert.deepEqual(
    settingOf('battery_group', 'sort')
      .options.map((option) => option.value)
      .sort(),
    Object.values(SORTS).sort(),
  );
  assert.equal(settingOf('battery_group', 'sort').default, SORTS.NAME);
  assert.deepEqual(
    settingOf('energy_today', 'chart')
      .options.map((option) => option.value)
      .sort(),
    Object.values(ENERGY_CHARTS).sort(),
  );
  assert.equal(settingOf('energy_today', 'chart').default, ENERGY_CHARTS.HOME);
  assert.equal(chartHoursOf({ chart_hours: '24' }), 24);
  assert.equal(chartHoursOf({ chart_hours: '7' }), DEFAULT_CHART_HOURS);
  assert.equal(chartHoursOf({}), DEFAULT_CHART_HOURS);
});
