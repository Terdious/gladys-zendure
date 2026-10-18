// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  cloud_key: '', // Zendure cloud authorization key (base64 token), secret
  poll_frequency: 30, // seconds, how often device telemetry is refreshed
  // Read and drive the devices through their zenSDK local HTTP API (what Home
  // Assistant uses). On by default: a device that does not answer simply
  // stays on (or falls back to) the cloud.
  enable_local_http: true,
  // Optional `SERIAL=ADDRESS` pairs, for devices whose address the cloud does
  // not give and whose mDNS name does not resolve in the container.
  local_http_addresses: '',
  enable_local_mqtt: false, // opt-in to the per-device local MQTT broker (zenSDK)
  feature_names: 'en', // language of the feature names of newly discovered devices
  // Savings estimate without a grid meter (src/zendure/savings.js). Prices
  // per kWh in the user's currency; no manifest default (null here): an empty
  // field shows its placeholder, and a missing price disables the estimate.
  tariff_mode: 'none', // none | base | peak_offpeak
  price_base: null,
  price_peak: null,
  price_offpeak: null,
  offpeak_hours: '', // e.g. "22:00-06:00" or "01:30-07:30,12:30-14:30"
  resale_enabled: false,
  resale_price: null,
  // The off-peak hours and the calendar days of the savings are in this
  // timezone (Gladys gives an integration no instance timezone).
  tariff_timezone: 'Europe/Paris',
};

// Values the `tariff_mode` option accepts; anything else is `none`.
export const TARIFF_MODE_VALUES = ['none', 'base', 'peak_offpeak'];

// Languages the `feature_names` option accepts (the Gladys interface ones);
// anything else falls back to English.
export const FEATURE_NAME_LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Coerce a value coming from a form (which may be a string like "true") into a
 * boolean.
 * @param {unknown} value raw value
 * @param {boolean} fallback default when the value is missing
 * @returns {boolean}
 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Coerce a form value into a positive finite number. An empty field coerces to
 * 0 (`Number('') === 0`) and garbage to NaN: both would otherwise snap to the
 * FASTEST allowed poll frequency (1 s) instead of the default.
 * @param {unknown} value raw value
 * @param {number} fallback default when the value is not a positive number
 * @returns {number}
 */
function toPositiveNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

/**
 * Coerce a form value into a finite number >= 0 (a decimal comma accepted),
 * or null when empty or invalid: a price is never guessed.
 * @param {unknown} value raw value
 * @returns {number|null}
 */
function toPriceOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const numericValue = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    cloud_key: String(raw.cloud_key ?? DEFAULT_CONFIG.cloud_key).trim(),
    poll_frequency: toPositiveNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency),
    enable_local_http: toBoolean(raw.enable_local_http, DEFAULT_CONFIG.enable_local_http),
    local_http_addresses: String(
      raw.local_http_addresses ?? DEFAULT_CONFIG.local_http_addresses,
    ).trim(),
    enable_local_mqtt: toBoolean(raw.enable_local_mqtt, DEFAULT_CONFIG.enable_local_mqtt),
    feature_names: FEATURE_NAME_LANGUAGES.includes(raw.feature_names)
      ? raw.feature_names
      : DEFAULT_CONFIG.feature_names,
    tariff_mode: TARIFF_MODE_VALUES.includes(raw.tariff_mode)
      ? raw.tariff_mode
      : DEFAULT_CONFIG.tariff_mode,
    price_base: toPriceOrNull(raw.price_base),
    price_peak: toPriceOrNull(raw.price_peak),
    price_offpeak: toPriceOrNull(raw.price_offpeak),
    offpeak_hours: String(raw.offpeak_hours ?? DEFAULT_CONFIG.offpeak_hours).trim(),
    resale_enabled: toBoolean(raw.resale_enabled, DEFAULT_CONFIG.resale_enabled),
    resale_price: toPriceOrNull(raw.resale_price),
    tariff_timezone: String(raw.tariff_timezone ?? '').trim() || DEFAULT_CONFIG.tariff_timezone,
  };
}

// Gladys only accepts a fixed set of device poll frequencies, expressed in
// MILLISECONDS (DEVICE_POLL_FREQUENCIES, mirrored by the SDK); any other value
// is rejected by POST /discovered_device. Ascending, so a request halfway
// between two values (45 s) snaps to the faster one.
const GLADYS_POLL_FREQUENCIES_IN_MS = Object.values(DEVICE_POLL_FREQUENCIES).sort((a, b) => a - b);

/**
 * Snap the user's poll_frequency (in seconds) to the closest poll frequency
 * accepted by Gladys, in milliseconds.
 * @param {number} seconds requested refresh interval
 * @returns {number} allowed poll frequency in milliseconds
 */
export function toGladysPollFrequency(seconds) {
  const requestedSeconds = Number(seconds);
  // Defense in depth (normalizeConfig already guards): a non-positive or
  // non-finite request must snap to the DEFAULT, not to the fastest frequency.
  const effectiveSeconds =
    Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? requestedSeconds
      : DEFAULT_CONFIG.poll_frequency;
  const requestedMs = effectiveSeconds * 1000;
  return GLADYS_POLL_FREQUENCIES_IN_MS.reduce((best, candidate) =>
    Math.abs(candidate - requestedMs) < Math.abs(best - requestedMs) ? candidate : best,
  );
}
