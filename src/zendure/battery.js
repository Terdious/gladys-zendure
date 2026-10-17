// -----------------------------------------------------------------------------
// What a device has and how long its battery lasts, for the dashboard widgets.
//
// Pure helpers over the merged telemetry payload (flat local MQTT, or the
// `properties` + `packData` of a cloud / local HTTP report).
//
// Remaining time: the zenSDK reports `remainOutTime` (time to the discharge
// floor) and `remainInputTime` (time to the charge target), in MINUTES, and
// 59940 (999 h) when it has no estimate (idle battery). Zendure-HA does not
// display them: its calcRemainingTime() derives the time from the pack
// capacity, the state of charge, the SoC limits and the net pack power,
// capped at 999 h. We show the device's own figure and fall back to that same
// computation when the device gives none.
//
// Attribution: the remaining time formula comes from the official Home
// Assistant integration Zendure/Zendure-HA (MIT License, (c) 2024 peteS-UK);
// the code is our own.
// -----------------------------------------------------------------------------

import { modelCapabilitiesOf } from './constants.js';
import { reportedValue } from './control.js';
import { deviceCapacityKwh } from './energy.js';

// The device's "no estimate" value: 999 h, in minutes.
export const REMAINING_TIME_UNKNOWN_IN_MIN = 59940;
const MAX_REMAINING_TIME_IN_MIN = 999 * 60;

/**
 * Whether a device carries a battery pack: true / false, or null while the
 * telemetry has not told yet (never hide the battery figures on a guess).
 * Built-in packs are always there; an optional pack is known from `packNum`,
 * a non-empty `packData` or a known pack capacity.
 * @param {string} productModel raw cloud productModel
 * @param {object} payload merged telemetry payload
 * @returns {boolean|null}
 */
export function batteryPresenceOf(productModel, payload) {
  if (modelCapabilitiesOf(productModel).battery === 'built-in') {
    return true;
  }
  if (deviceCapacityKwh(payload) !== null) {
    return true;
  }
  const packNum = reportedValue(payload, 'packNum');
  if (packNum !== null) {
    return packNum > 0;
  }
  const packs = payload?.packData ?? payload?.properties?.packData;
  if (Array.isArray(packs)) {
    return packs.length > 0;
  }
  return null;
}

/**
 * Whether a device has a solar (PV) input: from the model table, or because
 * it reports solar power anyway.
 * @param {string} productModel raw cloud productModel
 * @param {number|null} solarInputPower latest solar power (W)
 * @returns {boolean}
 */
export function hasSolarInput(productModel, solarInputPower) {
  return modelCapabilitiesOf(productModel).solarInput || (solarInputPower ?? 0) > 0;
}

function reportedMinutes(payload, property) {
  const minutes = reportedValue(payload, property);
  return minutes !== null && minutes > 0 && minutes < REMAINING_TIME_UNKNOWN_IN_MIN
    ? Math.round(minutes)
    : null;
}

/**
 * Remaining time of the current charge or discharge, or null when the battery
 * is idle or no estimate exists.
 * @param {object} payload merged telemetry payload
 * @param {object} battery
 * @param {number|null} battery.level state of charge (%)
 * @param {number|null} battery.chargePower pack charge power (W)
 * @param {number|null} battery.dischargePower pack discharge power (W)
 * @param {number|null} battery.capacityKwh known pack capacity
 * @param {number|null} battery.socSet charge target (%)
 * @param {number|null} battery.minSoc discharge floor (%)
 * @returns {{ direction: 'charge'|'discharge', minutes: number }|null}
 */
export function remainingTimeOf(
  payload,
  { level, chargePower, dischargePower, capacityKwh, socSet, minSoc },
) {
  const net = (dischargePower ?? 0) - (chargePower ?? 0);
  if (net === 0) {
    return null;
  }
  const direction = net > 0 ? 'discharge' : 'charge';
  const reported = reportedMinutes(
    payload,
    direction === 'discharge' ? 'remainOutTime' : 'remainInputTime',
  );
  if (reported !== null) {
    return { direction, minutes: reported };
  }
  // Zendure-HA's calcRemainingTime: capacity x the SoC left to the limit,
  // over the net pack power.
  const limit = direction === 'discharge' ? minSoc : socSet;
  if (capacityKwh === null || level === null || limit === null) {
    return null;
  }
  const socLeft = direction === 'discharge' ? level - limit : limit - level;
  if (socLeft <= 0) {
    return null;
  }
  const minutes = Math.round(((capacityKwh * 1000 * (socLeft / 100)) / Math.abs(net)) * 60);
  return { direction, minutes: Math.min(MAX_REMAINING_TIME_IN_MIN, minutes) };
}

/**
 * Short text of a duration: `45 min`, `2 h 05`, `> 99 h`.
 * @param {number} minutes
 * @returns {string}
 */
export function formatRemainingTime(minutes) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours > 99) {
    return '> 99 h';
  }
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}
