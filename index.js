// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It holds
// NO hardware logic: all the control "work" lives in the device modules. This
// file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Cleanup functions for the "push" subscriptions (e.g. the motion sensor).
let pushCleanups = [];

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const blueprint = findBlueprintByDevice(gladys, device);
  if (!blueprint || typeof blueprint.onSetValue !== 'function') {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`No command handler for ${device.external_id}`);
  }
  await blueprint.onSetValue(gladys, { device, feature, value, config });
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config, device);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Re-publish the devices: some properties (key, frequency) depend on it.
  // publishDiscoveredDevices is idempotent (upsert by external_id).
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  logger.info('WebSocket connected to Gladys');
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) (Re)publish all devices as soon as we are connected.
    await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));

    // 3) Start the real-time subscriptions ("push" sensors).
    stopPushSubscriptions();
    pushCleanups = DEVICE_BLUEPRINTS.filter((bp) => typeof bp.startPush === 'function').map((bp) =>
      bp.startPush(gladys, config),
    );
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.on('disconnected', () => {
  logger.warn('WebSocket disconnected - the SDK will try to reconnect');
  stopPushSubscriptions();
});

function stopPushSubscriptions() {
  for (const cleanup of pushCleanups) {
    try {
      cleanup?.();
    } catch (err) {
      logger.error('Push subscription cleanup failed', err);
    }
  }
  pushCleanups = [];
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK stops the push subscriptions, disconnects cleanly and exits with
// code 0 when the supervisor stops the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPushSubscriptions();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Zendure integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
