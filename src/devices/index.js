// -----------------------------------------------------------------------------
// Device registry.
//
// Add or remove device types here. Each device lives in its own file and
// exposes the same shape:
//   - key                        : short identifier (used in logs)
//   - deviceExternalId(gladys)   : the device external_id (for dispatch)
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - onPoll(gladys, config)      (optional): periodic read
//   - onSetValue(gladys, {...})   (optional): run a user command
//   - startPush(gladys, config)   (optional): subscribe to a real-time stream
// -----------------------------------------------------------------------------

export const DEVICE_BLUEPRINTS = [];

/**
 * Build the discovery payload for Gladys (all devices).
 */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a given device, from its external_id
 * (used to route onPoll / onSetValue to the right device).
 */
export function findBlueprintByDevice(gladys, device) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys) === device.external_id);
}
