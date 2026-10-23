// Period navigation of the widgets with a chart (src/dashboard/period.js):
// windows, views, buttons, the content budget, and the energy of a past day
// or week from the 30-minute slots.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { LIVE_CHARTS } from '../src/dashboard/charts.js';
import { LAYOUTS } from '../src/dashboard/common.js';
import { ENERGY_CHARTS, energyTodayContent } from '../src/dashboard/energyToday.js';
import {
  ENERGY_VIEW,
  NEXT_ACTION,
  PERIOD_ACTION,
  PREVIOUS_ACTION,
  createViews,
  fitTiles,
  hasPrevious,
  liveView,
  viewButtons,
  viewMessage,
  windowOf,
} from '../src/dashboard/period.js';
import { siteContent } from '../src/dashboard/site.js';
import { WIDGETS, GROUP_WIDGET, groupContent } from '../src/widgets.js';
import { SITE_WIDGET, ENERGY_TODAY_WIDGET } from '../src/widgets.js';
import { createTestEnergyMeters } from './helpers/fakeZendure.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-10-23T10:00:00Z').getTime(); // 12:00 in Paris, a Friday
const PARIS = 'Europe/Paris';

/** A battery snapshot reading the given meters. */
function metered(meters, id, { level = 50, hasSolar = true } = {}) {
  return {
    externalId: `ext:zendure:solarflow:${id}`,
    name: id,
    source: 'http',
    degraded: false,
    values: {
      batteryLevel: level,
      batteryOutputPower: 0,
      batteryInputPower: 0,
      solarInputPower: 0,
      homeOutputPower: 300,
    },
    hasBattery: true,
    hasSolar,
    capacityKwh: 2.4,
    remainingKwh: (level * 2.4) / 100,
    remainingTime: null,
    settings: { minSoc: 10, socSet: 100 },
    energyReady: true,
    energySince: (since, until) => meters.energySince(id, since, until),
    historySince: (since) => meters.historySince(id, since),
  };
}

/** One payload a minute from `from` to NOW, at a steady power. */
function feed(meters, ids, from, powers) {
  for (let at = from; at <= NOW; at += MINUTE) {
    for (const id of ids) {
      meters.update(id, typeof powers === 'function' ? powers(at) : powers, at, { level: 50 });
    }
  }
}

const threePhase = (batteries) => ({
  layout: LAYOUTS.THREE_PHASE,
  batteries,
  phases: [
    { label: 'L1', batteries: [batteries[0]] },
    { label: 'L2', batteries: batteries.slice(1) },
    { label: 'L3', batteries: [] },
  ],
  missing: 0,
  duplicates: [],
  unassigned: [],
  fromConfig: true,
  notice: null,
});

test('windows: hours step back by their length, days by local day', () => {
  const current = windowOf('hours_6', 0, NOW, PARIS);
  assert.equal(current.current, true);
  assert.equal(current.to - current.from, 6 * HOUR);
  assert.equal(current.label, '23/10 06:00 → 12:00');
  const back = windowOf('hours_6', -2, NOW, PARIS);
  assert.equal(back.to, NOW - 12 * HOUR);
  // Labeled by the day the window starts.
  assert.equal(back.label, '22/10 18:00 → 00:00');

  const today = windowOf('day', 0, NOW, PARIS);
  assert.equal(today.from, new Date('2026-10-22T22:00:00Z').getTime());
  assert.equal(today.to, NOW);
  assert.equal(today.label.en, 'Fri 23/10');
  assert.equal(today.label.fr, 'ven. 23/10');
  // Across the DST change of 25/10: the day before is 25 hours long.
  const later = new Date('2026-10-26T10:00:00Z').getTime();
  const sunday = windowOf('day', -1, later, PARIS);
  assert.equal(sunday.to - sunday.from, 25 * HOUR);
  assert.equal(sunday.label.en, 'Sun 25/10');

  const week = windowOf('week', 0, NOW, PARIS);
  assert.equal(week.days.length, 7);
  assert.equal(week.label, '17/10 → 23/10');
  assert.equal(week.days[6].to, NOW);
  const lastWeek = windowOf('week', -1, NOW, PARIS);
  assert.equal(lastWeek.label, '10/10 → 16/10');
});

test('windows: how far back the data goes', () => {
  // 5-minute history: 48 h. A 24 h window steps back once.
  assert.equal(hasPrevious(windowOf('hours_24', 0, NOW, PARIS), NOW), true);
  assert.equal(hasPrevious(windowOf('hours_24', -1, NOW, PARIS), NOW), false);
  assert.equal(hasPrevious(windowOf('hours_6', -6, NOW, PARIS), NOW), true);
  assert.equal(hasPrevious(windowOf('hours_6', -7, NOW, PARIS), NOW), false);
  // 30-minute slots: 8 days and 2 hours. Eight days back, one week back.
  assert.equal(hasPrevious(windowOf('day', -7, NOW, PARIS), NOW), true);
  assert.equal(hasPrevious(windowOf('day', -8, NOW, PARIS), NOW), false);
  assert.equal(hasPrevious(windowOf('week', 0, NOW, PARIS), NOW), true);
  assert.equal(hasPrevious(windowOf('week', -1, NOW, PARIS), NOW), false);
});

test('views: per instance, the period form, previous, next back to now', () => {
  const views = createViews({ maxInstances: 2 });
  const spec = liveView(12);
  assert.deepEqual(views.get('site', { a: 1 }, spec), { period: 'hours_12', offset: 0 });
  views.apply('site', { a: 1 }, spec, PREVIOUS_ACTION);
  assert.deepEqual(views.get('site', { a: 1 }, spec), { period: 'hours_12', offset: -1 });
  // The same settings in another key order: the same instance.
  assert.equal(views.get('site', { a: 1 }, spec).offset, -1);
  assert.equal(views.get('site', { a: 2 }, spec).offset, 0);
  views.apply('site', { a: 1 }, spec, NEXT_ACTION);
  views.apply('site', { a: 1 }, spec, NEXT_ACTION);
  assert.equal(views.get('site', { a: 1 }, spec).offset, 0);
  // The form picks a period and goes back to now; without values it cycles.
  views.apply('site', { a: 1 }, spec, PREVIOUS_ACTION);
  assert.deepEqual(views.apply('site', { a: 1 }, spec, PERIOD_ACTION, { period: 'hours_3' }), {
    period: 'hours_3',
    offset: 0,
  });
  assert.equal(views.apply('site', { a: 1 }, spec, PERIOD_ACTION).period, 'hours_6');
  assert.throws(() => views.apply('site', { a: 1 }, spec, 'nope'), /Unknown widget action/);
  // Bounded: the oldest instance goes.
  views.apply('site', { a: 2 }, spec, PREVIOUS_ACTION);
  views.apply('site', { a: 3 }, spec, PREVIOUS_ACTION);
  assert.equal(views.get('site', { a: 1 }, spec).period, 'hours_12');
  // The default period follows the chart_hours setting.
  assert.equal(liveView(24).defaultPeriod, 'hours_24');
  assert.equal(liveView(7).defaultPeriod, 'hours_6');
});

test('buttons: period form always, previous with data before, next once back', () => {
  const keys = (buttons) => buttons.map((button) => button.action.key);
  assert.deepEqual(keys(viewButtons({ period: 'day', offset: 0 }, ENERGY_VIEW.periods, true)), [
    PERIOD_ACTION,
    PREVIOUS_ACTION,
  ]);
  const back = viewButtons({ period: 'day', offset: -7 }, ENERGY_VIEW.periods, false);
  assert.deepEqual(keys(back), [PERIOD_ACTION, NEXT_ACTION]);
  const form = back[0].action.fields[0];
  assert.equal(form.default, 'day');
  assert.deepEqual(
    form.options.map((option) => option.value),
    ['day', 'week'],
  );
  assert.equal(viewMessage(windowOf('day', -1, NOW, PARIS)).fr, 'Affichage : jeu. 22/10');
});

test('fitTiles: the first tiles stay, the others become rows', () => {
  const tile = (label, value, unit) => ({ type: 'value', label: { en: label }, value, unit });
  const fitted = fitTiles([tile('A', 1, 'W'), tile('B', '—', 'W'), tile('C', 3, 'kWh')], 6);
  assert.deepEqual(
    fitted.tiles.map((t) => t.label.en),
    ['A', 'B'],
  );
  assert.deepEqual(fitted.rows, [
    { label: { en: 'C' }, icon: 'battery', value: '3 kWh', color: 'neutral' },
  ]);
});

test('energy meters: the energy of a past range ends at its last snapshot', () => {
  const { meters } = createTestEnergyMeters();
  const from = NOW - 3 * 24 * HOUR;
  feed(meters, ['A'], from, { homeOutputPower: 500 });
  const yesterday = windowOf('day', -1, NOW, PARIS);
  const energy = meters.energySince('A', yesterday.from, yesterday.to);
  // 500 W for 24 hours.
  assert.equal(energy.kwh.homeOutputEnergy, 12);
  assert.equal(energy.slots.length, 48);
  assert.equal(energy.slots.at(-1).at, yesterday.to - 30 * MINUTE);
  // Nothing in a range before the first payload.
  assert.equal(meters.energySince('A', from - 2 * HOUR, from - HOUR), null);
});

test('group and site: buttons within the 8 components, a past window charted', () => {
  const { meters } = createTestEnergyMeters();
  feed(meters, ['A', 'B'], NOW - 30 * HOUR, (at) => ({
    homeOutputPower: at < NOW - 12 * HOUR ? 200 : 600,
    solarInputPower: 100,
  }));
  const batteries = [metered(meters, 'A'), metered(meters, 'B')];
  const view = { period: 'hours_6', offset: -3 };
  const window = windowOf(view.period, view.offset, NOW, PARIS);
  const buttons = viewButtons(view, liveView(6).periods, hasPrevious(window, NOW));

  const group = groupContent('Phase L1', batteries, {
    chart: LIVE_CHARTS.HOME,
    hours: 6,
    now: NOW,
    window,
    buttons,
  });
  assert.deepEqual(validateWidgetContent(group), []);
  assert.equal(group.components.length, 8);
  assert.equal(group.components.filter((c) => c.type === 'button').length, 3);
  const chart = group.components.find((c) => c.type === 'chart');
  assert.equal(chart.title.en, 'To the home · 22/10 12:00 → 18:00');
  const points = chart.series[0].points;
  assert.equal(points.length, 72);
  assert.ok(points.every((p) => Date.parse(p.t) >= window.from && Date.parse(p.t) < window.to));
  // Before NOW - 12 h: 200 W each, 400 W for the group (0.1 Wh rounding).
  assert.ok(points.every((p) => Math.abs(p.v - 400) <= 2));
  // The tiles that did not fit are the first status rows.
  const rows = group.components.find((c) => c.type === 'status').items;
  // Heading, chart, status and 3 buttons: the gauge and the home tile stay.
  assert.equal(rows[0].label.en, 'Charging');

  const site = siteContent(null, threePhase(batteries), {
    chart: LIVE_CHARTS.HOME,
    hours: 6,
    now: NOW,
    window,
    buttons,
  });
  assert.deepEqual(validateWidgetContent(site), []);
  assert.ok(site.components.length <= 8);
  assert.deepEqual(
    site.components.find((c) => c.type === 'chart').series.map((series) => series.name),
    ['L1', 'L2'],
  );

  // No chart: no button either, every tile fits.
  const plain = groupContent(null, batteries, {
    chart: LIVE_CHARTS.NONE,
    now: NOW,
    window,
    buttons,
  });
  assert.equal(plain.components.filter((c) => c.type === 'button').length, 0);
  assert.equal(plain.components.filter((c) => c.type === 'value').length, 5);
});

test('energy: a past day and a week from the slots, savings on today only', () => {
  const { meters } = createTestEnergyMeters();
  const from = NOW - 9 * 24 * HOUR;
  feed(meters, ['A', 'B'], from, { homeOutputPower: 500 });
  const batteries = [metered(meters, 'A'), metered(meters, 'B', { hasSolar: false })];
  const selection = threePhase(batteries);
  const content = (period, offset, chart = ENERGY_CHARTS.HOME) => {
    const window = windowOf(period, offset, NOW, PARIS);
    return energyTodayContent(null, selection, {
      now: NOW,
      timeZone: PARIS,
      chart,
      window,
      buttons: viewButtons({ period, offset }, ENERGY_VIEW.periods, hasPrevious(window, NOW)),
    });
  };

  const yesterday = content('day', -1);
  assert.deepEqual(validateWidgetContent(yesterday), []);
  const rows = yesterday.components.find((c) => c.type === 'status').items;
  assert.equal(rows[0].label.en, 'Shown');
  assert.equal(rows[0].value.en, 'Thu 22/10');
  // 500 W for 24 h on each battery: L1 12 kWh, L2 12 kWh.
  assert.match(rows.find((row) => row.label === 'L1 (1)').value, /^⌂ 12 /);
  const tiles = yesterday.components.filter((c) => c.type === 'value');
  assert.equal(tiles.find((t) => t.label.en === 'To the home').value, 24);
  assert.equal(yesterday.components.find((c) => c.type === 'chart').series[0].points.length, 48);

  const week = content('week', 0, ENERGY_CHARTS.FLOWS);
  assert.deepEqual(validateWidgetContent(week), []);
  const chart = week.components.find((c) => c.type === 'chart');
  assert.equal(chart.chart_type, 'bar');
  assert.equal(chart.unit, 'kWh');
  assert.equal(chart.title.en, 'Site flows, per day');
  const home = chart.series.find((series) => series.name.en === 'To the home');
  assert.equal(home.points.length, 7);
  assert.equal(home.points[0].t, '2026-10-17T12:00:00.000Z');
  assert.equal(home.points[0].v, 24);
  // Today: midnight to noon in Paris.
  assert.equal(home.points[6].v, 12);
  assert.ok(week.components.length <= 8);

  // Savings: the current day only.
  const withSavings = (period, offset) =>
    energyTodayContent(null, selection, {
      now: NOW,
      timeZone: PARIS,
      window: windowOf(period, offset, NOW, PARIS),
      savings: { tariff: null, tariffError: 'invalid' },
    });
  const rowsOf = (c) => c.components.find((x) => x.type === 'status').items;
  const hasSavings = (c) =>
    rowsOf(c).some((row) => /estimate|tariff/i.test(row.label?.en ?? row.label));
  assert.equal(hasSavings(withSavings('day', 0)), true);
  assert.equal(hasSavings(withSavings('day', -1)), false);
});

test('widget handlers: the period buttons change the view of the instance', async () => {
  for (const key of [GROUP_WIDGET, SITE_WIDGET, ENERGY_TODAY_WIDGET]) {
    const settings = { title: `nav ${key}`, chart_hours: '12' };
    const back = await WIDGETS[key].action({}, { actionKey: PREVIOUS_ACTION, settings });
    assert.match(back.en, /^Showing /);
    const picked = await WIDGETS[key].action(
      {},
      { actionKey: PERIOD_ACTION, settings, values: { period: 'week' } },
    );
    assert.match(picked.fr, /^Affichage : /);
    await assert.rejects(WIDGETS[key].action({}, { actionKey: 'unknown', settings }));
  }
});
