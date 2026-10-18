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

test('normalizeConfig falls back to the default for an empty or invalid poll_frequency', () => {
  // An empty form field coerces to 0 (`Number('') === 0`) and garbage to NaN:
  // both used to snap to the FASTEST allowed frequency (1 s) instead of 30 s.
  assert.equal(normalizeConfig({ poll_frequency: '' }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: 0 }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: -5 }).poll_frequency, 30);
});

test('normalizeConfig defaults enable_local_mqtt to false', () => {
  assert.equal(normalizeConfig().enable_local_mqtt, false);
  assert.equal(normalizeConfig({ cloud_key: 'aGVsbG8=' }).enable_local_mqtt, false);
});

test('normalizeConfig coerces enable_local_mqtt from booleans and form strings', () => {
  assert.equal(normalizeConfig({ enable_local_mqtt: true }).enable_local_mqtt, true);
  assert.equal(normalizeConfig({ enable_local_mqtt: 'true' }).enable_local_mqtt, true);
  assert.equal(normalizeConfig({ enable_local_mqtt: 'on' }).enable_local_mqtt, true);
  assert.equal(normalizeConfig({ enable_local_mqtt: '1' }).enable_local_mqtt, true);
  assert.equal(normalizeConfig({ enable_local_mqtt: 'false' }).enable_local_mqtt, false);
  assert.equal(normalizeConfig({ enable_local_mqtt: false }).enable_local_mqtt, false);
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

test('toGladysPollFrequency snaps invalid input to the default frequency, not the fastest', () => {
  assert.equal(toGladysPollFrequency(NaN), 30000);
  assert.equal(toGladysPollFrequency(''), 30000);
  assert.equal(toGladysPollFrequency(0), 30000);
  assert.equal(toGladysPollFrequency(-5), 30000);
});

test('normalizeConfig keeps a supported feature_names language, English otherwise', () => {
  assert.equal(normalizeConfig({ feature_names: 'de' }).feature_names, 'de');
  assert.equal(normalizeConfig({ feature_names: 'it' }).feature_names, 'en');
  assert.equal(normalizeConfig({}).feature_names, 'en');
});

test('normalizeConfig enables the local HTTP API by default and coerces the toggle', () => {
  assert.equal(normalizeConfig().enable_local_http, true);
  assert.equal(normalizeConfig({ enable_local_http: 'false' }).enable_local_http, false);
  assert.equal(normalizeConfig({ enable_local_http: false }).enable_local_http, false);
  assert.equal(normalizeConfig({ enable_local_http: 'on' }).enable_local_http, true);
});

test('normalizeConfig keeps the local API address overrides as a trimmed string', () => {
  assert.equal(normalizeConfig().local_http_addresses, '');
  assert.equal(
    normalizeConfig({ local_http_addresses: '  SN1=10.0.0.2, SN2=10.0.0.3 ' }).local_http_addresses,
    'SN1=10.0.0.2, SN2=10.0.0.3',
  );
  assert.equal(normalizeConfig({ local_http_addresses: null }).local_http_addresses, '');
});

test('normalizeConfig: the savings tariff fields, prices never guessed', () => {
  const defaults = normalizeConfig();
  assert.equal(defaults.tariff_mode, 'none');
  assert.equal(defaults.price_base, null);
  assert.equal(defaults.resale_enabled, false);
  assert.equal(defaults.tariff_timezone, 'Europe/Paris');
  const config = normalizeConfig({
    tariff_mode: 'peak_offpeak',
    price_peak: '0,2081',
    price_offpeak: 0.1635,
    price_base: '',
    resale_price: -1,
    resale_enabled: 'true',
    offpeak_hours: ' 22:00-06:00 ',
    tariff_timezone: '  ',
  });
  assert.equal(config.price_peak, 0.2081);
  assert.equal(config.price_offpeak, 0.1635);
  assert.equal(config.price_base, null);
  assert.equal(config.resale_price, null);
  assert.equal(config.resale_enabled, true);
  assert.equal(config.offpeak_hours, '22:00-06:00');
  assert.equal(config.tariff_timezone, 'Europe/Paris');
  assert.equal(normalizeConfig({ tariff_mode: 'tempo' }).tariff_mode, 'none');
});
