// -----------------------------------------------------------------------------
// Zendure device mapping: which Gladys features each product model exposes,
// and how to read their values from the Zendure payloads.
//
// Ported from the Zendure service of Gladys core (zendure.deviceMapping.js +
// the metric extraction helpers of zendure.poll.js / zendure.mqtt.js).
//
// NOTE on categories/types: Gladys core maps these metrics to the
// `solar-battery` category (battery-level / battery-input-power /
// battery-output-power types), but @gladysassistant/integration-sdk 0.2.0
// does not expose that category yet. We use the closest standard ones
// instead: `battery` (integer, percent) for the state of charge and
// `energy-sensor` (power, watt) for the power metrics. Switch back to
// `solar-battery` once the SDK constants ship it.
//
// Attribution: the model list and the per-model power ratings are derived from
// the official Home Assistant integration Zendure/Zendure-HA (MIT License,
// (c) 2024 peteS-UK). Only factual protocol constants (model identifiers and
// rated power bounds, re-expressed in our own code style) are reused.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import { SUPPORTED_PRODUCT_MODELS } from './constants.js';

// Every supported model exposes the same five baseline features with identical
// `metricPaths`; the reference project does not rename these core properties per
// model. The only per-model difference we apply is the display `max` of the
// power features, sized from each model's rated power (see MODEL_MAX_POWER).
//
// The reference also exposes two extra off-grid sensors (gridOffPower /
// aggrGridOffPower) on the Pro/1600/2400 models. We intentionally keep the
// 5-feature baseline for consistency: the off-grid property names are not
// confirmed on the cloud payload and the SDK solar mapping is not settled yet.
//
// `metricPaths` are the candidate dot paths inside the MQTT `properties/report`
// payloads (and, as a fallback, inside the raw cloud deviceList entry).

// Rated power ceiling (watts) used as the display `max` of every power feature.
// These are metadata only: Gladys does not clip sensor values to them (see
// normalizeMetricValue), so each is sized generously above the model's rated
// input/output/solar power. Derived from Zendure/Zendure-HA setLimits()/maxSolar.
const MODEL_MAX_POWER = {
  // Backward-compatible generic cap kept for the original 800 Pro entry.
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO]: 12000,
  // 800 W class (out 800 / in 1000 / solar 1200).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800]: 1500,
  // 1600 W class (out/in/solar 1600).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_1600]: 2000,
  // 2400 W class (out 2400 / in up to 3200 / solar up to 3000).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400]: 4000,
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_AC]: 4000,
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_PRO]: 4000,
  // Hyper 2000 (out/in 1200 / solar 1600) — EXPERIMENTAL, untested hardware.
  [SUPPORTED_PRODUCT_MODELS.HYPER_2000]: 2000,
};

/**
 * Build the five baseline SolarFlow/Hyper features shared by every model.
 * @param {number} maxPower display ceiling (watts) for the power features
 * @returns {Array<object>} feature mappings
 */
function buildBaselineFeatures(maxPower) {
  return [
    {
      key: 'batteryLevel',
      name: 'Battery level',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      metricPaths: ['electricLevel', 'properties.electricLevel'],
    },
    {
      key: 'batteryInputPower',
      name: 'Battery input power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['packInputPower', 'properties.packInputPower'],
    },
    {
      key: 'batteryOutputPower',
      name: 'Battery output power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['outputPackPower', 'properties.outputPackPower'],
    },
    {
      key: 'homeOutputPower',
      name: 'Home output power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['outputHomePower', 'properties.outputHomePower'],
    },
    {
      key: 'solarInputPower',
      name: 'Solar input power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['solarInputPower', 'properties.solarInputPower'],
    },
  ];
}

// Feature mappings per product model. Keyed by the lowercase/trimmed cloud
// `productModel` string (see SUPPORTED_PRODUCT_MODELS).
export const MODEL_FEATURES = Object.fromEntries(
  Object.entries(MODEL_MAX_POWER).map(([productModel, maxPower]) => [
    productModel,
    buildBaselineFeatures(maxPower),
  ]),
);

/**
 * Feature mappings for one product model (case-insensitive match).
 * @param {string} productModel raw product model from the cloud
 * @returns {Array<object>} feature mappings ([] when unsupported)
 */
export function getFeaturesForModel(productModel) {
  const normalized = String(productModel || '')
    .toLowerCase()
    .trim();
  return MODEL_FEATURES[normalized] || [];
}

function getByPath(object, path) {
  return path.split('.').reduce((accumulator, key) => {
    if (accumulator && accumulator[key] !== undefined) {
      return accumulator[key];
    }
    return undefined;
  }, object);
}

function toNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

/**
 * Extract the first finite numeric value found at the candidate paths.
 * @param {object} payload MQTT payload or raw cloud device
 * @param {string[]} metricPaths candidate dot paths
 * @returns {number|null}
 */
export function extractMetricValue(payload, metricPaths) {
  for (const path of metricPaths) {
    const numericValue = toNumber(getByPath(payload, path));
    if (numericValue !== null) {
      return numericValue;
    }
  }
  return null;
}

/**
 * Recursively search a numeric value by key names (case-insensitive), parsing
 * embedded JSON strings on the way. Fallback used when the candidate paths
 * fail: cloud deviceList entries nest telemetry in model-specific ways.
 * @param {object|Array} input object/array to scan
 * @param {string[]} keys candidate key names
 * @returns {number|null}
 */
export function searchMetricByKeys(input, keys) {
  if (input === null || input === undefined) {
    return null;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const value = searchMetricByKeys(item, keys);
      if (value !== null) {
        return value;
      }
    }
    return null;
  }

  if (typeof input !== 'object') {
    return null;
  }

  const loweredKeys = keys.map((key) => key.toLowerCase());
  const entries = Object.entries(input);

  for (const [entryKey, entryValue] of entries) {
    if (loweredKeys.includes(entryKey.toLowerCase())) {
      const value = toNumber(entryValue);
      if (value !== null) {
        return value;
      }
    }

    if (
      typeof entryValue === 'string' &&
      (entryValue.startsWith('{') || entryValue.startsWith('['))
    ) {
      try {
        const parsedResult = searchMetricByKeys(JSON.parse(entryValue), keys);
        if (parsedResult !== null) {
          return parsedResult;
        }
      } catch {
        // Not JSON after all: keep scanning.
      }
    }
  }

  for (const [, entryValue] of entries) {
    const nestedResult = searchMetricByKeys(entryValue, keys);
    if (nestedResult !== null) {
      return nestedResult;
    }
  }

  return null;
}

/**
 * Normalize one metric value to its final Gladys shape: battery level is
 * clamped to 0-100, every metric is a rounded non-negative integer.
 * @param {string} metricKey feature key
 * @param {number} value raw value
 * @returns {number}
 */
export function normalizeMetricValue(metricKey, value) {
  if (metricKey === 'batteryLevel') {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  return Math.max(0, Math.round(value));
}
