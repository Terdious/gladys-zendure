// -----------------------------------------------------------------------------
// Battery packs as separate Gladys devices (opt-in `enable_pack_devices`).
//
// A SolarFlow / Hyper reports its packs in two ways:
//   - the `packData` array of a cloud MQTT `properties/report`, of the zenSDK
//     local API report and of the legacy JSON reports of a local broker: one
//     entry per pack serial, RAW values (`socLevel` %, `maxTemp` decikelvin,
//     `totalVol` hundredths of a volt, `batcur` signed int16 in tenths of an
//     ampere, as the diagnostic already decodes them);
//   - the native local MQTT topics `Zendure/sensor/{packSn}/{packSn}_{metric}`,
//     one value per message, already SCALED (volts, amperes, °C).
// The pack devices are measurements only: the battery system as a whole stays
// the parent device, the one the Gladys energy features count.
//
// Categories (existing SDK ones only), chosen so that nothing is counted twice:
//   - state of charge: `battery` / `integer` (%). NOT `battery-storage` /
//     `battery-level`: that one is the home battery system the Gladys energy
//     dashboards aggregate, and the parent device already carries it — a pack
//     there would count the same charge twice. The trade-off: a pack below the
//     Gladys low-battery threshold shows in its low-battery check (documented);
//   - hottest cell temperature: `device-temperature-sensor` / `decimal` (°C),
//     like the parent's "hottest pack temperature" (kept out of room averages);
//   - voltage, signed current, signed power: `energy-sensor` / `voltage`,
//     `current`, `power` — plain measurements, never integrated into an index.
// The state of health is left to the diagnostic: its only fitting type
// (`maintenance` / `life-remaining`) is newer than some supported cores, and
// an unknown category would make Gladys refuse the whole pack device.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import { decikelvinToCelsius, TEMPERATURE_RANGE_CELSIUS } from './deviceMapping.js';

// Device type namespace of the external ids (`<type>:<pack serial>`), distinct
// from the parent's `solarflow:<device key>`: no feature id can collide.
export const PACK_DEVICE_TYPE = 'solarflow-pack';

// Plausibility bounds: a value outside is a placeholder or a glitch, never
// published (a SolarFlow pack is a ~48-58 V battery).
const VOLTAGE_RANGE = { min: 0, max: 100 };
const CURRENT_RANGE = { min: -200, max: 200 };
const POWER_RANGE = { min: -10000, max: 10000 };

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

function within(value, range) {
  return value !== null && value >= range.min && value <= range.max ? value : null;
}

/**
 * A raw unsigned 16-bit register read as signed (the packs report a negative
 * current or power as 65504 for -32).
 * @param {unknown} raw
 * @returns {number|null}
 */
export function signedInt16(raw) {
  const number = toNumber(raw);
  if (number === null || !Number.isInteger(number)) {
    return number;
  }
  return number >= 0x8000 && number <= 0xffff ? number - 0x10000 : number;
}

function percentOf(raw) {
  const number = toNumber(raw);
  return number === null || number < 0 || number > 100 ? null : Math.round(number);
}

/** °C of a scaled local value; a decikelvin one (> 1000) is converted too. */
function scaledCelsiusOf(raw) {
  const number = toNumber(raw);
  if (number === null) {
    return null;
  }
  if (number > 1000) {
    return decikelvinToCelsius(number);
  }
  return within(round(number, 1), TEMPERATURE_RANGE_CELSIUS);
}

/** Volts of a scaled local value; a raw one in hundredths (> 1000) too. */
function scaledVoltsOf(raw) {
  const number = toNumber(raw);
  if (number === null) {
    return null;
  }
  return within(round(number > 1000 ? number / 100 : number, 2), VOLTAGE_RANGE);
}

// One mapping per pack feature: `raw` reads a `packData` entry, `scaled` the
// flat payload of the native local topics of the pack.
export const PACK_FEATURES = [
  {
    key: 'level',
    name: 'Pack level',
    category: DEVICE_FEATURE_CATEGORIES.BATTERY,
    type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
    raw: (pack) => percentOf(pack.socLevel),
    scaled: (pack) => percentOf(pack.socLevel),
  },
  {
    key: 'temperature',
    name: 'Pack temperature',
    category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: TEMPERATURE_RANGE_CELSIUS.min,
    max: TEMPERATURE_RANGE_CELSIUS.max,
    raw: (pack) => decikelvinToCelsius(toNumber(pack.maxTemp)),
    scaled: (pack) => scaledCelsiusOf(pack.maxTemp),
  },
  {
    key: 'voltage',
    name: 'Pack voltage',
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
    unit: DEVICE_FEATURE_UNITS.VOLT,
    min: VOLTAGE_RANGE.min,
    max: VOLTAGE_RANGE.max,
    raw: (pack) => {
      const centivolts = toNumber(pack.totalVol);
      return centivolts === null ? null : within(round(centivolts / 100, 2), VOLTAGE_RANGE);
    },
    scaled: (pack) => scaledVoltsOf(pack.totalVol),
  },
  {
    key: 'current',
    name: 'Pack current',
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
    unit: DEVICE_FEATURE_UNITS.AMPERE,
    min: CURRENT_RANGE.min,
    max: CURRENT_RANGE.max,
    raw: (pack) => {
      const deciamperes = signedInt16(pack.batcur);
      return deciamperes === null ? null : within(round(deciamperes / 10, 1), CURRENT_RANGE);
    },
    scaled: (pack) => {
      const amperes = toNumber(pack.batcur);
      return amperes === null ? null : within(round(amperes, 1), CURRENT_RANGE);
    },
  },
  {
    key: 'power',
    name: 'Pack power',
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
    unit: DEVICE_FEATURE_UNITS.WATT,
    min: POWER_RANGE.min,
    max: POWER_RANGE.max,
    raw: (pack) => {
      const watts = signedInt16(pack.power);
      return watts === null ? null : within(Math.round(watts), POWER_RANGE);
    },
    scaled: (pack) => {
      const watts = toNumber(pack.power);
      return watts === null ? null : within(Math.round(watts), POWER_RANGE);
    },
  },
];

// Feature names per language (`feature_names` option).
export const PACK_FEATURE_NAMES = {
  level: {
    en: 'Pack level',
    fr: 'Niveau du pack',
    de: 'Ladestand des Packs',
    es: 'Nivel del pack',
  },
  temperature: {
    en: 'Pack temperature',
    fr: 'Température du pack',
    de: 'Temperatur des Packs',
    es: 'Temperatura del pack',
  },
  voltage: {
    en: 'Pack voltage',
    fr: 'Tension du pack',
    de: 'Spannung des Packs',
    es: 'Tensión del pack',
  },
  current: {
    en: 'Pack current',
    fr: 'Courant du pack',
    de: 'Strom des Packs',
    es: 'Corriente del pack',
  },
  power: {
    en: 'Pack power',
    fr: 'Puissance du pack',
    de: 'Leistung des Packs',
    es: 'Potencia del pack',
  },
};

// The word of the device name `<parent name> — pack <n>`, per language.
const PACK_WORD = { en: 'pack', fr: 'pack', de: 'Pack', es: 'pack' };

/**
 * Name of a pack feature in the configured language, English when unknown.
 * @param {{ key: string, name: string }} featureMapping
 * @param {string} language `feature_names` option
 */
export function packFeatureNameFor(featureMapping, language) {
  return PACK_FEATURE_NAMES[featureMapping.key]?.[language] ?? featureMapping.name;
}

/**
 * Name of a pack device: `<parent name> — pack <n>`.
 * @param {string} parentName name of the battery the pack belongs to
 * @param {number} index 1-based position of the pack
 * @param {string} language `feature_names` option
 */
export function packDeviceNameOf(parentName, index, language) {
  return `${parentName} — ${PACK_WORD[language] ?? PACK_WORD.en} ${index}`;
}

/**
 * The packs of a payload that carry a serial: `packData` (flat or under
 * `properties`), in their reported order.
 * @param {object|null} payload
 * @returns {Array<object>}
 */
export function packListOf(payload) {
  const packs = payload?.packData ?? payload?.properties?.packData;
  if (!Array.isArray(packs)) {
    return [];
  }
  return packs.filter(
    (pack) => pack && typeof pack === 'object' && typeof pack.sn === 'string' && pack.sn.trim(),
  );
}

/**
 * The values of one pack, keyed by feature key (null when not reported or
 * absurd).
 * @param {object} pack a `packData` entry (raw) or a native local payload (scaled)
 * @param {{ scaled: boolean }} options
 * @returns {Record<string, number|null>}
 */
export function packValuesOf(pack, { scaled }) {
  return Object.fromEntries(
    PACK_FEATURES.map((featureMapping) => [
      featureMapping.key,
      (scaled ? featureMapping.scaled : featureMapping.raw)(pack || {}),
    ]),
  );
}
