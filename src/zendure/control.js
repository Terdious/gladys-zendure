// -----------------------------------------------------------------------------
// Battery control: the `properties/write` commands of the zenSDK contract.
//
// One control path for every entry point: the writable features of the device
// card (onSetValue, src/devices/solarflow.js), the scene actions
// (src/scenes.js) and the widget forms (src/widgets.js) all build their
// command here and send it through controlDevice.
//
// Safety rules (zenSDK docs, Zendure-HA practice):
//   - power limits are written with `smartMode: 1`, which keeps them in RAM
//     instead of the flash (frequent changes would wear it out);
//   - every value is clamped to the model's rating, widened (never narrowed)
//     by the limits the device reports itself;
//   - writes are rate limited per device and setting, mode and SoC changes
//     much more strictly than power limits (they may still reach the flash);
//   - the SoC scale is read from the device's own report: some firmwares
//     report socSet / minSoc in tenths of a percent (1000 = 100 %).
//
// The per-model ratings, SoC ranges and acMode values are protocol constants,
// in src/zendure/constants.js (with their attribution).
// -----------------------------------------------------------------------------

import {
  AC_MODES,
  DEFAULT_POWER_RATING,
  MIN_SOC_RANGE,
  MODEL_POWER_RATINGS,
  SOC_SET_RANGE,
} from './constants.js';
import { extractMetricValue } from './deviceMapping.js';

export { AC_MODES, MIN_SOC_RANGE, SOC_SET_RANGE };

// Minimum delay between two writes of the same setting on one device.
export const WRITE_INTERVALS_IN_MS = {
  outputLimit: 3 * 1000,
  inputLimit: 3 * 1000,
  acMode: 30 * 1000,
  soc: 30 * 1000,
};

// A power limit closer than this to the reported one is not rewritten.
export const POWER_TOLERANCE_IN_W = 5;

/** Read one reported property (flat local payload or cloud `properties`). */
export function reportedValue(payload, property) {
  return extractMetricValue(payload || {}, [property, `properties.${property}`]);
}

/**
 * Highest power limit (W) accepted for a direction on this device: the model
 * rating, widened by what the device itself reports (`inverseMaxPower` for
 * the output, `chargeMaxLimit` for the input).
 * @param {string} productModel raw cloud productModel
 * @param {'charge'|'discharge'} direction
 * @param {object} payload latest telemetry payload
 * @returns {number}
 */
export function maxPowerFor(productModel, direction, payload) {
  const rating = (MODEL_POWER_RATINGS[
    String(productModel || '')
      .toLowerCase()
      .trim()
  ] ?? DEFAULT_POWER_RATING)[direction];
  const reported = reportedValue(
    payload,
    direction === 'discharge' ? 'inverseMaxPower' : 'chargeMaxLimit',
  );
  return reported !== null && reported > rating ? reported : rating;
}

/**
 * Factor between the percent a user types and the value the device stores:
 * 10 when the device reports its SoC settings in tenths of a percent.
 * @param {object} payload latest telemetry payload
 * @returns {number|null} null when the device has not reported them yet
 */
export function socScaleOf(payload) {
  const socSet = reportedValue(payload, 'socSet');
  if (socSet === null) {
    return null;
  }
  return socSet > 100 ? 10 : 1;
}

/** Error whose message is safe to show: a refused, never a failed, command. */
export class ControlRefusedError extends Error {}

function toInteger(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ControlRefusedError(`${name} must be a number`);
  }
  return Math.round(number);
}

function clampIf(clamp, value, range) {
  return clamp ? Math.min(range.max, Math.max(range.min, value)) : value;
}

/**
 * Turn a control command into the `properties/write` body, or null when the
 * device already runs with it (nothing to send).
 * A `soc_limits` command with `clamp: true` brings an out-of-range level into
 * the zenSDK range instead of refusing it (device card: the device stays the
 * authority, the applied value is reported back).
 * @param {{ kind: 'output_limit'|'input_limit'|'ac_mode'|'soc_limits', [key: string]: unknown }} command
 * @param {{ productModel: string, payload: object }} device
 * @returns {{ setting: string, properties: Record<string, number>, applied: Record<string, number> }|null}
 */
export function buildWriteCommand(command, { productModel, payload }) {
  switch (command.kind) {
    case 'output_limit':
    case 'input_limit': {
      const isOutput = command.kind === 'output_limit';
      const property = isOutput ? 'outputLimit' : 'inputLimit';
      const max = maxPowerFor(productModel, isOutput ? 'discharge' : 'charge', payload);
      const watts = Math.min(max, Math.max(0, toInteger(command.watts, 'watts')));
      const current = reportedValue(payload, property);
      if (current !== null && Math.abs(current - watts) <= POWER_TOLERANCE_IN_W) {
        return null;
      }
      return {
        setting: property,
        properties: { smartMode: 1, [property]: watts },
        applied: { [property]: watts },
      };
    }
    case 'ac_mode': {
      const acMode = AC_MODES[command.mode];
      if (!acMode) {
        throw new ControlRefusedError('mode must be "charge" or "discharge"');
      }
      if (reportedValue(payload, 'acMode') === acMode) {
        return null;
      }
      return { setting: 'acMode', properties: { acMode }, applied: { acMode } };
    }
    case 'soc_limits': {
      const scale = socScaleOf(payload);
      if (scale === null) {
        throw new ControlRefusedError(
          'the battery has not reported its SoC settings yet: retry in a minute',
        );
      }
      const properties = {};
      const applied = {};
      if (command.max_soc !== undefined && command.max_soc !== null && command.max_soc !== '') {
        const maxSoc = clampIf(command.clamp, toInteger(command.max_soc, 'max_soc'), SOC_SET_RANGE);
        if (maxSoc < SOC_SET_RANGE.min || maxSoc > SOC_SET_RANGE.max) {
          throw new ControlRefusedError(
            `max_soc must be between ${SOC_SET_RANGE.min} and ${SOC_SET_RANGE.max} %`,
          );
        }
        properties.socSet = maxSoc * scale;
        applied.socSet = maxSoc;
      }
      if (command.min_soc !== undefined && command.min_soc !== null && command.min_soc !== '') {
        const minSoc = clampIf(command.clamp, toInteger(command.min_soc, 'min_soc'), MIN_SOC_RANGE);
        if (minSoc < MIN_SOC_RANGE.min || minSoc > MIN_SOC_RANGE.max) {
          throw new ControlRefusedError(
            `min_soc must be between ${MIN_SOC_RANGE.min} and ${MIN_SOC_RANGE.max} %`,
          );
        }
        properties.minSoc = minSoc * scale;
        applied.minSoc = minSoc;
      }
      if (Object.keys(properties).length === 0) {
        throw new ControlRefusedError('set max_soc, min_soc or both');
      }
      // Levels the device already runs with are not rewritten (they may reach
      // the flash).
      const unchanged = Object.entries(properties).every(
        ([property, value]) => reportedValue(payload, property) === value,
      );
      if (unchanged) {
        return null;
      }
      return { setting: 'soc', properties, applied };
    }
    default:
      throw new ControlRefusedError(`unknown command "${command.kind}"`);
  }
}

/**
 * Per device and setting write rate limiter.
 * @returns {{ check(deviceKey: string, setting: string, now: number): void, record(deviceKey: string, setting: string, now: number): void }}
 */
export function createWriteThrottle() {
  const lastWriteAt = new Map(); // `${deviceKey}:${setting}` -> ms
  return {
    check(deviceKey, setting, now) {
      const last = lastWriteAt.get(`${deviceKey}:${setting}`);
      const interval = WRITE_INTERVALS_IN_MS[setting] ?? 30 * 1000;
      if (last !== undefined && now - last < interval) {
        const seconds = Math.ceil((interval - (now - last)) / 1000);
        throw new ControlRefusedError(
          `${setting} was changed less than ${Math.round(interval / 1000)} s ago: retry in ${seconds} s`,
        );
      }
    },
    record(deviceKey, setting, now) {
      lastWriteAt.set(`${deviceKey}:${setting}`, now);
    },
  };
}
