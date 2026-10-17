// -----------------------------------------------------------------------------
// Energy meters computed from the power telemetry.
//
// Zendure reports instantaneous powers only (W): no cumulative kWh counter.
// Gladys tracks energy from cumulative INDEX features (the energy-monitoring
// service turns the index deltas of a production meter into thirty-minute
// production, and the history charts read every index), so the integration
// integrates each power flow over time itself, like the official Home
// Assistant integration does (left Riemann sum): between two payloads the
// power is the last one reported.
//
// The totals must survive container restarts (an index that falls back to 0
// would read as a huge negative delta), so they are saved under /data, the
// only writable volume of the sandbox.
//
// Attribution: the pack capacity table (serial prefix -> kWh) comes from the
// official Home Assistant integration Zendure/Zendure-HA (MIT License, (c) 2024
// peteS-UK). Only those factual constants are reused; the code is our own.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'energy' });

// Power feature key -> energy index feature key. The power keys are the
// feature keys of deviceMapping.js (batteryOutputPower is the pack CHARGE,
// batteryInputPower the DISCHARGE, see there).
export const ENERGY_FLOWS = {
  batteryOutputPower: 'batteryChargeEnergy',
  batteryInputPower: 'batteryDischargeEnergy',
  solarInputPower: 'solarEnergy',
  homeOutputPower: 'homeOutputEnergy',
};

// A longer silence between two payloads is a gap (device offline, broker
// down): it is not integrated, the last power is unknown over it.
export const MAX_INTEGRATION_GAP_IN_MS = 5 * 60 * 1000;
// How often the totals are written to disk (and at shutdown).
export const ENERGY_SAVE_INTERVAL_IN_MS = 5 * 60 * 1000;

const WATT_MILLISECONDS_PER_KWH = 1000 * 3600 * 1000;

/**
 * Capacity (kWh) of one battery pack, from its serial number prefix (and pack
 * type for the SolarFlow 4000 internal pack). Unknown packs return null.
 * @param {{ sn?: string, packType?: number }} pack `packData[]` entry
 * @returns {number|null}
 */
export function packCapacityKwh(pack) {
  const sn = String(pack?.sn || '');
  switch (sn.charAt(0)) {
    case 'A':
      return sn.charAt(3) === '3' ? 2.4 : 0.96; // AIO 2400 / AB1000
    case 'B':
      return Number(pack.packType) === 70 ? 8.0 : 0.96; // SF4000 internal / AB1000S
    case 'C':
      return 1.92; // AB2000
    case 'F':
    case 'G':
      return 2.88; // AB3000 / AB3000L
    case 'J':
      return 2.4; // 2400 internal pack
    default:
      return null;
  }
}

/**
 * Total capacity (kWh) of a device from the `packData` array of its payload,
 * or null when no pack is known (no packData, or only unknown packs).
 * @param {object} payload merged MQTT payload
 * @returns {number|null}
 */
export function deviceCapacityKwh(payload) {
  const packs = payload?.packData ?? payload?.properties?.packData;
  if (!Array.isArray(packs) || packs.length === 0) {
    return null;
  }
  const capacities = packs.map(packCapacityKwh).filter((value) => value !== null);
  if (capacities.length === 0) {
    return null;
  }
  return Math.round(capacities.reduce((sum, value) => sum + value, 0) * 100) / 100;
}

/**
 * Energy meter store: per device, the cumulative kWh of each flow plus the
 * last power and timestamp used to integrate the next interval.
 * @param {{ dataDir?: string }} [options] directory of `energy.json`
 */
export function createEnergyMeters({ dataDir = process.env.ZENDURE_DATA_DIR || '/data' } = {}) {
  const filePath = join(dataDir, 'energy.json');
  // deviceKey -> { lastAt, power: { flowKey: W }, kwh: { indexKey: kWh } }
  let meters = new Map();
  let dirty = false;
  let saveFailureLogged = false;
  // Saves run one after the other (the periodic timer, the push cleanup and
  // the shutdown hook can all ask at once), each with its own temporary file:
  // two concurrent saves sharing one temp file made the second rename fail
  // with ENOENT (the first had already moved it).
  let saveQueue = Promise.resolve();
  let saveCount = 0;

  async function writeNow() {
    if (!dirty) {
      return;
    }
    // Cleared BEFORE the snapshot: an update landing during the write marks
    // the meters dirty again for the next save instead of being forgotten.
    dirty = false;
    const devices = Object.fromEntries(
      [...meters].map(([deviceKey, meter]) => [deviceKey, { kwh: { ...meter.kwh } }]),
    );
    saveCount += 1;
    const temporaryPath = `${filePath}.${process.pid}.${saveCount}.tmp`;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({ version: 1, devices }));
      await rename(temporaryPath, filePath);
      saveFailureLogged = false;
    } catch (e) {
      dirty = true;
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!saveFailureLogged) {
        saveFailureLogged = true;
        logger.warn(`energy: could not save ${filePath} (${e.message}), retrying later`);
      }
    }
  }

  function meterOf(deviceKey) {
    if (!meters.has(deviceKey)) {
      meters.set(deviceKey, { lastAt: 0, power: {}, kwh: {} });
    }
    return meters.get(deviceKey);
  }

  return {
    /** Load the totals saved by a previous run (missing file: start at 0). */
    async load() {
      try {
        const saved = JSON.parse(await readFile(filePath, 'utf8'));
        meters = new Map(
          Object.entries(saved?.devices || {}).map(([deviceKey, meter]) => [
            deviceKey,
            // The last power is not restored: the gap since the save is not
            // integrated, the next payload restarts the interval.
            { lastAt: 0, power: {}, kwh: { ...meter.kwh } },
          ]),
        );
      } catch (e) {
        if (e.code !== 'ENOENT') {
          logger.warn(`energy: could not read ${filePath} (${e.message}), meters start at 0`);
        }
      }
    },

    /**
     * Integrate the interval since the previous payload of this device, then
     * remember the new powers. Returns the totals (kWh) after the update.
     * @param {string} deviceKey Zendure device key
     * @param {Record<string, number>} powers power feature key -> W (missing keys keep their last value)
     * @param {number} at timestamp of the payload (ms)
     * @returns {Record<string, number>} index feature key -> kWh
     */
    update(deviceKey, powers, at) {
      const meter = meterOf(deviceKey);
      const elapsed = at - meter.lastAt;
      if (meter.lastAt > 0 && elapsed > 0 && elapsed <= MAX_INTEGRATION_GAP_IN_MS) {
        for (const [powerKey, indexKey] of Object.entries(ENERGY_FLOWS)) {
          const power = meter.power[powerKey];
          if (Number.isFinite(power) && power > 0) {
            meter.kwh[indexKey] =
              (meter.kwh[indexKey] || 0) + (power * elapsed) / WATT_MILLISECONDS_PER_KWH;
            dirty = true;
          }
        }
      }
      for (const [powerKey, value] of Object.entries(powers)) {
        if (powerKey in ENERGY_FLOWS && Number.isFinite(value)) {
          meter.power[powerKey] = Math.max(0, value);
        }
      }
      if (at > meter.lastAt) {
        meter.lastAt = at;
      }
      return this.totals(deviceKey);
    },

    /** Current totals (kWh, Wh precision) of a device, 0 for an unseen flow. */
    totals(deviceKey) {
      const meter = meters.get(deviceKey);
      return Object.fromEntries(
        Object.values(ENERGY_FLOWS).map((indexKey) => [
          indexKey,
          Math.round((meter?.kwh[indexKey] || 0) * 1000) / 1000,
        ]),
      );
    },

    /**
     * Write the totals when they changed (atomic: temp file then rename),
     * serialized with the other saves.
     * @returns {Promise<void>}
     */
    save() {
      const run = saveQueue.then(() => writeNow());
      saveQueue = run.catch(() => {});
      return run;
    },
  };
}
