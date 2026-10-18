// -----------------------------------------------------------------------------
// Savings estimate without a grid meter (src/zendure/savings.js): off-peak
// hours, slot pricing (clock changes included), stored energy cost, the
// allocation of a slot, the calendar accumulators through the energy meters,
// and the energy.json compatibility. Nothing here touches the network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  allocateSlot,
  buildTariff,
  closeSavingsSlot,
  createSavingsState,
  deserializeSavings,
  parseOffpeakHours,
  periodKeysOf,
  previousPeriodKeysOf,
  savingsReport,
  serializeSavings,
  tariffFromConfig,
  PERIOD_HISTORY,
  SAVINGS_FIELDS,
} from '../../src/zendure/savings.js';
import { createEnergyMeters, ENERGY_SLOT_IN_MS } from '../../src/zendure/energy.js';
import { normalizeConfig } from '../../src/config.js';
import { createTestEnergyMeters } from '../helpers/fakeZendure.js';

const MINUTE = 60 * 1000;
const at = (iso) => new Date(iso).getTime();
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} != ${expected}`);

const PEAK_OFFPEAK = normalizeConfig({
  tariff_mode: 'peak_offpeak',
  price_peak: 0.2,
  price_offpeak: 0.1,
  offpeak_hours: '22:00-06:00',
});
const BASE = normalizeConfig({ tariff_mode: 'base', price_base: 0.2 });

// --- Off-peak hours ---------------------------------------------------------------

test('off-peak hours: one or several ranges, crossing midnight, 24:00 as an end', () => {
  assert.deepEqual(parseOffpeakHours('22:00-06:00'), { ranges: [{ start: 1320, end: 360 }] });
  assert.deepEqual(parseOffpeakHours(' 01:30-07:30 , 12:30-14:30 '), {
    ranges: [
      { start: 90, end: 450 },
      { start: 750, end: 870 },
    ],
  });
  assert.deepEqual(parseOffpeakHours('2:00-7:00;20h00-24:00'), {
    ranges: [
      { start: 120, end: 420 },
      { start: 1200, end: 1440 },
    ],
  });
});

test('off-peak hours: invalid texts are refused with a reason', () => {
  for (const text of [
    '',
    undefined,
    'night',
    '22:00',
    '25:00-06:00',
    '22:60-06:00',
    '24:30-06:00',
    '22:00-22:00',
    '00:00-24:00',
    '22:00-06:00,',
  ]) {
    const parsed = parseOffpeakHours(text);
    assert.ok(typeof parsed.error === 'string', `"${text}" should be refused`);
  }
});

test('an invalid tariff is ignored, and logged once', () => {
  assert.deepEqual(buildTariff(normalizeConfig()), { tariff: null, error: null, warning: null });
  assert.match(buildTariff(normalizeConfig({ tariff_mode: 'base' })).error, /base price/);
  assert.match(
    buildTariff({ ...PEAK_OFFPEAK, offpeak_hours: '22-06' }).error,
    /invalid off-peak hours/,
  );
  assert.match(buildTariff({ ...PEAK_OFFPEAK, price_peak: null }).error, /peak price/);
  assert.match(
    buildTariff({ ...BASE, resale_enabled: true, resale_price: null }).error,
    /resale price/,
  );
  // An unknown timezone falls back to Europe/Paris, with a warning.
  const unknownZone = buildTariff({ ...BASE, tariff_timezone: 'Mars/Olympus' });
  assert.equal(unknownZone.tariff.timeZone, 'Europe/Paris');
  assert.match(unknownZone.warning, /Mars\/Olympus/);
  // Memoized: the same config gives the same object (no rebuild, no new log).
  const config = { ...PEAK_OFFPEAK, offpeak_hours: 'garbage' };
  assert.equal(tariffFromConfig(config), tariffFromConfig({ ...config }));
  assert.equal(tariffFromConfig(config).tariff, null);
});

// --- Slot pricing -------------------------------------------------------------------

test('the price of a slot: off-peak in the tariff timezone, pro rata at a range edge', () => {
  const { tariff } = buildTariff(PEAK_OFFPEAK);
  // Paris is UTC+2 in October (before the 25th).
  assert.equal(tariff.priceAt(at('2026-10-17T19:30:00Z')), 0.2); // 21:30
  assert.equal(tariff.priceAt(at('2026-10-17T20:00:00Z')), 0.1); // 22:00
  assert.equal(tariff.priceAt(at('2026-10-17T03:30:00Z')), 0.1); // 05:30
  assert.equal(tariff.priceAt(at('2026-10-17T04:00:00Z')), 0.2); // 06:00
  const edge = buildTariff({ ...PEAK_OFFPEAK, offpeak_hours: '22:15-06:00' }).tariff;
  near(edge.priceAt(at('2026-10-17T20:00:00Z')), 0.15); // half the slot off-peak
  // Another timezone moves the ranges.
  const utc = buildTariff({ ...PEAK_OFFPEAK, tariff_timezone: 'UTC' }).tariff;
  assert.equal(utc.priceAt(at('2026-10-17T20:00:00Z')), 0.2);
  assert.equal(utc.priceAt(at('2026-10-17T22:00:00Z')), 0.1);
  // Base: one price all the time.
  assert.equal(buildTariff(BASE).tariff.priceAt(at('2026-10-17T03:00:00Z')), 0.2);
});

test('clock changes: off-peak slots follow the wall clock, the day keeps its date', () => {
  const { tariff } = buildTariff({ ...PEAK_OFFPEAK, offpeak_hours: '01:30-07:30' });
  const slotsOf = (fromIso, toIso) => {
    const slots = [];
    for (let slot = at(fromIso); slot < at(toIso); slot += ENERGY_SLOT_IN_MS) {
      slots.push(slot);
    }
    return slots;
  };
  // Back to winter time on 2026-10-25: a 25-hour day, 02:00-03:00 lived twice.
  const autumn = slotsOf('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z');
  assert.equal(autumn.length, 50);
  assert.ok(autumn.every((slot) => periodKeysOf(slot, 'Europe/Paris').day === '2026-10-25'));
  assert.equal(autumn.filter((slot) => tariff.offpeakShareAt(slot) === 1).length, 14); // 7 h
  // Spring forward on 2026-03-29: a 23-hour day, 02:00-03:00 skipped.
  const spring = slotsOf('2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z');
  assert.equal(spring.length, 46);
  assert.ok(spring.every((slot) => periodKeysOf(slot, 'Europe/Paris').day === '2026-03-29'));
  assert.equal(spring.filter((slot) => tariff.offpeakShareAt(slot) === 1).length, 10); // 5 h
});

test('calendar keys and the previous day, month and year, in the tariff timezone', () => {
  // 00:30 in Paris on New Year's Day, still 2026 in UTC.
  const newYear = at('2026-12-31T23:30:00Z');
  assert.deepEqual(periodKeysOf(newYear, 'Europe/Paris'), {
    day: '2027-01-01',
    month: '2027-01',
    year: '2027',
  });
  assert.deepEqual(periodKeysOf(newYear, 'UTC'), {
    day: '2026-12-31',
    month: '2026-12',
    year: '2026',
  });
  assert.deepEqual(previousPeriodKeysOf(newYear, 'Europe/Paris'), {
    day: '2026-12-31',
    month: '2026-12',
    year: '2026',
  });
  assert.deepEqual(previousPeriodKeysOf(at('2028-03-01T12:00:00Z'), 'UTC').day, '2028-02-29');
});

// --- Allocation of one slot -----------------------------------------------------------

const PRICES = { price: 0.2, opportunityPrice: 0, resaleEnabled: false, resalePrice: 0 };
const NO_FLOW = { charge: 0, discharge: 0, solar: 0, home: 0, gridInput: 0 };

test('stored energy carries the weighted average of its acquisition costs', () => {
  // 1 kWh stored at 0.10, then 1 kWh from the grid at 0.20 and 1 kWh of solar
  // valued at the resale price 0.04.
  const { stock, gains } = allocateSlot(
    { ...NO_FLOW, charge: 2, gridInput: 1, solar: 1 },
    { price: 0.2, opportunityPrice: 0.04, resaleEnabled: true, resalePrice: 0.04 },
    { kwh: 1, cost: 0.1 },
  );
  near(stock.kwh, 3);
  near(stock.cost, (0.1 + 0.2 + 0.04) / 3);
  near(gains.gridCost, 0.2);
  near(gains.gridChargedKwh, 1);
  near(gains.solarChargedKwh, 1);
  near(gains.savings, 0, 'charging alone saves nothing');
  // Grid input beyond the charge passed through to the home: not charged.
  const passing = allocateSlot({ ...NO_FLOW, charge: 0.5, gridInput: 2, home: 1.5 }, PRICES, {
    kwh: 0,
    cost: 0,
  });
  near(passing.gains.gridChargedKwh, 0.5);
  near(passing.gains.savings, 0, 'grid through the battery saves nothing');
});

test('the home output: discharge share, direct solar share, the rest from the grid', () => {
  // Discharge of energy stored at 0.10, valued at 0.20.
  const shift = allocateSlot({ ...NO_FLOW, discharge: 1, home: 1 }, PRICES, { kwh: 2, cost: 0.1 });
  near(shift.gains.batteryGain, 0.1);
  near(shift.gains.batteryKwh, 1);
  near(shift.stock.kwh, 1);
  near(shift.stock.cost, 0.1, 'discharging keeps the average cost');
  // 1 kWh of solar: 0.4 into the pack, 0.6 to the home (of 0.8 sent).
  const direct = allocateSlot({ ...NO_FLOW, solar: 1, charge: 0.4, home: 0.8 }, PRICES, {
    kwh: 0,
    cost: 0,
  });
  near(direct.gains.solarKwh, 0.6);
  near(direct.gains.solarGain, 0.12);
  near(direct.gains.savings, 0.12);
  // A discharge larger than the home output: only the share sent counts.
  const capped = allocateSlot({ ...NO_FLOW, discharge: 2, home: 0.5 }, PRICES, {
    kwh: 3,
    cost: 0.05,
  });
  near(capped.gains.batteryKwh, 0.5);
});

test('exported energy (grid meter, coming): resale revenue, or a loss without resale', () => {
  const delta = { ...NO_FLOW, solar: 1, home: 1 };
  const lost = allocateSlot(delta, PRICES, { kwh: 0, cost: 0 }, 0.3);
  near(lost.gains.lossKwh, 0.3);
  near(lost.gains.solarKwh, 0.7);
  near(lost.gains.resaleRevenue, 0);
  const sold = allocateSlot(
    delta,
    { ...PRICES, opportunityPrice: 0.05, resaleEnabled: true, resalePrice: 0.05 },
    { kwh: 0, cost: 0 },
    0.3,
  );
  near(sold.gains.lossKwh, 0);
  near(sold.gains.resaleRevenue, 0.015);
  near(sold.gains.savings, 0.7 * 0.2 + 0.015);
  // Without a meter (today): nothing exported.
  near(allocateSlot(delta, PRICES, { kwh: 0, cost: 0 }).gains.lossKwh, 0);
});

// --- Through the energy meters ----------------------------------------------------------

/** Constant powers every 5 minutes from `from` to `to` (inclusive). */
function feed(meters, id, powers, from, to, measures) {
  for (let t = from; t <= to; t += 5 * MINUTE) {
    meters.update(id, powers, t, measures?.(t));
  }
}

test('battery time-shift: charged off-peak from the grid, discharged at peak', () => {
  const { meters } = createTestEnergyMeters();
  meters.setTariff(buildTariff(PEAK_OFFPEAK).tariff);
  // 1 kW from the grid into the pack from 00:00 to 02:00 (Paris, off-peak)...
  feed(
    meters,
    'ac',
    { gridInputPower: 1000, batteryOutputPower: 1000 },
    at('2026-10-16T22:00:00Z'),
    at('2026-10-17T00:00:00Z'),
  );
  // ...then 1 kW out to the home from 08:00 to 10:00 (peak).
  feed(
    meters,
    'ac',
    { gridInputPower: 0, batteryOutputPower: 0, batteryInputPower: 1000, homeOutputPower: 1000 },
    at('2026-10-17T06:00:00Z'),
    at('2026-10-17T08:00:00Z'),
  );
  const report = meters.savingsOf('ac', at('2026-10-17T08:00:00Z'));
  near(report.today.gridChargedKwh, 2);
  near(report.today.gridCost, 0.2);
  near(report.today.batteryKwh, 2);
  near(report.today.batteryGain, 0.2); // 2 kWh x (0.20 - 0.10)
  near(report.today.savings, 0.2);
  near(report.storedCost, 0.1);
  assert.equal(meters.savingsOf('unknown', at('2026-10-17T08:00:00Z')), null);
  meters.setTariff(null);
  assert.equal(meters.savingsOf('ac', at('2026-10-17T08:00:00Z')), null);
});

test('day, month and year accumulators roll over at the local calendar boundaries', () => {
  const { meters } = createTestEnergyMeters();
  meters.setTariff(buildTariff(BASE).tariff);
  // 1 kW of solar straight to the home, 21:00 to 03:00 Paris across New Year.
  feed(
    meters,
    'pv',
    { solarInputPower: 1000, homeOutputPower: 1000 },
    at('2026-12-31T20:00:00Z'),
    at('2027-01-01T02:00:00Z'),
  );
  const report = meters.savingsOf('pv', at('2027-01-01T02:00:00Z'));
  // 3 h before the local midnight, 3 h after (the open slot counted too).
  near(report.today.solarKwh, 3);
  near(report.today.savings, 0.6);
  near(report.yesterday.savings, 0.6);
  near(report.month.savings, 0.6);
  near(report.previousMonth.savings, 0.6);
  near(report.year.savings, 0.6);
  near(report.previousYear.savings, 0.6);
  // A day later with no data: today is empty, yesterday is New Year's Day.
  const later = meters.savingsOf('pv', at('2027-01-02T12:00:00Z'));
  near(later.today.savings, 0);
  near(later.yesterday.savings, 0.6);
  near(later.month.savings, 0.6);
});

test('only the current and the previous period are kept', () => {
  const state = createSavingsState();
  const { tariff } = buildTariff({ ...BASE, tariff_timezone: 'UTC' });
  const totals = { solarEnergy: 0, homeOutputEnergy: 0 };
  let slot = at('2026-01-01T00:00:00Z');
  closeSavingsSlot(state, totals, slot, tariff);
  for (let day = 0; day < 4; day += 1) {
    totals.solarEnergy += 1;
    totals.homeOutputEnergy += 1;
    slot += 24 * 60 * MINUTE;
    closeSavingsSlot(state, totals, slot, tariff);
  }
  assert.equal(state.periods.day.length, PERIOD_HISTORY);
  assert.deepEqual(
    state.periods.day.map((entry) => entry.key),
    ['2026-01-04', '2026-01-03'],
  );
  near(state.periods.month[0].savings, 0.8);
  // An older slot than everything kept is ignored, not resurrected.
  const report = savingsReport(state, totals, slot, tariff);
  near(report.yesterday.savings, 0.2);
});

test('without a tariff the slot marks advance, and nothing is counted', () => {
  const { meters } = createTestEnergyMeters();
  feed(
    meters,
    'pv',
    { solarInputPower: 1000, homeOutputPower: 1000 },
    at('2026-10-17T06:00:00Z'),
    at('2026-10-17T08:00:00Z'),
  );
  // The tariff set later values only what comes after.
  meters.setTariff(buildTariff(BASE).tariff);
  feed(meters, 'pv', {}, at('2026-10-17T08:05:00Z'), at('2026-10-17T09:00:00Z'));
  near(meters.savingsOf('pv', at('2026-10-17T09:00:00Z')).today.solarKwh, 1);
});

test('the measured stored energy corrects the counted one', () => {
  const { meters } = createTestEnergyMeters();
  meters.setTariff(buildTariff(BASE).tariff);
  feed(
    meters,
    'dev',
    { batteryOutputPower: 1000, solarInputPower: 1000 },
    at('2026-10-17T06:00:00Z'),
    at('2026-10-17T07:00:00Z'),
    () => ({ storedKwh: 0.8 }), // pack losses: 1 kWh charged, 0.8 kWh stored
  );
  feed(meters, 'dev', {}, at('2026-10-17T07:05:00Z'), at('2026-10-17T07:30:00Z'), () => ({
    storedKwh: 0.8,
  }));
  // Solar charged for free: the stock costs nothing.
  near(meters.savingsOf('dev', at('2026-10-17T07:30:00Z')).storedCost, 0);
});

// --- Persistence ---------------------------------------------------------------------------

test('the savings survive a restart, saved next to the meters', async () => {
  const { meters, dataDir } = createTestEnergyMeters();
  meters.setTariff(buildTariff(PEAK_OFFPEAK).tariff);
  feed(
    meters,
    'ac',
    { gridInputPower: 1000, batteryOutputPower: 1000 },
    at('2026-10-16T22:00:00Z'),
    at('2026-10-17T00:00:00Z'),
  );
  const before = meters.savingsOf('ac', at('2026-10-17T00:00:00Z'));
  await meters.save();
  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  // Same version and slot layout: 1.7.0 still reads the file.
  assert.equal(saved.version, 1);
  assert.equal(saved.devices.ac.slots[0].length, 5);
  assert.ok(saved.devices.ac.savings.mark);
  assert.ok(Array.isArray(saved.devices.ac.savings.periods.day));

  const restarted = createEnergyMeters({ dataDir });
  restarted.setTariff(buildTariff(PEAK_OFFPEAK).tariff);
  await restarted.load();
  const after = restarted.savingsOf('ac', at('2026-10-17T00:00:00Z'));
  assert.deepEqual(after, before);
});

test('a 1.7.0 or small-wins energy.json (no savings) loads, the savings start at 0', async () => {
  for (const kwh of [
    { batteryChargeEnergy: 4, solarEnergy: 3, homeOutputEnergy: 2 }, // 1.7.0
    { batteryChargeEnergy: 4, solarEnergy: 3, homeOutputEnergy: 2, gridInputEnergy: 1.5 }, // small-wins
  ]) {
    const { dataDir } = createTestEnergyMeters();
    const slot = at('2026-10-17T06:00:00Z');
    await writeFile(
      join(dataDir, 'energy.json'),
      JSON.stringify({
        version: 1,
        slot_fields: [
          'batteryChargeEnergy',
          'batteryDischargeEnergy',
          'solarEnergy',
          'homeOutputEnergy',
        ],
        devices: { dev: { kwh, slots: [[slot, 3.5, 0, 2.5, 1.5]] } },
      }),
    );
    const meters = createEnergyMeters({ dataDir });
    meters.setTariff(buildTariff(BASE).tariff);
    await meters.load();
    // The saved totals are not valued (no mark yet): only what comes next.
    feed(
      meters,
      'dev',
      { solarInputPower: 1000, homeOutputPower: 1000 },
      at('2026-10-17T06:10:00Z'),
      at('2026-10-17T07:10:00Z'),
    );
    const report = meters.savingsOf('dev', at('2026-10-17T07:10:00Z'));
    // From the first slot boundary seen (06:30) on: 40 minutes.
    near(report.today.solarKwh, 40 / 60);
    assert.equal(meters.totals('dev').batteryChargeEnergy, 4);
  }
});

test('a savings object from a newer release loads, unknown and broken fields tolerated', () => {
  const state = deserializeSavings({
    mark: { at: 1000, kwh: { charge: 1, solar: 'x', futureFlow: 3 } },
    stock: { kwh: -2, cost: 0.12 },
    periods: {
      day: [
        { key: '2026-10-16', savings: 1 },
        { key: '2026-10-17', savings: 2, futureField: 9 },
        { key: '2026-10-15', savings: 3 },
        null,
      ],
      week: [{ key: '2026-W42' }],
    },
  });
  assert.deepEqual(state.mark, {
    at: 1000,
    kwh: { charge: 1, discharge: 0, solar: 0, home: 0, gridInput: 0 },
  });
  assert.deepEqual(state.stock, { kwh: 0, cost: 0.12 });
  assert.deepEqual(
    state.periods.day.map((entry) => [entry.key, entry.savings]),
    [
      ['2026-10-17', 2],
      ['2026-10-16', 1],
    ],
  );
  assert.deepEqual(Object.keys(state.periods.day[0]).sort(), ['key', ...SAVINGS_FIELDS].sort());
  assert.deepEqual(state.periods.month, []);
  assert.deepEqual(deserializeSavings(undefined), createSavingsState());
  assert.deepEqual(
    serializeSavings(deserializeSavings(serializeSavings(state))),
    serializeSavings(state),
  );
});
