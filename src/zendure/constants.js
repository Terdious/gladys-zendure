// -----------------------------------------------------------------------------
// Zendure protocol constants.
//
// Ported from the Zendure service of Gladys core (zendure.constants.js). These
// values describe the "HA" (Home Assistant compatible) cloud API contract that
// Zendure exposes to third-party integrations.
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

// Product models supported by this integration (v1: SolarFlow 800 Pro only).
// Keys are compared lowercase/trimmed against the cloud `productModel` field.
export const SUPPORTED_PRODUCT_MODELS = {
  SOLARFLOW_800_PRO: 'solarflow 800 pro',
};
