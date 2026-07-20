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

import { createLogger } from '@gladysassistant/integration-sdk';

import { solarflow } from './solarflow.js';

const logger = createLogger({ name: 'discovery' });

export const DEVICE_BLUEPRINTS = [solarflow];

// Multi-language messages for the application-level connection status shown
// on the integration Configuration screen in Gladys.
export const CONNECTION_MESSAGES = {
  MISSING_KEY: {
    en: 'Zendure cloud key is not configured yet.',
    fr: "La clé cloud Zendure n'est pas encore configurée.",
  },
  CLOUD_UNREACHABLE: {
    en: 'Zendure cloud is unreachable or the cloud key is invalid.',
    fr: 'Le cloud Zendure est injoignable ou la clé cloud est invalide.',
  },
};

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
 * Build the per-device transport entries (all blueprints exposing
 * buildTransports), consumed by gladys.publishTransports().
 */
export async function buildDiscoveredTransports(gladys, config) {
  const transports = [];
  for (const bp of DEVICE_BLUEPRINTS) {
    if (typeof bp.buildTransports === 'function') {
      transports.push(...(await bp.buildTransports(gladys, config)));
    }
  }
  return transports;
}

/**
 * Report the application-level connection status of the integration.
 * Defensive: an older Gladys core without the endpoint must never crash the
 * integration, so failures are only logged.
 */
async function reportConnectionStatus(gladys, connected, message) {
  try {
    await gladys.setConnectionStatus(connected, message);
  } catch (err) {
    logger.debug(`setConnectionStatus skipped (older Gladys core?): ${err.message}`);
  }
}

/**
 * Publish the per-device transport badges of the discovered devices.
 * Defensive for the same reason as reportConnectionStatus.
 */
async function reportTransports(gladys, config) {
  try {
    const transports = await buildDiscoveredTransports(gladys, config);
    if (transports.length > 0) {
      await gladys.publishTransports(transports);
    }
  } catch (err) {
    logger.debug(`publishTransports skipped (older Gladys core?): ${err.message}`);
  }
}

/**
 * Discovery pipeline shared by the connected / scan-request / config-updated
 * paths: publish the discovered devices, then report the application-level
 * connection status and the per-device transport badges.
 * @returns {Promise<boolean>} true when the devices were published.
 */
export async function syncDiscoveredDevices(gladys, config) {
  if (!config.cloud_key) {
    // Expected state on every fresh install, until the user enters the key:
    // surface it on the Configuration screen instead of an error stack.
    logger.warn('Zendure cloud key is not configured yet - skipping discovery');
    await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.MISSING_KEY);
    return false;
  }

  let devices;
  try {
    devices = await buildDiscoveredDevices(gladys, config);
  } catch (err) {
    // The Zendure cloud rejected us (bad key) or is unreachable.
    await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.CLOUD_UNREACHABLE);
    throw err;
  }

  await gladys.publishDiscoveredDevices(devices);
  await reportConnectionStatus(gladys, true);
  await reportTransports(gladys, config);
  return true;
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
