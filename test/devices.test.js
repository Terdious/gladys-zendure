import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const config = normalizeConfig();

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.equal(typeof bp.deviceExternalId, 'function', 'deviceExternalId must be a function');
    assert.equal(typeof bp.buildDevice, 'function', 'buildDevice must be a function');
  }
});

test('buildDiscoveredDevices returns one payload per blueprint', () => {
  const devices = buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, DEVICE_BLUEPRINTS.length);
  for (const device of devices) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.external_id, 'each device has an external_id');
    assert.ok(Array.isArray(device.features) && device.features.length > 0);
  }
});

test('device external_ids are unique across the catalog', () => {
  const devices = buildDiscoveredDevices(gladys, config);
  const ids = devices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
});

test('findBlueprintByDevice routes an external_id back to its owner blueprint', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    const external_id = bp.deviceExternalId(gladys);
    const found = findBlueprintByDevice(gladys, { external_id });
    assert.equal(found, bp);
  }
});

test('findBlueprintByDevice returns undefined for an unknown device', () => {
  const found = findBlueprintByDevice(gladys, { external_id: 'does-not-exist' });
  assert.equal(found, undefined);
});
