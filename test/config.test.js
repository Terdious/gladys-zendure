import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

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
