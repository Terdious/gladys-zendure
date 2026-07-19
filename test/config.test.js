import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, toGladysPollFrequency, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({ cloud_key: 'aGVsbG8=', poll_frequency: 60 });
  assert.equal(config.cloud_key, 'aGVsbG8=');
  assert.equal(config.poll_frequency, 60);
});

test('normalizeConfig coerces values coming from a form', () => {
  const config = normalizeConfig({ cloud_key: '  aGVsbG8=  ', poll_frequency: '600' });
  assert.equal(config.cloud_key, 'aGVsbG8=');
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig falls back to the default for a missing field', () => {
  const config = normalizeConfig({ cloud_key: 'aGVsbG8=' });
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('toGladysPollFrequency snaps seconds to the allowed Gladys values (ms)', () => {
  assert.equal(toGladysPollFrequency(30), 30000); // exact match
  assert.equal(toGladysPollFrequency(1), 1000); // lower bound
  assert.equal(toGladysPollFrequency(12), 10000); // closest below
  assert.equal(toGladysPollFrequency(14), 15000); // closest above
  assert.equal(toGladysPollFrequency(45), 30000); // 45 s is closer to 30 s than 60 s
  assert.equal(toGladysPollFrequency(300), 60000); // capped at every minute
  assert.equal(toGladysPollFrequency(3600), 60000); // schema max still allowed
});
