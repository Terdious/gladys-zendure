// -----------------------------------------------------------------------------
// Battery alerts: the status codes of a battery turned into "started" /
// "ended" transitions, for the `battery_alert` scene trigger.
//
// The codes are states, but Gladys has no feature category for them yet
// (#43): a scene trigger fired on their transitions is what scenes need.
//
// Sources of the codes (reported by every source: local HTTP API, local MQTT,
// cloud `properties`):
//   - `is_error` (0-1, "Error flag") and `faultLevel` ("Fault severity"):
//     zenSDK docs/en_properties.md; Zendure-HA reads faultLevel raw;
//   - `heatState` (0-1, "Heating state"): zenSDK; Zendure-HA "Battery Heating";
//   - `socStatus` (0-1, "SOC calibration"): zenSDK; Zendure-HA 0 Operation,
//     1 Auto-Calibration;
//   - `lowTemperature`: Zendure-HA binary sensor "Low Temperature" (not in the
//     zenSDK tables);
//   - `reverseState` (0-1, "Reverse flow state"): zenSDK; Zendure-HA binary
//     sensor "Reverse Flow State".
// `socLimit` (full / empty) is left out on purpose: Zendure-HA labels 1 as
// "Limiting" and 2 as "Full" in its translations while its control logic
// reads 1 as full and 2 as empty — no reliable meaning to give the user.
//
// Pure module: the device layer feeds it the fresh reports; the tests drive
// the clock.
// -----------------------------------------------------------------------------

import { reportedValue } from './control.js';

// A new state must hold this long, over at least two reports, before it is an
// event: the local HTTP API reports every 5 s and the local MQTT broker
// pushes continuously, so a code that blinks for a report or two never
// fires, while a real heating or calibration (minutes to hours) is notified
// within about half a minute. A time rather than a report count: the sources
// report at very different rates (one MQTT message per metric locally).
export const ALERT_CONFIRM_DELAY_IN_MS = 30 * 1000;

const isOne = (value) => value === 1;

/**
 * The alert kinds, keyed by the value of the trigger's `kind` field (keys are
 * forever: scenes store them). `read` gives `{ active, value }` from a
 * payload, or null when the payload does not carry the code.
 */
export const ALERT_KINDS = {
  fault: {
    properties: ['is_error', 'faultLevel'],
    read(payload) {
      const isError = reportedValue(payload, 'is_error');
      const faultLevel = reportedValue(payload, 'faultLevel');
      if (isError === null && faultLevel === null) {
        return null;
      }
      return {
        active: isError === 1 || (faultLevel !== null && faultLevel > 0),
        // The severity says more than the flag when the device gives it.
        value: faultLevel ?? isError,
      };
    },
  },
  heating: { properties: ['heatState'], active: isOne },
  calibration: { properties: ['socStatus'], active: isOne },
  low_temperature: { properties: ['lowTemperature'], active: isOne },
  reverse_flow: { properties: ['reverseState'], active: isOne },
};

/**
 * The state of one alert kind in a payload.
 * @param {string} kind key of ALERT_KINDS
 * @param {object|null} payload merged telemetry payload
 * @returns {{ active: boolean, value: number }|null} null when not reported
 */
export function alertStateOf(kind, payload) {
  const definition = ALERT_KINDS[kind];
  if (!definition || !payload) {
    return null;
  }
  if (definition.read) {
    return definition.read(payload);
  }
  const value = reportedValue(payload, definition.properties[0]);
  return value === null ? null : { active: definition.active(value), value };
}

/**
 * Edge detector of the alerts, per device and per kind:
 *   - the first value seen for a device and kind is the initial state, never
 *     an event (a battery heating when the integration starts did not just
 *     start heating);
 *   - a different state becomes a candidate; it is confirmed — and returned
 *     as a transition — by a later report at least `confirmDelayMs` after the
 *     first one, with no report of the stable state in between (a report of
 *     the stable state drops the candidate: flapping).
 * @param {{ confirmDelayMs?: number }} [options]
 */
export function createAlertTracker({ confirmDelayMs = ALERT_CONFIRM_DELAY_IN_MS } = {}) {
  // deviceKey -> Map(kind -> { active, candidate: { active, since } | null })
  const states = new Map();

  return {
    /**
     * Feed one fresh report of a device.
     * @param {string} deviceKey Zendure device key
     * @param {object} payload merged telemetry payload
     * @param {number} [now] current time (ms)
     * @returns {Array<{ kind: string, state: 'started'|'ended', value: number }>}
     */
    observe(deviceKey, payload, now = Date.now()) {
      let byKind = states.get(deviceKey);
      if (!byKind) {
        byKind = new Map();
        states.set(deviceKey, byKind);
      }
      const transitions = [];
      for (const kind of Object.keys(ALERT_KINDS)) {
        const observed = alertStateOf(kind, payload);
        if (observed === null) {
          continue;
        }
        const tracked = byKind.get(kind);
        if (!tracked) {
          byKind.set(kind, { active: observed.active, candidate: null });
          continue;
        }
        if (observed.active === tracked.active) {
          tracked.candidate = null;
          continue;
        }
        if (!tracked.candidate) {
          tracked.candidate = { since: now };
          continue;
        }
        if (now - tracked.candidate.since >= confirmDelayMs) {
          tracked.active = observed.active;
          tracked.candidate = null;
          transitions.push({
            kind,
            state: observed.active ? 'started' : 'ended',
            value: observed.value,
          });
        }
      }
      return transitions;
    },

    /** Forget a device (deleted in Gladys): it starts over silently. */
    forget(deviceKey) {
      states.delete(deviceKey);
    },

    /** Forget every device. */
    clear() {
      states.clear();
    },
  };
}
