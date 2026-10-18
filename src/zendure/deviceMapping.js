// -----------------------------------------------------------------------------
// Zendure device mapping: which Gladys features each product model exposes,
// and how to read their values from the Zendure payloads.
//
// Ported from the Zendure service of Gladys core (zendure.deviceMapping.js +
// the metric extraction helpers of zendure.poll.js / zendure.mqtt.js).
//
// Categories: the Gladys energy categories of a home battery system (Gladys
// 4.86+, SDK 0.12+). The state of charge and the pack power flows belong to
// `battery-storage` — NOT `battery`, which Gladys reads as the battery of a
// device to replace (low-battery alerts, weekly digest). The power the device
// delivers to the house is `home-output-sensor`, the PV input
// `energy-production-sensor`.
//
// The feature KEYS are the external ids of the features already created in
// Gladys: they never change, even where they read oddly. Per the zenSDK
// property reference, `packInputPower` is the pack DISCHARGE power and
// `outputPackPower` its CHARGE power (named from the inverter's side), hence
// `batteryInputPower` -> discharge and `batteryOutputPower` -> charge.
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

import {
  canonicalProductModelOf,
  MODEL_CAPABILITIES,
  SUPPORTED_PRODUCT_MODELS,
} from './constants.js';

// Every supported model exposes the same five baseline features with identical
// `metricPaths`; the reference project does not rename these core properties per
// model. The per-model differences are the display `max` of the power
// features, sized from each model's rated power (see MODEL_MAX_POWER), and
// the optional features of its capabilities (MODEL_CAPABILITIES): the
// off-grid output (`gridOffPower`, like Zendure-HA's gridOffPower /
// aggrGridOffPower sensors) and the grid charging input (`gridInputPower`).
// Every model also gets the two temperature features, published only when the
// device reports the property. New features are appended after the existing
// ones: a device created by an older release gets them with "Update" in the
// Discover tab, its existing features (and their ids) untouched.
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
  // Untested hardware, Zendure-HA setLimits()/maxSolar:
  // SolarFlow800Plus (in 1000 / out 800 / solar 1500).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PLUS]: 2000,
  // SolarFlow800Pro class, used for the 800 Pro 2 (in 1000 / out 800 / solar 1200).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO_2]: 1500,
  // SolarFlow4000AC_Plus (in 3200 / out 2400).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_4000]: 4000,
};

// Display ceiling of the energy indexes (kWh): metadata only, never reached.
const ENERGY_INDEX_MAX_KWH = 1000000;

// Temperatures: Zendure reports them in decikelvin (Zendure-HA converts every
// "°C" property with `(value - 2731) / 10`). A value outside this range is a
// placeholder (0 reads -273.1 °C) or a glitch, never published.
export const TEMPERATURE_RANGE_CELSIUS = { min: -40, max: 120 };

/**
 * Celsius (one decimal) of a decikelvin value, or null when absurd.
 * @param {number|null} decikelvin raw value
 * @returns {number|null}
 */
export function decikelvinToCelsius(decikelvin) {
  if (decikelvin === null || decikelvin === undefined || !Number.isFinite(Number(decikelvin))) {
    return null;
  }
  const celsius = Math.round(Number(decikelvin) - 2731) / 10;
  return celsius >= TEMPERATURE_RANGE_CELSIUS.min && celsius <= TEMPERATURE_RANGE_CELSIUS.max
    ? celsius
    : null;
}

/** Pack list of a payload (flat local payload or `properties` + `packData`). */
function packsOf(payload) {
  const packs = payload?.packData ?? payload?.properties?.packData;
  return Array.isArray(packs) ? packs : [];
}

/**
 * Temperature (°C) of the hottest pack: the highest valid `maxTemp` of
 * `packData`, null when no pack reports one.
 * @param {object} payload merged telemetry payload
 * @returns {number|null}
 */
export function hottestPackTemperature(payload) {
  const temperatures = packsOf(payload)
    .map((pack) => decikelvinToCelsius(toNumber(pack?.maxTemp)))
    .filter((value) => value !== null);
  return temperatures.length === 0 ? null : Math.max(...temperatures);
}

/**
 * Optional features of a model, from its capabilities, appended after the
 * baseline ones.
 * @param {number} maxPower display ceiling (watts) for the power features
 * @param {{ offGrid?: boolean, acCharge?: boolean }} capabilities
 * @returns {Array<object>} feature mappings
 */
function buildExtraFeatures(maxPower, capabilities) {
  const features = [];
  if (capabilities.offGrid) {
    features.push(
      {
        key: 'offGridPower',
        name: 'Off-grid output power',
        category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
        type: DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.OFF_GRID_POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: 0,
        max: maxPower,
        // Negative when the port feeds power in (Zendure-HA counts it as a
        // solar input): clamped to 0 by normalizeMetricValue, never integrated.
        metricPaths: ['gridOffPower', 'properties.gridOffPower'],
      },
      {
        key: 'offGridEnergy',
        name: 'Off-grid output energy',
        category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
        type: DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.OFF_GRID_INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: ENERGY_INDEX_MAX_KWH,
        computed: true,
      },
    );
  }
  if (capabilities.acCharge) {
    features.push(
      {
        key: 'gridInputPower',
        name: 'Grid charging power',
        category: DEVICE_FEATURE_CATEGORIES.GRID_SENSOR,
        type: DEVICE_FEATURE_TYPES.GRID_SENSOR.INPUT_POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: 0,
        max: maxPower,
        metricPaths: ['gridInputPower', 'properties.gridInputPower'],
      },
      {
        key: 'gridInputEnergy',
        name: 'Grid charging energy',
        category: DEVICE_FEATURE_CATEGORIES.GRID_SENSOR,
        type: DEVICE_FEATURE_TYPES.GRID_SENSOR.INPUT_INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: ENERGY_INDEX_MAX_KWH,
        computed: true,
      },
    );
  }
  // Read through `read` (converted, validated): a device that does not report
  // the property publishes nothing.
  features.push(
    {
      key: 'deviceTemperature',
      name: 'Device temperature',
      category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: TEMPERATURE_RANGE_CELSIUS.min,
      max: TEMPERATURE_RANGE_CELSIUS.max,
      read: (payload) =>
        decikelvinToCelsius(extractMetricValue(payload, ['hyperTmp', 'properties.hyperTmp'])),
    },
    {
      key: 'batteryMaxTemperature',
      name: 'Hottest pack temperature',
      category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: TEMPERATURE_RANGE_CELSIUS.min,
      max: TEMPERATURE_RANGE_CELSIUS.max,
      read: hottestPackTemperature,
    },
  );
  return features;
}

/**
 * Build the baseline SolarFlow/Hyper features shared by every model: the five
 * measured ones, then the computed energy ones.
 * @param {number} maxPower display ceiling (watts) for the power features
 * @returns {Array<object>} feature mappings
 */
function buildBaselineFeatures(maxPower) {
  return [
    {
      key: 'batteryLevel',
      name: 'Battery level',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      metricPaths: ['electricLevel', 'properties.electricLevel'],
    },
    {
      key: 'batteryInputPower',
      name: 'Battery discharge power',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['packInputPower', 'properties.packInputPower'],
    },
    {
      key: 'batteryOutputPower',
      name: 'Battery charge power',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['outputPackPower', 'properties.outputPackPower'],
    },
    {
      key: 'homeOutputPower',
      name: 'Home output power',
      category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
      type: DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['outputHomePower', 'properties.outputHomePower'],
    },
    {
      key: 'solarInputPower',
      name: 'Solar input power',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: maxPower,
      metricPaths: ['solarInputPower', 'properties.solarInputPower'],
    },
    // Computed features (`computed: true`): no metric of their own, their
    // values come from src/zendure/energy.js (integrated powers, capacity).
    {
      key: 'batteryChargeEnergy',
      name: 'Battery charged energy',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_INDEX,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_INDEX_MAX_KWH,
      computed: true,
    },
    {
      key: 'batteryDischargeEnergy',
      name: 'Battery discharged energy',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_INDEX,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_INDEX_MAX_KWH,
      computed: true,
    },
    {
      key: 'homeOutputEnergy',
      name: 'Home output energy',
      category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
      type: DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.INDEX,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_INDEX_MAX_KWH,
      computed: true,
    },
    {
      key: 'solarEnergy',
      name: 'Solar energy',
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: ENERGY_INDEX_MAX_KWH,
      computed: true,
    },
    {
      key: 'batteryEnergyRemaining',
      name: 'Battery energy remaining',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_ENERGY_REMAINING,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 100,
      computed: true,
    },
  ];
}

// Feature names per language (`feature_names` option), the same words as the
// Gladys interface uses for these feature types. Names are only applied to
// newly created devices: a name is the user's to edit once the device exists.
export const FEATURE_NAMES = {
  batteryLevel: {
    en: 'Battery level',
    fr: 'Niveau de batterie',
    de: 'Batteriestand',
    es: 'Nivel de batería',
  },
  batteryOutputPower: {
    en: 'Battery charge power',
    fr: 'Puissance de charge',
    de: 'Ladeleistung',
    es: 'Potencia de carga',
  },
  batteryInputPower: {
    en: 'Battery discharge power',
    fr: 'Puissance de décharge',
    de: 'Entladeleistung',
    es: 'Potencia de descarga',
  },
  homeOutputPower: {
    en: 'Home output power',
    fr: 'Puissance vers la maison',
    de: 'Leistung zum Haus',
    es: 'Potencia de salida del hogar',
  },
  solarInputPower: {
    en: 'Solar input power',
    fr: "Puissance d'entrée solaire",
    de: 'Solare Eingangsleistung',
    es: 'Potencia de entrada solar',
  },
  batteryChargeEnergy: {
    en: 'Battery charged energy',
    fr: 'Énergie chargée',
    de: 'Geladene Energie',
    es: 'Energía cargada',
  },
  batteryDischargeEnergy: {
    en: 'Battery discharged energy',
    fr: 'Énergie déchargée',
    de: 'Entladene Energie',
    es: 'Energía descargada',
  },
  homeOutputEnergy: {
    en: 'Home output energy',
    fr: 'Énergie vers la maison',
    de: 'Energie zum Haus',
    es: 'Energía de salida del hogar',
  },
  solarEnergy: {
    en: 'Solar energy',
    fr: 'Énergie solaire',
    de: 'Solarenergie',
    es: 'Energía solar',
  },
  batteryEnergyRemaining: {
    en: 'Battery energy remaining',
    fr: 'Énergie restante en batterie',
    de: 'Verbleibende Batterieenergie',
    es: 'Energía restante de la batería',
  },
  offGridPower: {
    en: 'Off-grid output power',
    fr: 'Puissance de la sortie hors réseau',
    de: 'Leistung des Off-Grid-Ausgangs',
    es: 'Potencia de la salida fuera de red',
  },
  offGridEnergy: {
    en: 'Off-grid output energy',
    fr: 'Énergie de la sortie hors réseau',
    de: 'Energie des Off-Grid-Ausgangs',
    es: 'Energía de la salida fuera de red',
  },
  gridInputPower: {
    en: 'Grid charging power',
    fr: 'Puissance de charge depuis le réseau',
    de: 'Ladeleistung aus dem Netz',
    es: 'Potencia de carga desde la red',
  },
  gridInputEnergy: {
    en: 'Grid charging energy',
    fr: 'Énergie chargée depuis le réseau',
    de: 'Aus dem Netz geladene Energie',
    es: 'Energía cargada desde la red',
  },
  deviceTemperature: {
    en: 'Device temperature',
    fr: "Température de l'appareil",
    de: 'Gerätetemperatur',
    es: 'Temperatura del dispositivo',
  },
  batteryMaxTemperature: {
    en: 'Hottest pack temperature',
    fr: 'Température du pack le plus chaud',
    de: 'Temperatur des wärmsten Packs',
    es: 'Temperatura del pack más caliente',
  },
};

/**
 * Name of a feature in the configured language, English when unknown.
 * @param {{ key: string, name: string }} featureMapping
 * @param {string} language `feature_names` option
 * @returns {string}
 */
export function featureNameFor(featureMapping, language) {
  return FEATURE_NAMES[featureMapping.key]?.[language] ?? featureMapping.name;
}

// Feature mappings per product model. Keyed by the canonical
// SUPPORTED_PRODUCT_MODELS value (see canonicalProductModelOf).
export const MODEL_FEATURES = Object.fromEntries(
  Object.entries(MODEL_MAX_POWER).map(([productModel, maxPower]) => [
    productModel,
    [
      ...buildBaselineFeatures(maxPower),
      ...buildExtraFeatures(maxPower, MODEL_CAPABILITIES[productModel] || {}),
    ],
  ]),
);

/**
 * Feature mappings for one product model (case- and whitespace-insensitive).
 * @param {string} productModel raw product model from the cloud
 * @returns {Array<object>} feature mappings ([] when unsupported)
 */
export function getFeaturesForModel(productModel) {
  return MODEL_FEATURES[canonicalProductModelOf(productModel)] || [];
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

/**
 * Final Gladys value of a measured feature from a payload, or null when the
 * payload does not carry it. Computed features have no value of their own
 * (see src/zendure/energy.js).
 * @param {object} featureMapping one MODEL_FEATURES entry
 * @param {object} payload MQTT / local API payload or raw cloud device
 * @param {{ search?: boolean }} [options] fall back on a recursive key search
 * @returns {number|null}
 */
export function featureValueOf(featureMapping, payload, { search = false } = {}) {
  if (featureMapping.computed) {
    return null;
  }
  if (typeof featureMapping.read === 'function') {
    return featureMapping.read(payload);
  }
  let value = extractMetricValue(payload, featureMapping.metricPaths);
  if (value === null && search) {
    value = searchMetricByKeys(
      payload,
      featureMapping.metricPaths.map((path) => path.split('.').pop()),
    );
  }
  return value === null ? null : normalizeMetricValue(featureMapping.key, value);
}
