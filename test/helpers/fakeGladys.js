// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishDiscoveredDevices / setConnectionStatus / publishTransports
//     -> recorded the same way (discovered / connectionStatuses / transports)
//   - setConfig -> merged into `config`, each call recorded in configWrites
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const connectionStatuses = [];
  const transports = [];
  const sceneEvents = [];
  const configWrites = [];
  const config = {};

  return {
    configWrites,
    config,
    // The devices created in Gladys (the SDK fills it at connection).
    devices: [],
    published,
    discovered,
    connectionStatuses,
    transports,
    sceneEvents,

    externalId(suffix) {
      return suffix;
    },

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async publishTransports(entries) {
      transports.push(entries);
    },

    async setConfig(partialConfig) {
      configWrites.push(partialConfig);
      Object.assign(config, partialConfig);
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
    },
  };
}
