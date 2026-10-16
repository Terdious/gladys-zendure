import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWriteCommand,
  createWriteThrottle,
  maxPowerFor,
  socScaleOf,
  ControlRefusedError,
  WRITE_INTERVALS_IN_MS,
} from '../../src/zendure/control.js';

const SF800_PRO = 'SolarFlow 800 Pro';
const SF2400_AC_PLUS = 'SolarFlow 2400 AC+';

test('power limits are clamped to the model rating, widened by the reported maximum', () => {
  assert.equal(maxPowerFor(SF800_PRO, 'discharge', {}), 800);
  assert.equal(maxPowerFor(SF800_PRO, 'charge', {}), 1000);
  assert.equal(maxPowerFor(SF2400_AC_PLUS, 'charge', {}), 3200);
  // A device reporting a higher limit widens it; a lower report never narrows.
  assert.equal(
    maxPowerFor(SF800_PRO, 'discharge', { properties: { inverseMaxPower: 1200 } }),
    1200,
  );
  assert.equal(maxPowerFor(SF800_PRO, 'discharge', { inverseMaxPower: 400 }), 800);

  const write = buildWriteCommand(
    { kind: 'input_limit', watts: -20 },
    { productModel: SF800_PRO, payload: {} },
  );
  assert.deepEqual(write, {
    setting: 'inputLimit',
    properties: { smartMode: 1, inputLimit: 0 },
    applied: { inputLimit: 0 },
  });
});

test('a power limit within 5 W of the reported one is not rewritten', () => {
  const payload = { properties: { outputLimit: 400 } };
  const device = { productModel: SF800_PRO, payload };
  assert.equal(buildWriteCommand({ kind: 'output_limit', watts: 404 }, device), null);
  assert.ok(buildWriteCommand({ kind: 'output_limit', watts: 420 }, device));
});

test('the AC mode maps charge to 1 and discharge to 2, nothing sent when already set', () => {
  const device = { productModel: SF800_PRO, payload: { acMode: 2 } };
  assert.deepEqual(buildWriteCommand({ kind: 'ac_mode', mode: 'charge' }, device).properties, {
    acMode: 1,
  });
  assert.equal(buildWriteCommand({ kind: 'ac_mode', mode: 'discharge' }, device), null);
  assert.throws(
    () => buildWriteCommand({ kind: 'ac_mode', mode: 'eco' }, device),
    ControlRefusedError,
  );
});

test('SoC limits follow the scale the battery reports (percent or tenths)', () => {
  assert.equal(socScaleOf({}), null);
  assert.equal(socScaleOf({ properties: { socSet: 1000 } }), 10);
  assert.equal(socScaleOf({ socSet: 95 }), 1);

  const tenths = {
    productModel: SF800_PRO,
    payload: { properties: { socSet: 1000, minSoc: 100 } },
  };
  assert.deepEqual(buildWriteCommand({ kind: 'soc_limits', max_soc: 90, min_soc: 15 }, tenths), {
    setting: 'soc',
    properties: { socSet: 900, minSoc: 150 },
    applied: { socSet: 90, minSoc: 15 },
  });
  const percent = { productModel: SF800_PRO, payload: { socSet: 100 } };
  assert.deepEqual(buildWriteCommand({ kind: 'soc_limits', min_soc: 10 }, percent).properties, {
    minSoc: 10,
  });
});

test('SoC limits are refused out of the zenSDK ranges or before the first report', () => {
  const device = { productModel: SF800_PRO, payload: { socSet: 100 } };
  assert.throws(() => buildWriteCommand({ kind: 'soc_limits', max_soc: 60 }, device), /70 and 100/);
  assert.throws(() => buildWriteCommand({ kind: 'soc_limits', min_soc: 60 }, device), /0 and 50/);
  assert.throws(() => buildWriteCommand({ kind: 'soc_limits' }, device), /max_soc, min_soc/);
  assert.throws(
    () =>
      buildWriteCommand(
        { kind: 'soc_limits', max_soc: 90 },
        { productModel: SF800_PRO, payload: {} },
      ),
    /not reported its SoC settings/,
  );
});

test('the write throttle is per device and per setting', () => {
  const throttle = createWriteThrottle();
  const now = 1_000_000;
  throttle.record('dev', 'acMode', now);
  assert.throws(() => throttle.check('dev', 'acMode', now + 1000), /retry in 29 s/);
  throttle.check('dev', 'outputLimit', now + 1000);
  throttle.check('other', 'acMode', now + 1000);
  throttle.check('dev', 'acMode', now + WRITE_INTERVALS_IN_MS.acMode);
});
