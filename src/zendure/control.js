// -----------------------------------------------------------------------------
// Battery control: the `properties/write` commands of the zenSDK contract.
//
// The Gladys feature taxonomy has no battery setpoint type yet (no output
// limit, target SoC or AC mode in `battery-storage`), so control is offered
// through scene actions and widget buttons rather than writable features.
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
// Attribution: the per-model charge / discharge ratings come from the official
// Home Assistant integration Zendure/Zendure-HA (MIT License, (c) 2024
// peteS-UK). Only those factual constants are reused; the code is our own.
// -----------------------------------------------------------------------------

import { SUPPORTED_PRODUCT_MODELS } from './constants.js';
import { extractMetricValue } from './deviceMapping.js';

// Rated AC charge (input) and discharge (output) power per model, in watts.
const MODEL_POWER_RATINGS = {
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800]: { charge: 1000, discharge: 800 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_800_PRO]: { charge: 1000, discharge: 800 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_1600]: { charge: 1600, discharge: 1600 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_AC]: { charge: 2400, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400]: { charge: 3200, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.SOLARFLOW_2400_PRO]: { charge: 3200, discharge: 2400 },
  [SUPPORTED_PRODUCT_MODELS.HYPER_2000]: { charge: 1200, discharge: 1200 },
};

// zenSDK ranges of the SoC settings, in percent.
export const SOC_SET_RANGE = { min: 70, max: 100 };
export const MIN_SOC_RANGE = { min: 0, max: 50 };

// acMode values (zenSDK): 1 = AC input (charge from the grid), 2 = output.
export const AC_MODES = { charge: 1, discharge: 2 };

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
  const rating =
    MODEL_POWER_RATINGS[
      String(productModel || '')
        .toLowerCase()
        .trim()
    ]?.[direction] ?? 800;
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

/**
 * Turn a control command into the `properties/write` body, or null when the
 * device already runs with it (nothing to send).
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
        const maxSoc = toInteger(command.max_soc, 'max_soc');
        if (maxSoc < SOC_SET_RANGE.min || maxSoc > SOC_SET_RANGE.max) {
          throw new ControlRefusedError(
            `max_soc must be between ${SOC_SET_RANGE.min} and ${SOC_SET_RANGE.max} %`,
          );
        }
        properties.socSet = maxSoc * scale;
        applied.socSet = maxSoc;
      }
      if (command.min_soc !== undefined && command.min_soc !== null && command.min_soc !== '') {
        const minSoc = toInteger(command.min_soc, 'min_soc');
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
