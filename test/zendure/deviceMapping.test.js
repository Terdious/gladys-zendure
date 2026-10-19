import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { FEATURE_NAME_LANGUAGES } from '../../src/config.js';
import {
  MODEL_FEATURES,
  FEATURE_NAMES,
  featureNameFor,
  featureValueOf,
  getFeaturesForModel,
  decikelvinToCelsius,
  hottestPackTemperature,
  remainingMinutesOf,
  REMAINING_TIME_NO_ESTIMATE_IN_MIN,
} from '../../src/zendure/deviceMapping.js';
import { REMAINING_TIME_UNKNOWN_IN_MIN } from '../../src/zendure/battery.js';
import {
  canonicalProductModelOf,
  MODEL_CAPABILITIES,
  modelCapabilitiesOf,
  productModelKeyOf,
  SUPPORTED_PRODUCT_MODELS,
} from '../../src/zendure/constants.js';
import { maxPowerFor } from '../../src/zendure/control.js';

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

// Optional features, per capability (appended after the baseline ones).
const OFF_GRID = {
  offGridPower: ['home-output-sensor', 'off-grid-power', 'watt'],
  offGridEnergy: ['home-output-sensor', 'off-grid-index', 'kilowatt-hour'],
};
const AC_CHARGE = {
  gridInputPower: ['grid-sensor', 'input-power', 'watt'],
  gridInputEnergy: ['grid-sensor', 'input-index', 'kilowatt-hour'],
};
const TEMPERATURES = {
  deviceTemperature: ['device-temperature-sensor', 'decimal', 'celsius'],
  batteryMaxTemperature: ['device-temperature-sensor', 'decimal', 'celsius'],
};
const REMAINING_TIMES = {
  remainingDischargeTime: ['duration', 'integer', 'minutes'],
  remainingChargeTime: ['duration', 'integer', 'minutes'],
};

test('every model maps the Zendure metrics to the Gladys energy categories', () => {
  for (const [model, features] of Object.entries(MODEL_FEATURES)) {
    const capabilities = MODEL_CAPABILITIES[model];
    assert.deepEqual(
      Object.fromEntries(features.map((f) => [f.key, [f.category, f.type, f.unit]])),
      {
        ...EXPECTED,
        ...(capabilities.offGrid ? OFF_GRID : {}),
        ...(capabilities.acCharge ? AC_CHARGE : {}),
        ...TEMPERATURES,
        ...REMAINING_TIMES,
      },
      model,
    );
    // The baseline features come first, in their historical order.
    assert.deepEqual(
      features.slice(0, 10).map((f) => f.key),
      Object.keys(EXPECTED),
      model,
    );
  }
});

test('off-grid features only on the models with an off-grid port (Zendure-HA classes)', () => {
  const offGridModels = Object.keys(MODEL_FEATURES).filter((model) =>
    MODEL_FEATURES[model].some((f) => f.key === 'offGridPower'),
  );
  assert.deepEqual(offGridModels.sort(), [
    'solarflow 1600 ac+',
    'solarflow 2400 ac',
    'solarflow 2400 ac+',
    'solarflow 2400 pro',
    'solarflow 4000 ac+',
    'solarflow 800 pro',
    'solarflow 800 pro 2',
  ]);
  for (const model of ['solarflow 800', 'solarflow 800 plus', 'hyper 2000']) {
    assert.ok(!MODEL_FEATURES[model].some((f) => f.key.startsWith('offGrid')), model);
    // Every supported model charges from the grid (negative HA charge limit).
    assert.ok(
      MODEL_FEATURES[model].some((f) => f.key === 'gridInputPower'),
      model,
    );
  }
});

test('productModel matching ignores case and every whitespace, like Zendure-HA', () => {
  for (const variant of [
    'SolarFlow 800 Pro',
    'solarflow 800 pro',
    '  SolarFlow 800 Pro  ',
    'SolarFlow800Pro',
    'SOLARFLOW  800\tPRO',
  ]) {
    assert.equal(canonicalProductModelOf(variant), SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO);
    assert.equal(getFeaturesForModel(variant), MODEL_FEATURES['solarflow 800 pro'], variant);
  }
  assert.equal(productModelKeyOf('SolarFlow 2400 AC+'), 'solarflow2400ac+');
  // Close names stay apart.
  assert.equal(canonicalProductModelOf('SolarFlow2400AC'), 'solarflow 2400 ac');
  assert.equal(canonicalProductModelOf('SolarFlow 2400AC+'), 'solarflow 2400 ac+');
  assert.equal(canonicalProductModelOf('SolarFlow 800 Pro2'), 'solarflow 800 pro 2');
  assert.equal(canonicalProductModelOf('SolarFlow 800 Plus'), 'solarflow 800 plus');
  assert.equal(canonicalProductModelOf('SolarFlow 4000 AC+'), 'solarflow 4000 ac+');
  assert.equal(canonicalProductModelOf('Hyper2000'), 'hyper 2000');
  assert.equal(canonicalProductModelOf('Some Future Model'), null);
  assert.deepEqual(getFeaturesForModel(''), []);
  assert.equal(modelCapabilitiesOf('Unknown').offGrid, false);
  // Every reference key of Zendure-HA we support resolves.
  for (const key of [
    'solarflow800',
    'solarflow800pro',
    'solarflow800pro2',
    'solarflow800plus',
    'solarflow1600ac+',
    'solarflow2400ac',
    'solarflow2400ac+',
    'solarflow2400pro',
    'solarflow4000ac+',
    'hyper2000',
  ]) {
    assert.ok(canonicalProductModelOf(key), key);
  }
});

test('new models: ratings and capabilities from Zendure-HA', () => {
  assert.equal(maxPowerFor('SolarFlow 800 Plus', 'charge', {}), 1000);
  assert.equal(maxPowerFor('SolarFlow 800 Plus', 'discharge', {}), 800);
  assert.equal(maxPowerFor('SolarFlow 800 Pro 2', 'charge', {}), 1000);
  assert.equal(maxPowerFor('SolarFlow 800 Pro 2', 'discharge', {}), 800);
  assert.equal(maxPowerFor('SolarFlow 4000 AC+', 'charge', {}), 3200);
  assert.equal(maxPowerFor('SolarFlow 4000 AC+', 'discharge', {}), 2400);
  // Spacing variants hit the same rating.
  assert.equal(maxPowerFor('SolarFlow4000AC+', 'charge', {}), 3200);
  assert.deepEqual(modelCapabilitiesOf('SolarFlow 4000 AC+'), {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  });
  assert.equal(modelCapabilitiesOf('SolarFlow 800 Plus').solarInput, true);
  assert.equal(modelCapabilitiesOf('SolarFlow 800 Plus').battery, 'optional');
  assert.equal(modelCapabilitiesOf('SolarFlow 800 Pro 2').battery, 'built-in');
  const solar = (model) => getFeaturesForModel(model).find((f) => f.key === 'solarInputPower');
  assert.ok(solar('SolarFlow 800 Plus').max >= 1500);
  assert.ok(solar('SolarFlow 4000 AC+').max >= 3200);
  // Existing models keep their ratings.
  assert.equal(maxPowerFor('SolarFlow 800 Pro', 'charge', {}), 1000);
  assert.equal(solar('SolarFlow 800 Pro').max, 12000);
});

test('off-grid and grid charging powers are clamped to >= 0 and rounded', () => {
  const [offGrid, gridInput] = ['offGridPower', 'gridInputPower'].map((key) =>
    getFeaturesForModel('SolarFlow 2400 AC').find((f) => f.key === key),
  );
  assert.equal(featureValueOf(offGrid, { gridOffPower: 312.6 }), 313);
  // Negative: the port feeds power in (solar), not an output.
  assert.equal(featureValueOf(offGrid, { properties: { gridOffPower: -150 } }), 0);
  assert.equal(featureValueOf(offGrid, {}), null);
  assert.equal(featureValueOf(gridInput, { properties: { gridInputPower: 1800 } }), 1800);
  assert.equal(featureValueOf(gridInput, { gridInputPower: -3 }), 0);
});

test('temperatures: decikelvin to Celsius, absurd values ignored', () => {
  assert.equal(decikelvinToCelsius(2731), 0);
  assert.equal(decikelvinToCelsius(3011), 28);
  assert.equal(decikelvinToCelsius(2986), 25.5);
  assert.equal(decikelvinToCelsius(2531), -20);
  assert.equal(decikelvinToCelsius(0), null, '-273.1 °C is a placeholder');
  assert.equal(decikelvinToCelsius(65535), null);
  assert.equal(decikelvinToCelsius(null), null);
  assert.equal(decikelvinToCelsius('abc'), null);

  const features = getFeaturesForModel('SolarFlow 800 Pro');
  const device = features.find((f) => f.key === 'deviceTemperature');
  const pack = features.find((f) => f.key === 'batteryMaxTemperature');
  assert.equal(featureValueOf(device, { properties: { hyperTmp: 3051 } }), 32);
  assert.equal(featureValueOf(device, { hyperTmp: 0 }), null);
  assert.equal(featureValueOf(device, {}), null, 'not reported: nothing published');

  const payload = {
    packData: [
      { sn: 'A', maxTemp: 2981 },
      { sn: 'B', maxTemp: 3031 },
      { sn: 'C', maxTemp: 0 },
      { sn: 'D' },
    ],
  };
  assert.equal(hottestPackTemperature(payload), 30);
  assert.equal(featureValueOf(pack, payload), 30);
  assert.equal(featureValueOf(pack, { properties: { packData: [{ maxTemp: 2961 }] } }), 23);
  assert.equal(featureValueOf(pack, { packData: [{ maxTemp: 0 }] }), null);
  assert.equal(featureValueOf(pack, {}), null);
});

test('remaining times: zenSDK minutes, the 999 h sentinel never published', () => {
  assert.equal(REMAINING_TIME_NO_ESTIMATE_IN_MIN, 59940, '999 h in minutes');
  assert.equal(REMAINING_TIME_UNKNOWN_IN_MIN, REMAINING_TIME_NO_ESTIMATE_IN_MIN, 'same as widgets');
  assert.equal(remainingMinutesOf(135), 135);
  assert.equal(remainingMinutesOf(12.6), 13);
  assert.equal(remainingMinutesOf(0), 0, 'a real reading: nothing left');
  assert.equal(remainingMinutesOf(59939), 59939);
  assert.equal(remainingMinutesOf(59940), null, 'no estimate');
  assert.equal(remainingMinutesOf(65535), null);
  assert.equal(remainingMinutesOf(-1), null);
  assert.equal(remainingMinutesOf(null), null);

  const [discharge, charge] = ['remainingDischargeTime', 'remainingChargeTime'].map((key) =>
    getFeaturesForModel('SolarFlow 800 Pro').find((f) => f.key === key),
  );
  assert.equal(featureValueOf(discharge, { properties: { remainOutTime: 135 } }), 135);
  assert.equal(featureValueOf(discharge, { remainOutTime: 59940 }), null);
  assert.equal(featureValueOf(charge, { remainInputTime: 42, remainOutTime: 59940 }), 42);
  assert.equal(featureValueOf(charge, { properties: { remainInputTime: 59940 } }), null);
  assert.equal(featureValueOf(charge, {}), null, 'not reported: nothing published');
  // Built-in pack: published even when the telemetry says packNum 0.
  assert.equal(featureValueOf(discharge, { packNum: 0, remainOutTime: 20 }), 20);

  // Hubs whose pack is optional: nothing once the telemetry says there is none.
  for (const model of ['SolarFlow 800', 'SolarFlow 800 Plus', 'Hyper 2000']) {
    const hub = getFeaturesForModel(model).find((f) => f.key === 'remainingDischargeTime');
    assert.equal(featureValueOf(hub, { packNum: 2, remainOutTime: 60 }), 60, model);
    assert.equal(featureValueOf(hub, { remainOutTime: 60 }), 60, `${model}: presence unknown`);
    assert.equal(featureValueOf(hub, { properties: { packNum: 0, remainOutTime: 0 } }), null);
    assert.equal(featureValueOf(hub, { packData: [], remainOutTime: 0 }), null, model);
  }
});

test('the zenSDK pack flows land on the right side: packInputPower is the discharge', () => {
  const features = Object.values(MODEL_FEATURES)[0].filter((f) => f.metricPaths);
  const byPath = Object.fromEntries(features.map((f) => [f.metricPaths[0], f.type]));
  assert.equal(byPath.packInputPower, DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER);
  assert.equal(byPath.outputPackPower, DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER);
});

test('no feature uses the device-battery category (low-battery alerts)', () => {
  for (const features of Object.values(MODEL_FEATURES)) {
    for (const feature of features) {
      assert.notEqual(feature.category, DEVICE_FEATURE_CATEGORIES.BATTERY, feature.key);
      // The device temperature has no types of its own: Gladys reads it as a
      // generic decimal sensor.
      const types =
        feature.category === DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR
          ? DEVICE_FEATURE_TYPES.SENSOR
          : DEVICE_FEATURE_TYPES[categoryKey(feature.category)];
      assert.ok(
        Object.values(types).includes(feature.type),
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
  for (const feature of Object.values(MODEL_FEATURES).flat()) {
    assert.equal(FEATURE_NAMES[feature.key].en, feature.name, `${feature.key}: English name`);
    for (const language of FEATURE_NAME_LANGUAGES) {
      assert.ok(FEATURE_NAMES[feature.key][language], `${feature.key}.${language}`);
      assert.equal(featureNameFor(feature, language), FEATURE_NAMES[feature.key][language]);
    }
  }
  assert.equal(featureNameFor({ key: 'unknown', name: 'Raw' }, 'fr'), 'Raw');
});
