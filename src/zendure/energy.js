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
// Daily figures (the "Energy today" widget): Gladys gives an integration no
// instance timezone, and each widget instance names its own. So the store does
// not reset anything at a midnight: it keeps, per device, a snapshot of the
// totals at the start of every 30-minute slot (UTC-aligned: every whole- and
// half-hour offset puts a local midnight on a slot boundary) over the last
// SLOT_RETENTION_IN_MS, saved in energy.json with the totals (one atomic
// write, so the two never disagree). The energy of a day is the totals now
// minus the snapshot of the first slot at or after its local midnight. A slot
// snapshot is taken at the first payload of the slot, the interval it closes
// split at the boundary: the snapshot holds the energy integrated up to the
// boundary exactly.
//
// Attribution: the pack capacity table (serial prefix -> kWh) comes from the
// official Home Assistant integration Zendure/Zendure-HA (MIT License, (c) 2024
// peteS-UK). Only those factual constants are reused; the code is our own.
//
// Savings estimate (src/zendure/savings.js): each device also keeps the totals
// at the start of its open slot, the stored energy with its average cost and
// the day / month / year accumulators, in a `savings` object of its entry
// (additive: a 1.7.0 file loads without it, and an older release reading a
// newer file ignores it). A slot is valued when it closes, at the first
// payload of the next one, with the tariff set by setTariff().
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  closeSavingsSlot,
  createSavingsState,
  deserializeSavings,
  savingsReport,
  serializeSavings,
} from './savings.js';

const logger = createLogger({ name: 'energy' });

// Power feature key -> energy index feature key. The power keys are the
// feature keys of deviceMapping.js (batteryOutputPower is the pack CHARGE,
// batteryInputPower the DISCHARGE, see there).
export const ENERGY_FLOWS = {
  batteryOutputPower: 'batteryChargeEnergy',
  batteryInputPower: 'batteryDischargeEnergy',
  solarInputPower: 'solarEnergy',
  homeOutputPower: 'homeOutputEnergy',
  // Only on the models with the matching feature (deviceMapping.js): a device
  // never reporting the power keeps the index at 0, and buildEnergyStates
  // publishes the indexes of the device's own features only. Added after the
  // first four: a saved file without them loads them at 0 (additive format).
  offGridPower: 'offGridEnergy',
  gridInputPower: 'gridInputEnergy',
};

// A longer silence between two payloads is a gap (device offline, broker
// down): it is not integrated, the last power is unknown over it.
export const MAX_INTEGRATION_GAP_IN_MS = 5 * 60 * 1000;
// How often the totals are written to disk (and at shutdown).
export const ENERGY_SAVE_INTERVAL_IN_MS = 5 * 60 * 1000;

const WATT_MILLISECONDS_PER_KWH = 1000 * 3600 * 1000;

// Slot snapshots: 30 minutes (the Gladys energy slot), kept 26 h (a 25 h
// day on a DST change, plus margin).
export const ENERGY_SLOT_IN_MS = 30 * 60 * 1000;
export const SLOT_RETENTION_IN_MS = 26 * 60 * 60 * 1000;
// Order of the kWh values of a saved slot (`[slotStart, ...kWh]`, compact:
// 17 devices x 52 slots). Written in the file, so a later order change still
// reads an older file right. Only the flows of the "Energy today" widget are
// snapshotted (the off-grid and grid charging indexes keep their totals only),
// which keeps the file the size and shape it had.
const SLOT_FIELDS = [
  'batteryChargeEnergy',
  'batteryDischargeEnergy',
  'solarEnergy',
  'homeOutputEnergy',
];

/**
 * Start (ms) of the 30-minute UTC slot holding a timestamp.
 * @param {number} at timestamp (ms)
 * @returns {number}
 */
export function slotStartOf(at) {
  return Math.floor(at / ENERGY_SLOT_IN_MS) * ENERGY_SLOT_IN_MS;
}

const roundWh = (kwh) => Math.round(kwh * 1000) / 1000;

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
  // Tariff of the savings estimate (src/zendure/savings.js buildTariff), null:
  // no estimate (the slot marks still advance).
  let tariff = null;

  async function writeNow() {
    if (!dirty) {
      return;
    }
    // Cleared BEFORE the snapshot: an update landing during the write marks
    // the meters dirty again for the next save instead of being forgotten.
    dirty = false;
    const devices = Object.fromEntries(
      [...meters].map(([deviceKey, meter]) => [
        deviceKey,
        {
          kwh: { ...meter.kwh },
          slots: meter.slots.map((slot) => [slot.at, ...SLOT_FIELDS.map((key) => slot.kwh[key])]),
          savings: serializeSavings(meter.savings),
        },
      ]),
    );
    saveCount += 1;
    const temporaryPath = `${filePath}.${process.pid}.${saveCount}.tmp`;
    try {
      await mkdir(dataDir, { recursive: true });
      // Version 1 still: `slots`, `slot_fields` and `savings` are additive,
      // an older release reads the totals and ignores them.
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, slot_fields: SLOT_FIELDS, devices }),
      );
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
      meters.set(deviceKey, {
        lastAt: 0,
        power: {},
        kwh: {},
        slots: [],
        savings: createSavingsState(),
        storedKwh: null,
      });
    }
    return meters.get(deviceKey);
  }

  /** Add the energy of the last powers held for `elapsed` ms. */
  function integrate(meter, elapsed) {
    for (const [powerKey, indexKey] of Object.entries(ENERGY_FLOWS)) {
      const power = meter.power[powerKey];
      if (Number.isFinite(power) && power > 0 && elapsed > 0) {
        meter.kwh[indexKey] =
          (meter.kwh[indexKey] || 0) + (power * elapsed) / WATT_MILLISECONDS_PER_KWH;
        dirty = true;
      }
    }
  }

  /** Snapshot the totals at the first payload of a new slot, drop the old ones. */
  function snapshotSlot(meter, at) {
    const slotAt = slotStartOf(at);
    const last = meter.slots[meter.slots.length - 1];
    if (last && last.at >= slotAt) {
      return;
    }
    // The closing slot is valued with the totals at the boundary exactly.
    closeSavingsSlot(meter.savings, meter.kwh, slotAt, tariff, meter.storedKwh);
    meter.slots.push({
      at: slotAt,
      kwh: Object.fromEntries(SLOT_FIELDS.map((key) => [key, roundWh(meter.kwh[key] || 0)])),
    });
    meter.slots = meter.slots.filter((slot) => slot.at >= at - SLOT_RETENTION_IN_MS);
    dirty = true;
  }

  /** Saved slots of a device, read with the field order the file declares. */
  function loadSlots(savedSlots, fields) {
    if (!Array.isArray(savedSlots) || !Array.isArray(fields)) {
      return [];
    }
    return savedSlots
      .filter((slot) => Array.isArray(slot) && Number.isFinite(slot[0]))
      .map(([at, ...values]) => ({
        at,
        kwh: Object.fromEntries(
          SLOT_FIELDS.map((key) => {
            const value = values[fields.indexOf(key)];
            return [key, Number.isFinite(value) ? value : 0];
          }),
        ),
      }))
      .sort((a, b) => a.at - b.at);
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
            {
              lastAt: 0,
              power: {},
              kwh: { ...meter.kwh },
              slots: loadSlots(meter.slots, saved.slot_fields),
              savings: deserializeSavings(meter.savings),
              storedKwh: Number.isFinite(meter.savings?.stock?.kwh)
                ? meter.savings.stock.kwh
                : null,
            },
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
     * @param {{ storedKwh?: number|null }} [measures] energy in the packs now (state of charge x capacity), when known
     * @returns {Record<string, number>} index feature key -> kWh
     */
    update(deviceKey, powers, at, { storedKwh = null } = {}) {
      const meter = meterOf(deviceKey);
      const elapsed = at - meter.lastAt;
      const integrable = meter.lastAt > 0 && elapsed > 0 && elapsed <= MAX_INTEGRATION_GAP_IN_MS;
      // An interval crossing a slot boundary (at most one: the gap is shorter
      // than a slot) is split there, so the snapshot holds exactly the energy
      // before the boundary.
      let from = meter.lastAt;
      const boundary = slotStartOf(at);
      if (integrable && from < boundary) {
        integrate(meter, boundary - from);
        from = boundary;
      }
      snapshotSlot(meter, at);
      if (integrable) {
        integrate(meter, at - from);
      }
      for (const [powerKey, value] of Object.entries(powers)) {
        if (powerKey in ENERGY_FLOWS && Number.isFinite(value)) {
          meter.power[powerKey] = Math.max(0, value);
        }
      }
      if (at > meter.lastAt) {
        meter.lastAt = at;
      }
      if (Number.isFinite(storedKwh)) {
        meter.storedKwh = storedKwh;
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
     * Energy of a device since a moment (a local midnight): the totals now
     * minus the snapshot of the first slot starting at or after `since`, and
     * the energy of each slot since then. Null when the device has no slot
     * since `since` (silent all day, or never seen): nothing was integrated.
     * @param {string} deviceKey Zendure device key
     * @param {number} since timestamp (ms), within SLOT_RETENTION_IN_MS
     * @returns {{ countingSince: number, kwh: Record<string, number>, slots: Array<{ at: number, kwh: Record<string, number> }> }|null}
     */
    energySince(deviceKey, since) {
      const meter = meters.get(deviceKey);
      const slots = (meter?.slots || []).filter((slot) => slot.at >= since);
      if (slots.length === 0) {
        return null;
      }
      const now = Object.fromEntries(SLOT_FIELDS.map((key) => [key, meter.kwh[key] || 0]));
      const delta = (from, to) =>
        Object.fromEntries(
          SLOT_FIELDS.map((key) => [key, roundWh(Math.max(0, to[key] - from[key]))]),
        );
      return {
        countingSince: slots[0].at,
        kwh: delta(slots[0].kwh, now),
        // A slot without a payload has no snapshot: its energy (none was
        // integrated over a silence) goes to the previous slot.
        slots: slots.map((slot, index) => ({
          at: slot.at,
          kwh: delta(slot.kwh, slots[index + 1]?.kwh ?? now),
        })),
      };
    },

    /**
     * Set the tariff of the savings estimate (buildTariff().tariff, null for
     * none): the slots closing from now on are valued with it.
     * @param {object|null} value
     */
    setTariff(value) {
      tariff = value ?? null;
    },

    /**
     * Savings estimate of a device now (src/zendure/savings.js
     * savingsReport): null without a tariff or for an unseen device.
     * @param {string} deviceKey Zendure device key
     * @param {number} now timestamp (ms)
     */
    savingsOf(deviceKey, now) {
      const meter = meters.get(deviceKey);
      if (!meter || !tariff) {
        return null;
      }
      return savingsReport(meter.savings, meter.kwh, now, tariff, meter.storedKwh);
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
