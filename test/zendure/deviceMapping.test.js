import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { FEATURE_NAME_LANGUAGES } from '../../src/config.js';
import { MODEL_FEATURES, FEATURE_NAMES, featureNameFor } from '../../src/zendure/deviceMapping.js';

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
