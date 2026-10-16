import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { FEATURE_NAME_LANGUAGES } from '../../src/config.js';
import {
  MODEL_FEATURES,
  FEATURE_NAMES,
  featureNameFor,
  supportedOptionsFor,
  acModeOfBatteryMode,
  batteryModeOfAcMode,
} from '../../src/zendure/deviceMapping.js';
import {
  AC_MODES,
  BATTERY_STORAGE_MODE,
  MODEL_POWER_RATINGS,
} from '../../src/zendure/constants.js';

// key -> [category, type, unit]. The keys are the feature external ids of the
// devices users already created: they must never change.
const EXPECTED = {
  batteryLevel: ['battery-storage', 'battery-level', 'percent'],
  batteryInputPower: ['battery-storage', 'discharge-power', 'watt'],
  batteryOutputPower: ['battery-storage', 'charge-power', 'watt'],
  homeOutputPower: ['home-output-sensor', 'power', 'watt'],
  solarInputPower: ['energy-production-sensor', 'power', 'watt'],
  batteryChargeEnergy: ['battery-storage', 'charge-index', 'kilowatt-hour'],
  batteryDischargeEnergy: ['battery-storage', 'discharge-index', 'kilowatt-hour'],
  homeOutputEnergy: ['home-output-sensor', 'index', 'kilowatt-hour'],
  solarEnergy: ['energy-production-sensor', 'index', 'kilowatt-hour'],
  batteryEnergyRemaining: ['battery-storage', 'battery-energy-remaining', 'kilowatt-hour'],
  // Writable settings (Gladys core docs/specs/battery-storage.md A.5).
  outputLimit: ['home-output', 'power-limit', 'watt'],
  inputLimit: ['battery-storage', 'grid-charge-power-limit', 'watt'],
  socSet: ['battery-storage', 'target-charge-limit', 'percent'],
  minSoc: ['battery-storage', 'target-discharge-limit', 'percent'],
  acMode: ['battery-storage', 'mode', null],
};

test('every model maps the Zendure metrics to the Gladys energy categories', () => {
  for (const [model, features] of Object.entries(MODEL_FEATURES)) {
    assert.deepEqual(
      Object.fromEntries(features.map((f) => [f.key, [f.category, f.type, f.unit]])),
      EXPECTED,
      model,
    );
  }
});

test('the zenSDK pack flows land on the right side: packInputPower is the discharge', () => {
  const features = Object.values(MODEL_FEATURES)[0].filter((f) => !f.computed);
  const byPath = Object.fromEntries(features.map((f) => [f.metricPaths[0], f.type]));
  assert.equal(byPath.packInputPower, DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER);
  assert.equal(byPath.outputPackPower, DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER);
});

test('no feature uses the device-battery category (low-battery alerts)', () => {
  for (const features of Object.values(MODEL_FEATURES)) {
    for (const feature of features) {
      assert.notEqual(feature.category, DEVICE_FEATURE_CATEGORIES.BATTERY, feature.key);
      assert.ok(
        Object.values(DEVICE_FEATURE_TYPES[categoryKey(feature.category)]).includes(feature.type),
        `${feature.key}: ${feature.type} is not a ${feature.category} type`,
      );
    }
  }
});

function categoryKey(category) {
  return Object.keys(DEVICE_FEATURE_CATEGORIES).find(
    (key) => DEVICE_FEATURE_CATEGORIES[key] === category,
  );
}

test('every feature has a name in every feature_names language', () => {
  for (const feature of Object.values(MODEL_FEATURES)[0]) {
    assert.equal(FEATURE_NAMES[feature.key].en, feature.name, `${feature.key}: English name`);
    for (const language of FEATURE_NAME_LANGUAGES) {
      assert.ok(FEATURE_NAMES[feature.key][language], `${feature.key}.${language}`);
      assert.equal(featureNameFor(feature, language), FEATURE_NAMES[feature.key][language]);
    }
  }
  assert.equal(featureNameFor({ key: 'unknown', name: 'Raw' }, 'fr'), 'Raw');
});

test('the writable settings range over each model rating and the zenSDK SoC ranges', () => {
  assert.equal(Object.keys(MODEL_FEATURES).length, Object.keys(MODEL_POWER_RATINGS).length);
  for (const [model, features] of Object.entries(MODEL_FEATURES)) {
    const byKey = Object.fromEntries(features.map((f) => [f.key, f]));
    const rating = MODEL_POWER_RATINGS[model];
    assert.deepEqual([byKey.outputLimit.min, byKey.outputLimit.max], [0, rating.discharge], model);
    assert.deepEqual([byKey.inputLimit.min, byKey.inputLimit.max], [0, rating.charge], model);
    assert.deepEqual([byKey.socSet.min, byKey.socSet.max], [70, 100], model);
    assert.deepEqual([byKey.minSoc.min, byKey.minSoc.max], [0, 50], model);
    assert.deepEqual([byKey.acMode.min, byKey.acMode.max], [0, 5], model);
    const commands = features.filter((f) => f.command).map((f) => f.key);
    assert.deepEqual(commands, ['outputLimit', 'inputLimit', 'socSet', 'minSoc', 'acMode']);
  }
  // The 2400 AC+ charges faster than it discharges.
  const sf2400 = Object.fromEntries(MODEL_FEATURES['solarflow 2400 ac+'].map((f) => [f.key, f]));
  assert.equal(sf2400.inputLimit.max, 3200);
  assert.equal(sf2400.outputLimit.max, 2400);
});

test('the mode offers only charge and discharge, mapped to acMode both ways', () => {
  const acMode = Object.values(MODEL_FEATURES)[0].find((f) => f.key === 'acMode');
  assert.deepEqual(supportedOptionsFor(acMode, 'en'), [
    { value: BATTERY_STORAGE_MODE.CHARGE, label: 'Charge', sort_order: 0 },
    { value: BATTERY_STORAGE_MODE.DISCHARGE, label: 'Discharge', sort_order: 1 },
  ]);
  assert.deepEqual(
    supportedOptionsFor(acMode, 'de').map((option) => option.label),
    ['Laden', 'Entladen'],
  );
  assert.equal(supportedOptionsFor({ key: 'socSet' }, 'en'), undefined);

  // Gladys -> zenSDK: every offered mode has an acMode, the others none.
  assert.equal(acModeOfBatteryMode(BATTERY_STORAGE_MODE.CHARGE), 'charge');
  assert.equal(acModeOfBatteryMode('2'), 'discharge');
  for (const mode of ['AUTO', 'STANDBY', 'TIME_OF_USE', 'BACKUP']) {
    assert.equal(acModeOfBatteryMode(BATTERY_STORAGE_MODE[mode]), null, mode);
  }
  assert.equal(acModeOfBatteryMode('toString'), null);
  // zenSDK -> Gladys.
  assert.equal(batteryModeOfAcMode(AC_MODES.charge), BATTERY_STORAGE_MODE.CHARGE);
  assert.equal(batteryModeOfAcMode(AC_MODES.discharge), BATTERY_STORAGE_MODE.DISCHARGE);
  assert.equal(batteryModeOfAcMode(0), null);
  assert.equal(batteryModeOfAcMode(7), null);
});

test('the core mode enum is mirrored as is (append-only values)', () => {
  assert.deepEqual(BATTERY_STORAGE_MODE, {
    AUTO: 0,
    CHARGE: 1,
    DISCHARGE: 2,
    STANDBY: 3,
    TIME_OF_USE: 4,
    BACKUP: 5,
  });
});
