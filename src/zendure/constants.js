// -----------------------------------------------------------------------------
// Zendure protocol constants.
//
// Ported from the Zendure service of Gladys core (zendure.constants.js). These
// values describe the "HA" (Home Assistant compatible) cloud API contract that
// Zendure exposes to third-party integrations.
//
// Attribution: the additional `productModel` strings below are cross-checked
// against the official Home Assistant integration Zendure/Zendure-HA (MIT
// License, (c) 2024 peteS-UK). Only factual protocol constants (model
// identifiers) are reused; the code is our own.
// -----------------------------------------------------------------------------

// Zendure cloud API paths (relative to the API URL decoded from the cloud key).
export const API = {
  DEVICE_LIST: '/api/ha/deviceList',
};

// Authentication material of the signed request headers.
export const AUTH = {
  CLIENT_ID: 'zenHa',
  SIGN_KEY: 'C*dafwArEOXK',
};

// Product models supported by this integration. Values are the canonical
// spelling of the cloud `productModel` field, lowercased.
//
// Matching follows Zendure/Zendure-HA (`productModel.lower().replace(" ", "")`,
// Python's replace dropping EVERY space): the raw cloud string is lowercased
// and stripped of all whitespace before the lookup (see productModelKeyOf), so
// "SolarFlow 800 Pro", "SolarFlow800Pro" and "Solarflow  800 pro" are the
// same model. Every name the former lowercase/trim match accepted still matches.
//
// Entries marked UNVERIFIED have not been seen on real hardware by this
// project; the whitespace-insensitive match makes their spacing irrelevant.
export const SUPPORTED_PRODUCT_MODELS = {
  // Confirmed against real SolarFlow 800 Pro hardware.
  SOLARFLOW_800_PRO: 'solarflow 800 pro',
  // Reference key "solarflow800".
  SOLARFLOW_800: 'solarflow 800',
  // UNVERIFIED: reference key "solarflow1600ac+" (a.k.a. SF1600 AC+).
  SOLARFLOW_1600: 'solarflow 1600 ac+',
  // UNVERIFIED: reference key "solarflow2400ac+" (AC-coupled 2400 flagship).
  SOLARFLOW_2400: 'solarflow 2400 ac+',
  // UNVERIFIED: reference key "solarflow2400ac".
  SOLARFLOW_2400_AC: 'solarflow 2400 ac',
  // UNVERIFIED: reference key "solarflow2400pro".
  SOLARFLOW_2400_PRO: 'solarflow 2400 pro',
  // EXPERIMENTAL + UNVERIFIED: reference key "hyper2000". The user cannot test
  // this on real hardware, so treat its telemetry mapping as best-effort.
  HYPER_2000: 'hyper 2000',
  // UNTESTED HARDWARE (from the reference keys only, no real device seen yet):
  // reference key "solarflow800plus" (class SolarFlow800Plus).
  SOLARFLOW_800_PLUS: 'solarflow 800 plus',
  // reference key "solarflow800pro2", driven by the SolarFlow800Pro class.
  SOLARFLOW_800_PRO_2: 'solarflow 800 pro 2',
  // reference key "solarflow4000ac+" (class SolarFlow4000AC_Plus).
  SOLARFLOW_4000: 'solarflow 4000 ac+',
};

/**
 * Lookup key of a cloud productModel: lowercased, every whitespace removed
 * (the Zendure-HA normalization).
 * @param {string} productModel raw cloud productModel
 * @returns {string}
 */
export function productModelKeyOf(productModel) {
  return String(productModel || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

const CANONICAL_MODEL_BY_KEY = new Map(
  Object.values(SUPPORTED_PRODUCT_MODELS).map((model) => [productModelKeyOf(model), model]),
);

/**
 * Canonical SUPPORTED_PRODUCT_MODELS value of a raw cloud productModel (the
 * key of every per-model table), or null for an unsupported model.
 * @param {string} productModel raw cloud productModel
 * @returns {string|null}
 */
export function canonicalProductModelOf(productModel) {
  return CANONICAL_MODEL_BY_KEY.get(productModelKeyOf(productModel)) ?? null;
}

// What each model offers, beyond its feature list:
//   - `zenSdk`: the device serves the zenSDK local HTTP API
//     (`GET /properties/report`, `POST /properties/write`). Zendure-HA drives
//     every SolarFlow 800 / 800 Plus / 800 Pro / 1600 AC+ / 2400 AC / 2400 AC+
//     / 2400 Pro / 4000 AC+ through its `ZendureZenSdk` class, the Hyper 2000
//     through the legacy MQTT-only `ZendureLegacy` class.
//   - `solarInput`: the device has MPPT (photovoltaic) inputs. Zendure-HA does
//     not settle it (every class sets a `maxSolar`, the AC-coupled ones
//     included), so it follows the product line: the "AC" models are
//     AC-coupled batteries without a PV input. A device that does report solar
//     power shows it anyway (see src/widgets.js), so a wrong entry hides nothing.
//   - `battery`: 'built-in' when the device always carries a pack (all-in-one
//     units: an AC-coupled device without a battery would do nothing), or
//     'optional' when it is an inverter hub that may run without any pack
//     (SolarFlow 800, Hyper 2000): its battery presence then comes from the
//     telemetry (packNum / packData).
//   - `offGrid`: the device has an off-grid (backup) output socket, reported
//     as `gridOffPower`. Zendure-HA creates its gridOffPower / aggrGridOffPower
//     sensors on the SolarFlow800Pro (800 Pro, 800 Pro 2), SolarFlow1600,
//     SolarFlow2400AC, SolarFlow2400AC_Plus, SolarFlow2400Pro and
//     SolarFlow4000AC_Plus classes only (not on 800, 800 Plus, Hyper 2000).
//   - `acCharge`: the device charges its packs from the grid (AC input,
//     reported as `gridInputPower`). Zendure-HA gives every class below a
//     negative charge limit in setLimits() (the older hubs it sets to 0 are not
//     supported here).
export const MODEL_CAPABILITIES = {
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO]: {
    zenSdk: true,
    solarInput: true,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800]: {
    zenSdk: true,
    solarInput: true,
    battery: 'optional',
    offGrid: false,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_1600]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_AC]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_PRO]: {
    zenSdk: true,
    solarInput: true,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  [SUPPORTED_PRODUCT_MODELS.HYPER_2000]: {
    zenSdk: false,
    solarInput: true,
    battery: 'optional',
    offGrid: false,
    acCharge: true,
  },
  // SolarFlow 800 Plus: same zenSDK class family as the 800 (setLimits
  // -1000/800) with a larger PV input (maxSolar 1500), no off-grid sensor in
  // Zendure-HA. Whether it always carries a pack is not settled by the
  // reference: 'optional' lets the telemetry tell (never hides a battery).
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PLUS]: {
    zenSdk: true,
    solarInput: true,
    battery: 'optional',
    offGrid: false,
    acCharge: true,
  },
  // SolarFlow 800 Pro 2: Zendure-HA drives it with the SolarFlow800Pro class.
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO_2]: {
    zenSdk: true,
    solarInput: true,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
  // SolarFlow 4000 AC+: AC-coupled (product line rule above; Zendure-HA still
  // sets maxSolar 2400 like on every class), internal 8 kWh pack (packType 70,
  // see energy.js), off-grid output.
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_4000]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
    offGrid: true,
    acCharge: true,
  },
};

/**
 * Capabilities of a product model (case-insensitive), or the most permissive
 * guess for an unknown one (no local HTTP, solar input, battery unknown).
 * @param {string} productModel raw cloud productModel
 * @returns {{ zenSdk: boolean, solarInput: boolean, battery: 'built-in'|'optional', offGrid: boolean, acCharge: boolean }}
 */
export function modelCapabilitiesOf(productModel) {
  return (
    MODEL_CAPABILITIES[canonicalProductModelOf(productModel)] || {
      zenSdk: false,
      solarInput: true,
      battery: 'optional',
      offGrid: false,
      acCharge: false,
    }
  );
}
