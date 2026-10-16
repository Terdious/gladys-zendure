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
// Commands (`command: true`, writable from the device card): the zenSDK
// battery settings, mapped as the Gladys core specifies for a plug-in storage
// system (docs/specs/battery-storage.md A.5, docs/specs/home-output.md A.4):
// outputLimit -> home-output / power-limit, inputLimit -> battery-storage /
// grid-charge-power-limit, socSet / minSoc -> target-charge-limit /
// target-discharge-limit, acMode -> mode (lossy, see BATTERY_MODE_BY_AC_MODE).
// The AC-port limits are deliberately NOT also published as charge / discharge
// power limits: two controls over one setting would drift apart.
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
  AC_MODES,
  BATTERY_STORAGE_MODE,
  MIN_SOC_RANGE,
  MODEL_POWER_RATINGS,
  SOC_SET_RANGE,
  SUPPORTED_PRODUCT_MODELS,
} from './constants.js';

// Every supported model exposes the same five baseline features with identical
// `metricPaths`; the reference project does not rename these core properties per
// model. The only per-model difference we apply is the display `max` of the
// power features, sized from each model's rated power (see MODEL_MAX_POWER),
// and the range of the writable power limits: the model's rated AC power
// (MODEL_POWER_RATINGS), the bound the control path clamps to.
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

// Display ceiling of the energy indexes (kWh): metadata only, never reached.
const ENERGY_INDEX_MAX_KWH = 1000000;

// Gladys battery mode <-> zenSDK acMode. Lossy: acMode only selects the
// direction of the AC port (1 = AC input, 2 = AC output); the power actually
// flowing stays bounded by the limits and the sun, so it is not a "charge /
// discharge at full power" order. AUTO, STANDBY, TIME_OF_USE and BACKUP have
// no acMode value: they are not offered (supported_options) and refused.
const AC_MODE_BY_BATTERY_MODE = {
  [BATTERY_STORAGE_MODE.CHARGE]: 'charge',
  [BATTERY_STORAGE_MODE.DISCHARGE]: 'discharge',
};
const BATTERY_MODE_BY_AC_MODE = {
  [AC_MODES.charge]: BATTERY_STORAGE_MODE.CHARGE,
  [AC_MODES.discharge]: BATTERY_STORAGE_MODE.DISCHARGE,
};

/**
 * `ac_mode` command mode of a Gladys battery mode.
 * @param {number|string} batteryMode BATTERY_STORAGE_MODE value
 * @returns {'charge'|'discharge'|null} null when Zendure has no such mode
 */
export function acModeOfBatteryMode(batteryMode) {
  const value = Number(batteryMode);
  return Object.hasOwn(AC_MODE_BY_BATTERY_MODE, value) ? AC_MODE_BY_BATTERY_MODE[value] : null;
}

/**
 * Gladys battery mode of a reported zenSDK acMode.
 * @param {number} acMode reported acMode
 * @returns {number|null} null for a value outside the zenSDK contract
 */
export function batteryModeOfAcMode(acMode) {
  return Object.hasOwn(BATTERY_MODE_BY_AC_MODE, acMode) ? BATTERY_MODE_BY_AC_MODE[acMode] : null;
}

// Labels of the modes offered on the `mode` feature (supported_options), per
// `feature_names` language. Gladys shows its own translation of the mode; the
// label is the fallback.
export const BATTERY_MODE_LABELS = {
  [BATTERY_STORAGE_MODE.CHARGE]: { en: 'Charge', fr: 'Charge', de: 'Laden', es: 'Carga' },
  [BATTERY_STORAGE_MODE.DISCHARGE]: {
    en: 'Discharge',
    fr: 'Décharge',
    de: 'Entladen',
    es: 'Descarga',
  },
};

/**
 * Build the writable battery settings of one model.
 * @param {{ charge: number, discharge: number }} rating rated AC power (W)
 * @returns {Array<object>} feature mappings
 */
function buildCommandFeatures(rating) {
  return [
    {
      key: 'outputLimit',
      name: 'Output power limit',
      category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT,
      type: DEVICE_FEATURE_TYPES.HOME_OUTPUT.POWER_LIMIT,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: rating.discharge,
      // Widened at discovery by what the device reports (maxPowerFor).
      ratingDirection: 'discharge',
      command: true,
      metricPaths: ['outputLimit', 'properties.outputLimit'],
    },
    {
      key: 'inputLimit',
      name: 'Grid charge power limit',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.GRID_CHARGE_POWER_LIMIT,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: rating.charge,
      ratingDirection: 'charge',
      command: true,
      metricPaths: ['inputLimit', 'properties.inputLimit'],
    },
    {
      key: 'socSet',
      name: 'Target charge level',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.TARGET_CHARGE_LIMIT,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: SOC_SET_RANGE.min,
      max: SOC_SET_RANGE.max,
      // Reported in percent or tenths of a percent depending on the firmware.
      socScaled: true,
      command: true,
      metricPaths: ['socSet', 'properties.socSet'],
    },
    {
      key: 'minSoc',
      name: 'Discharge reserve',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.TARGET_DISCHARGE_LIMIT,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: MIN_SOC_RANGE.min,
      max: MIN_SOC_RANGE.max,
      socScaled: true,
      command: true,
      metricPaths: ['minSoc', 'properties.minSoc'],
    },
    {
      key: 'acMode',
      name: 'AC mode',
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.MODE,
      unit: null,
      // The whole BATTERY_STORAGE_MODE range: the modes are a set, which ones
      // Zendure offers is declared by `modes` (supported_options).
      min: BATTERY_STORAGE_MODE.AUTO,
      max: BATTERY_STORAGE_MODE.BACKUP,
      modes: [BATTERY_STORAGE_MODE.CHARGE, BATTERY_STORAGE_MODE.DISCHARGE],
      command: true,
      metricPaths: ['acMode', 'properties.acMode'],
    },
  ];
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
  outputLimit: {
    en: 'Output power limit',
    fr: 'Limite de puissance de sortie',
    de: 'Ausgangsleistungsgrenze',
    es: 'Límite de potencia de salida',
  },
  inputLimit: {
    en: 'Grid charge power limit',
    fr: 'Limite de puissance de charge réseau',
    de: 'Netzladeleistungsgrenze',
    es: 'Límite de potencia de carga desde la red',
  },
  socSet: {
    en: 'Target charge level',
    fr: 'Niveau de charge cible',
    de: 'Ziel-Ladestand',
    es: 'Nivel de carga objetivo',
  },
  minSoc: {
    en: 'Discharge reserve',
    fr: 'Réserve de décharge',
    de: 'Entladereserve',
    es: 'Reserva de descarga',
  },
  acMode: {
    en: 'AC mode',
    fr: 'Mode AC',
    de: 'AC-Modus',
    es: 'Modo AC',
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

// Feature mappings per product model. Keyed by the lowercase/trimmed cloud
// `productModel` string (see SUPPORTED_PRODUCT_MODELS).
export const MODEL_FEATURES = Object.fromEntries(
  Object.entries(MODEL_MAX_POWER).map(([productModel, maxPower]) => [
    productModel,
    [
      ...buildBaselineFeatures(maxPower),
      ...buildCommandFeatures(MODEL_POWER_RATINGS[productModel]),
    ],
  ]),
);

/**
 * `supported_options` of a mode feature, labelled in the configured language.
 * @param {{ modes?: number[] }} featureMapping
 * @param {string} language `feature_names` option
 * @returns {Array<{ value: number, label: string, sort_order: number }>|undefined}
 */
export function supportedOptionsFor(featureMapping, language) {
  if (!featureMapping.modes) {
    return undefined;
  }
  return featureMapping.modes.map((value, index) => ({
    value,
    label: BATTERY_MODE_LABELS[value][language] ?? BATTERY_MODE_LABELS[value].en,
    sort_order: index,
  }));
}

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
