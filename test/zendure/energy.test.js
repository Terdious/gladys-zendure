import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createEnergyMeters,
  deviceCapacityKwh,
  packCapacityKwh,
  MAX_INTEGRATION_GAP_IN_MS,
  ENERGY_SLOT_IN_MS,
  SLOT_RETENTION_IN_MS,
  slotStartOf,
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

// --- Slot snapshots (the "Energy today" widget) ---------------------------------

const SLOT0 = slotStartOf(T0) + ENERGY_SLOT_IN_MS; // a slot boundary after T0

test('the energy since a moment: the totals minus the first slot snapshot after it', () => {
  const { meters } = createTestEnergyMeters();
  // 1200 W from 30 min before the boundary to 1 h after it, 5-minute steps.
  for (let at = SLOT0 - 30 * MINUTE; at <= SLOT0 + 60 * MINUTE; at += 5 * MINUTE) {
    meters.update('dev', { homeOutputPower: 1200 }, at);
  }
  const energy = meters.energySince('dev', SLOT0);
  assert.equal(energy.countingSince, SLOT0);
  assert.equal(energy.kwh.homeOutputEnergy, 1.2); // the hour after the boundary only
  assert.deepEqual(
    energy.slots.map((slot) => [slot.at - SLOT0, slot.kwh.homeOutputEnergy]),
    [
      [0, 0.6],
      [ENERGY_SLOT_IN_MS, 0.6],
      [2 * ENERGY_SLOT_IN_MS, 0],
    ],
  );
  assert.equal(meters.energySince('other', SLOT0), null, 'never seen');
  assert.equal(meters.energySince('dev', SLOT0 + 3 * ENERGY_SLOT_IN_MS), null, 'nothing since');
});

test('an interval crossing a slot boundary is split at the boundary', () => {
  const { meters } = createTestEnergyMeters();
  meters.update('dev', { solarInputPower: 600 }, SLOT0 - 2 * MINUTE);
  meters.update('dev', {}, SLOT0 + 3 * MINUTE); // 2 min before, 3 min after
  const energy = meters.energySince('dev', SLOT0);
  assert.equal(energy.kwh.solarEnergy, 0.03); // 600 W x 3 min
  assert.equal(meters.totals('dev').solarEnergy, 0.05);
});

test('the slot snapshots survive a restart, and age out after the retention', async () => {
  const { meters, dataDir } = createTestEnergyMeters();
  for (let at = SLOT0; at <= SLOT0 + 30 * MINUTE; at += 5 * MINUTE) {
    meters.update('dev', { batteryInputPower: 2000 }, at);
  }
  await meters.save();
  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.slot_fields, [
    'batteryChargeEnergy',
    'batteryDischargeEnergy',
    'solarEnergy',
    'homeOutputEnergy',
  ]);
  assert.deepEqual(saved.devices.dev.slots, [
    [SLOT0, 0, 0, 0, 0],
    [SLOT0 + ENERGY_SLOT_IN_MS, 0, 1, 0, 0],
  ]);

  const restarted = createEnergyMeters({ dataDir });
  await restarted.load();
  assert.equal(restarted.energySince('dev', SLOT0).kwh.batteryDischargeEnergy, 1);
  // A day later the old snapshots are dropped.
  restarted.update('dev', {}, SLOT0 + SLOT_RETENTION_IN_MS + ENERGY_SLOT_IN_MS + 1);
  assert.equal(restarted.energySince('dev', 0).countingSince > SLOT0 + ENERGY_SLOT_IN_MS, true);
});

test('a save file of 1.6.0 (totals only) loads, with no snapshot yet', async () => {
  const { dataDir } = createTestEnergyMeters();
  await writeFile(
    join(dataDir, 'energy.json'),
    JSON.stringify({ version: 1, devices: { dev: { kwh: { solarEnergy: 3 } } } }),
  );
  const meters = createEnergyMeters({ dataDir });
  await meters.load();
  assert.equal(meters.totals('dev').solarEnergy, 3);
  assert.equal(meters.energySince('dev', 0), null);
  meters.update('dev', {}, SLOT0);
  assert.equal(meters.energySince('dev', 0).kwh.solarEnergy, 0);
});

test('the off-grid and grid charging flows are integrated and saved with the totals', async () => {
  const { meters, dataDir } = createTestEnergyMeters();
  meters.update('dev', { offGridPower: 600, gridInputPower: 1200 }, T0);
  meters.update('dev', { offGridPower: -50 }, T0 + 5 * MINUTE); // negative: nothing after
  const totals = meters.update('dev', {}, T0 + 10 * MINUTE);
  assert.equal(totals.offGridEnergy, 0.05); // 600 W x 5 min
  assert.equal(totals.gridInputEnergy, 0.2); // 1200 W x 10 min
  await meters.save();
  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  // The slots keep the four flows of the "Energy today" widget only.
  assert.deepEqual(saved.slot_fields, [
    'batteryChargeEnergy',
    'batteryDischargeEnergy',
    'solarEnergy',
    'homeOutputEnergy',
  ]);
  assert.equal(saved.devices.dev.slots[0].length, 5);
  const restarted = createEnergyMeters({ dataDir });
  await restarted.load();
  assert.equal(restarted.totals('dev').offGridEnergy, 0.05);
  assert.equal(restarted.totals('dev').gridInputEnergy, 0.2);
});

test('a save file of 1.7.0 loads: its totals and slots kept, the new flows start at 0', async () => {
  const { dataDir } = createTestEnergyMeters();
  await writeFile(
    join(dataDir, 'energy.json'),
    JSON.stringify({
      version: 1,
      slot_fields: [
        'batteryChargeEnergy',
        'batteryDischargeEnergy',
        'solarEnergy',
        'homeOutputEnergy',
      ],
      devices: {
        dev: {
          kwh: { batteryChargeEnergy: 4, solarEnergy: 3, homeOutputEnergy: 2 },
          slots: [[SLOT0, 3.5, 0, 2.5, 1.5]],
        },
      },
    }),
  );
  const meters = createEnergyMeters({ dataDir });
  await meters.load();
  assert.deepEqual(meters.totals('dev'), {
    batteryChargeEnergy: 4,
    batteryDischargeEnergy: 0,
    solarEnergy: 3,
    homeOutputEnergy: 2,
    offGridEnergy: 0,
    gridInputEnergy: 0,
  });
  assert.deepEqual(meters.energySince('dev', SLOT0).kwh, {
    batteryChargeEnergy: 0.5,
    batteryDischargeEnergy: 0,
    solarEnergy: 0.5,
    homeOutputEnergy: 0.5,
  });
  meters.update('dev', { gridInputPower: 600 }, SLOT0 + MINUTE);
  meters.update('dev', {}, SLOT0 + 6 * MINUTE);
  assert.equal(meters.totals('dev').gridInputEnergy, 0.05);
  await meters.save();
  // Still readable by 1.7.0: same version, same slot layout, totals additive.
  const saved = JSON.parse(await readFile(join(dataDir, 'energy.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.devices.dev.kwh.batteryChargeEnergy, 4);
  assert.equal(saved.devices.dev.slots[0].length, 5);
});
