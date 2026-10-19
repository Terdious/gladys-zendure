// -----------------------------------------------------------------------------
// Devices deleted in Gladys (the "ignore-set").
//
// The tracking universe of the integration is the Zendure cloud deviceList,
// not the Gladys device list: without this set, a battery the user deleted in
// Gladys would keep being polled, subscribed, evaluated, and could keep the
// account's single cloud session alive (taking it away from Home Assistant).
//
// An entry is the device part of the Gladys external id, `<type>:<platform
// id>` (e.g. `solarflow:AbC123`): it names one Gladys device whatever its
// blueprint, and it never changes (external ids are forever).
//
// Persistence: a free key of the integration configuration (`setConfig` keys
// outside the manifest config_schema, never shown in the UI). The set mirrors
// the Gladys device list, so it lives with it in the Gladys database: a
// restored Gladys backup restores both together, and a reinstalled container
// (fresh /data volume) does not resurrect the tracking of a deleted battery.
// /data stays for the energy totals, written every few minutes.
// -----------------------------------------------------------------------------

export const IGNORED_DEVICES_CONFIG_KEY = 'ignored_devices';

/**
 * Parse the stored ignore-set: a JSON array of strings (as saved by
 * serializeIgnoredDevices), or an array already. Anything else is empty: a
 * corrupt value must never stop the integration.
 * @param {unknown} raw stored value
 * @returns {Set<string>}
 */
export function parseIgnoredDevices(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return new Set();
    }
  }
  if (!Array.isArray(list)) {
    return new Set();
  }
  return new Set(list.filter((entry) => typeof entry === 'string' && entry.trim() !== ''));
}

/**
 * Stored form of the ignore-set: a sorted JSON array (stable, so an unchanged
 * set always serializes the same).
 * @param {Iterable<string>} ignored
 * @returns {string}
 */
export function serializeIgnoredDevices(ignored) {
  return JSON.stringify([...ignored].sort());
}

/**
 * The ignore-set entry of a Gladys device: its external id without the
 * integration prefix (`ext:<selector>:`), or null when it is not one of ours.
 * @param {object} gladys Gladys SDK instance
 * @param {{ external_id?: string }} device Gladys device
 * @returns {string|null}
 */
export function ignoreEntryOf(gladys, device) {
  const externalId = device?.external_id;
  const prefix = gladys.externalId('');
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const entry = externalId.slice(prefix.length);
  return entry.includes(':') ? entry : null;
}
