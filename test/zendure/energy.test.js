import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createEnergyMeters,
  deviceCapacityKwh,
  packCapacityKwh,
  MAX_INTEGRATION_GAP_IN_MS,
} from '../../src/zendure/energy.js';
import { createTestEnergyMeters } from '../helpers/fakeZendure.js';

const MINUTE = 60 * 1000;
const T0 = 1_700_000_000_000;

test('a power held for an hour adds its energy (left Riemann sum)', () => {
  const { meters } = createTestEnergyMeters();
  meters.update('dev', { batteryOutputPower: 1000, solarInputPower: 500 }, T0);
  // Twelve 5-minute steps (each within the integration gap) = one hour.
  let totals;
  for (let step = 1; step <= 12; step += 1) {
    totals = meters.update('dev', {}, T0 + step * 5 * MINUTE);
  }
  assert.equal(totals.batteryChargeEnergy, 1);
  assert.equal(totals.solarEnergy, 0.5);
  assert.equal(totals.batteryDischargeEnergy, 0);
  assert.equal(totals.homeOutputEnergy, 0);
});

test('the power of an interval is the one reported at its start', () => {
  const { meters } = createTestEnergyMeters();
  meters.update('dev', { homeOutputPower: 600 }, T0);
  meters.update('dev', { homeOutputPower: 0 }, T0 + 5 * MINUTE); // +0.05 kWh at 600 W
  const totals = meters.update('dev', {}, T0 + 10 * MINUTE); // 0 W since
  assert.equal(totals.homeOutputEnergy, 0.05);
});

test('a silence longer than the integration gap is not integrated', () => {
  const { meters } = createTestEnergyMeters();
  meters.update('dev', { batteryInputPower: 2000 }, T0);
  const totals = meters.update('dev', {}, T0 + MAX_INTEGRATION_GAP_IN_MS + 1);
  assert.equal(totals.batteryDischargeEnergy, 0);
});

test('the totals survive a restart, the last power does not', async () => {
  const { meters, dataDir } = createTestEnergyMeters();
  meters.update('dev', { solarInputPower: 1200 }, T0);
  meters.update('dev', {}, T0 + 5 * MINUTE); // 0.1 kWh
  await meters.save();

  const restarted = createEnergyMeters({ dataDir });
  await restarted.load();
  assert.equal(restarted.totals('dev').solarEnergy, 0.1);
  // First payload after the restart only starts a new interval.
  const totals = restarted.update('dev', {}, T0 + 6 * MINUTE);
  assert.equal(totals.solarEnergy, 0.1);
  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  assert.equal(saved.version, 1);
});

test('an unreadable save file starts the meters at 0', async () => {
  const { dataDir } = createTestEnergyMeters();
  await writeFile(join(dataDir, 'energy.json'), '{not json');
  const meters = createEnergyMeters({ dataDir });
  await meters.load();
  assert.equal(meters.totals('dev').solarEnergy, 0);
});

test('pack capacities follow the serial prefix (Zendure-HA table)', () => {
  assert.equal(packCapacityKwh({ sn: 'CO4H' }), 1.92); // AB2000
  assert.equal(packCapacityKwh({ sn: 'FO4E' }), 2.88); // AB3000
  assert.equal(packCapacityKwh({ sn: 'A1230' }), 2.4); // AIO 2400
  assert.equal(packCapacityKwh({ sn: 'A1110' }), 0.96); // AB1000
  assert.equal(packCapacityKwh({ sn: 'B1', packType: 70 }), 8);
  assert.equal(packCapacityKwh({ sn: 'Z9' }), null);
  assert.equal(deviceCapacityKwh({ packData: [{ sn: 'C1' }, { sn: 'F1' }, { sn: 'Z1' }] }), 4.8);
  assert.equal(deviceCapacityKwh({ properties: { packData: [{ sn: 'J1' }] } }), 2.4);
  assert.equal(deviceCapacityKwh({ packData: [] }), null);
  assert.equal(deviceCapacityKwh({}), null);
});

test('concurrent saves are serialized, each with its own temporary file', async (t) => {
  // The logger writes warnings through console.error: none may be a failed save.
  const errorLines = t.mock.method(console, 'error', () => {});
  const { meters, dataDir } = createTestEnergyMeters();
  meters.update('dev', { solarInputPower: 1200 }, T0);
  meters.update('dev', {}, T0 + 5 * MINUTE); // 0.1 kWh
  // The periodic timer, the push cleanup and the shutdown hook can all save at
  // once: before, they shared one temp file and the late rename hit ENOENT.
  const first = meters.save();
  meters.update('dev', {}, T0 + 10 * MINUTE); // 0.2 kWh, while the first save runs
  const second = meters.save();
  const third = meters.save();
  await Promise.all([first, second, third]);

  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  assert.equal(saved.devices.dev.kwh.solarEnergy, 0.2, 'the latest totals win');
  assert.deepEqual(
    (await readdir(dataDir)).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file left behind',
  );
  const failures = errorLines.mock.calls.filter((call) =>
    /could not save/.test(call.arguments.join(' ')),
  );
  assert.deepEqual(failures, [], 'no save failed');
});
