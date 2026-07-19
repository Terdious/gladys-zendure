// -----------------------------------------------------------------------------
// Device registry.
//
// Add or remove device types here. Each device lives in its own file and
// exposes the same shape:
//   - key                            : short identifier (used in logs)
//   - buildDevice(gladys, config)    : discovery payload for ONE device, or
//   - buildDevices(gladys, config)   : discovery payloads (async, multi-device)
//   - deviceExternalId(gladys)       : the device external_id (dispatch), or
//   - ownsDevice(gladys, device)     : dispatch predicate (multi-device)
//   - onPoll(gladys, config, device)  (optional): periodic read
//   - onSetValue(gladys, {...})       (optional): run a user command
//   - startPush(gladys, config)       (optional): subscribe to a real-time stream
// -----------------------------------------------------------------------------

import { solarflow } from './solarflow.js';

export const DEVICE_BLUEPRINTS = [solarflow];

/**
 * Build the discovery payload for Gladys (all devices, all blueprints).
 */
export async function buildDiscoveredDevices(gladys, config) {
  const devices = [];
  for (const bp of DEVICE_BLUEPRINTS) {
    if (typeof bp.buildDevices === 'function') {
      devices.push(...(await bp.buildDevices(gladys, config)));
    } else {
      devices.push(bp.buildDevice(gladys, config));
    }
  }
  return devices;
}

/**
 * Find the blueprint that owns a given device, from its external_id
 * (used to route onPoll / onSetValue to the right device).
 */
export function findBlueprintByDevice(gladys, device) {
  return DEVICE_BLUEPRINTS.find((bp) =>
    typeof bp.ownsDevice === 'function'
      ? bp.ownsDevice(gladys, device)
      : bp.deviceExternalId(gladys) === device.external_id,
  );
}
