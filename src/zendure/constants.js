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

// Rated AC charge (input) and discharge (output) power per model, in watts.
// They bound the control writes (src/zendure/control.js) and are the range of
// the writable power-limit features (src/zendure/deviceMapping.js).
// Attribution: derived from Zendure/Zendure-HA (MIT License, (c) 2024
// peteS-UK); only the factual constants are reused.
export const MODEL_POWER_RATINGS = {
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800]: { charge: 1000, discharge: 800 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO]: { charge: 1000, discharge: 800 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_1600]: { charge: 1600, discharge: 1600 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_AC]: { charge: 2400, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400]: { charge: 3200, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_PRO]: { charge: 3200, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.HYPER_2000]: { charge: 1200, discharge: 1200 },
};

// Rating used for a model missing from the table above.
export const DEFAULT_POWER_RATING = { charge: 800, discharge: 800 };

// zenSDK ranges of the SoC settings, in percent.
export const SOC_SET_RANGE = { min: 70, max: 100 };
export const MIN_SOC_RANGE = { min: 0, max: 50 };

// acMode values (zenSDK): 1 = AC input (charge from the grid), 2 = output.
export const AC_MODES = { charge: 1, discharge: 2 };

// Operating modes of a stationary battery, mirrored from the Gladys core
// (BATTERY_STORAGE_MODE in server/utils/constants.js, append-only there): the
// value of a battery-storage `mode` feature. The SDK does not export this enum.
export const BATTERY_STORAGE_MODE = {
  AUTO: 0,
  CHARGE: 1,
  DISCHARGE: 2,
  STANDBY: 3,
  TIME_OF_USE: 4,
  BACKUP: 5,
};
