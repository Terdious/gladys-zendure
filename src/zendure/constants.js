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

// Product models supported by this integration. Values are the cloud
// `productModel` field, lowercased and trimmed. Matching is done on the
// lowercase/trimmed raw string and keeps inner spaces (it does NOT strip them).
//
// The reference project Zendure/Zendure-HA normalizes productModel with
// `.lower().replace(" ", "")` and keys its device map as e.g. "solarflow800",
// "solarflow1600ac+", "solarflow2400ac". We re-expand those to the spaced
// lowercase form the cloud actually returns. Entries marked UNVERIFIED are
// reconstructed spellings: confirm them against a real `deviceList` dump and
// adjust the casing/spacing if the cloud reports a different string.
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
};

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
export const MODEL_CAPABILITIES = {
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO]: {
    zenSdk: true,
    solarInput: true,
    battery: 'built-in',
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800]: { zenSdk: true, solarInput: true, battery: 'optional' },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_1600]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_AC]: {
    zenSdk: true,
    solarInput: false,
    battery: 'built-in',
  },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_PRO]: {
    zenSdk: true,
    solarInput: true,
    battery: 'built-in',
  },
  [SUPPORTED_PRODUCT_MODELS.HYPER_2000]: { zenSdk: false, solarInput: true, battery: 'optional' },
};

/**
 * Capabilities of a product model (case-insensitive), or the most permissive
 * guess for an unknown one (no local HTTP, solar input, battery unknown).
 * @param {string} productModel raw cloud productModel
 * @returns {{ zenSdk: boolean, solarInput: boolean, battery: 'built-in'|'optional' }}
 */
export function modelCapabilitiesOf(productModel) {
  const normalized = String(productModel || '')
    .toLowerCase()
    .trim();
  return MODEL_CAPABILITIES[normalized] || { zenSdk: false, solarInput: true, battery: 'optional' };
}
