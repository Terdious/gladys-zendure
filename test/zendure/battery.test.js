import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  batteryPresenceOf,
  hasSolarInput,
  remainingTimeOf,
  formatRemainingTime,
  REMAINING_TIME_UNKNOWN_IN_MIN,
} from '../../src/zendure/battery.js';

test('battery presence: built-in packs always, optional ones from the telemetry', () => {
  // All-in-one models carry their pack whatever the report says.
  assert.equal(batteryPresenceOf('SolarFlow 2400 AC', {}), true);
  assert.equal(batteryPresenceOf('SolarFlow 800 Pro', { properties: { packNum: 0 } }), true);
  // A SolarFlow 800 may run as a plain micro-inverter.
  assert.equal(batteryPresenceOf('SolarFlow 800', {}), null, 'unknown until reported');
  assert.equal(batteryPresenceOf('SolarFlow 800', { properties: { packNum: 0 } }), false);
  assert.equal(batteryPresenceOf('SolarFlow 800', { packNum: 2 }), true);
  assert.equal(batteryPresenceOf('SolarFlow 800', { packData: [] }), false);
  assert.equal(batteryPresenceOf('SolarFlow 800', { packData: [{ sn: 'Z9' }] }), true);
  // A known pack capacity settles it even with a stale packNum.
  assert.equal(batteryPresenceOf('SolarFlow 800', { packNum: 0, packData: [{ sn: 'C1' }] }), true);
  assert.equal(batteryPresenceOf('Hyper 2000', { properties: { packNum: 0 } }), false);
});

test('solar input: from the model, or from a reported solar power', () => {
  assert.equal(hasSolarInput('SolarFlow 800', null), true);
  assert.equal(hasSolarInput('SolarFlow 2400 Pro', 0), true);
  assert.equal(hasSolarInput('SolarFlow 2400 AC', 0), false);
  assert.equal(hasSolarInput('SolarFlow 2400 AC+', null), false);
  assert.equal(hasSolarInput('SolarFlow 1600 AC+', 0), false);
  // A model table entry never hides a solar power the device does report.
  assert.equal(hasSolarInput('SolarFlow 2400 AC', 120), true);
});

const battery = {
  level: 60,
  chargePower: 0,
  dischargePower: 0,
  capacityKwh: 1.92,
  socSet: 100,
  minSoc: 10,
};

test('remaining time: the device figure (minutes), its sentinel ignored', () => {
  const discharging = { ...battery, dischargePower: 400 };
  assert.deepEqual(remainingTimeOf({ properties: { remainOutTime: 95 } }, discharging), {
    direction: 'discharge',
    minutes: 95,
  });
  const charging = { ...battery, chargePower: 800 };
  assert.deepEqual(remainingTimeOf({ remainInputTime: 42, remainOutTime: 95 }, charging), {
    direction: 'charge',
    minutes: 42,
  });
  // Idle: no remaining time, whatever the device says.
  assert.equal(remainingTimeOf({ remainOutTime: 95 }, battery), null);
  // 59940 (999 h) means "no estimate": computed instead (Zendure-HA formula):
  // 1.92 kWh x (60 - 10) % / 400 W = 2.4 h.
  assert.deepEqual(remainingTimeOf({ remainOutTime: REMAINING_TIME_UNKNOWN_IN_MIN }, discharging), {
    direction: 'discharge',
    minutes: 144,
  });
  // Charging to 100 %: 1.92 kWh x 40 % / 800 W = 0.96 h.
  assert.deepEqual(remainingTimeOf({}, charging), { direction: 'charge', minutes: 58 });
  // Nothing to compute from: no answer rather than a wrong one.
  assert.equal(remainingTimeOf({}, { ...discharging, capacityKwh: null }), null);
  assert.equal(remainingTimeOf({}, { ...discharging, level: 10 }), null);
});

test('remaining time reads short', () => {
  assert.equal(formatRemainingTime(45), '45 min');
  assert.equal(formatRemainingTime(125), '2 h 05');
  assert.equal(formatRemainingTime(999 * 60), '> 99 h');
});
