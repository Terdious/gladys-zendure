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

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  cloud_key: '', // Zendure cloud authorization key (base64 token), secret
  poll_frequency: 30, // seconds, how often device telemetry is refreshed
  enable_local_mqtt: false, // opt-in to the per-device local MQTT broker (zenSDK)
};

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
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    cloud_key: String(raw.cloud_key ?? DEFAULT_CONFIG.cloud_key).trim(),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    enable_local_mqtt: toBoolean(raw.enable_local_mqtt, DEFAULT_CONFIG.enable_local_mqtt),
  };
}

// Gladys only accepts a fixed set of device poll frequencies, expressed in
// MILLISECONDS (DEVICE_POLL_FREQUENCIES in the core); any other value is
// rejected by POST /discovered_device.
const GLADYS_POLL_FREQUENCIES_IN_MS = [1000, 2000, 10000, 15000, 30000, 60000];

/**
 * Snap the user's poll_frequency (in seconds) to the closest poll frequency
 * accepted by Gladys, in milliseconds.
 * @param {number} seconds requested refresh interval
 * @returns {number} allowed poll frequency in milliseconds
 */
export function toGladysPollFrequency(seconds) {
  const requestedMs = Number(seconds) * 1000;
  return GLADYS_POLL_FREQUENCIES_IN_MS.reduce((best, candidate) =>
    Math.abs(candidate - requestedMs) < Math.abs(best - requestedMs) ? candidate : best,
  );
}
