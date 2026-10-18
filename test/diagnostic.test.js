// -----------------------------------------------------------------------------
// Diagnostic actions (fleet_diagnostic, test_local_api): the snapshots of the
// device layer, the text reports and, above all, their redaction. Every
// request goes to in-process fakes.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys as createSdkFakeGladys } from '@gladysassistant/integration-sdk/testing';

import { ACTIONS, REPORT_INTROS, referenceOf } from '../src/actions.js';
import {
  buildFleetDiagnostic,
  buildLocalApiTestReport,
  createRedactor,
  hintForLocalApiError,
  maskIdentifier,
  truncateReport,
  formatFirmwareVersion,
  packCurrentAmperes,
  MASKED_HOST,
  MAX_REPORT_LENGTH,
  INTEGRATION_VERSION,
} from '../src/diagnostic.js';
import { buildDiscoveredDevices, describeDiagnostics } from '../src/devices/index.js';
import {
  solarflow,
  setSolarflowDependencies,
  resetSolarflowRuntime,
  pollLocalHttpNow,
} from '../src/devices/solarflow.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  createFakeZendureFetch,
  createFakeMqttLibrary,
  createFakeZenSdkFetch,
  createTestEnergyMeters,
  FAKE_APP_KEY,
  FAKE_CLOUD_KEY,
  FAKE_HTTP_SOLARFLOW_DEVICE,
  FAKE_HTTP_REPORT,
  FAKE_LOCAL_SOLARFLOW_DEVICE,
} from './helpers/fakeZendure.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// A battery with a realistic serial, served by its local API.
const HTTP_DEVICE = {
  ...FAKE_HTTP_SOLARFLOW_DEVICE,
  snNumber: 'WOB1A2B3C4D0159',
  ip: '192.168.1.80',
};
const HTTP_REPORT = {
  ...FAKE_HTTP_REPORT,
  sn: HTTP_DEVICE.snNumber,
  properties: { ...FAKE_HTTP_REPORT.properties, smartMode: 1 },
  packData: [{ sn: 'CO4FHMEFM300123', socLevel: 64, maxTemp: 3011 }],
};
// Everything that must never show up in a masked report.
const SECRETS = [
  FAKE_CLOUD_KEY,
  FAKE_APP_KEY,
  'mqtt-user',
  'mqtt-pass',
  'local-user',
  'local-pass',
];
const IDENTIFIERS = [
  HTTP_DEVICE.snNumber,
  FAKE_LOCAL_SOLARFLOW_DEVICE.snNumber,
  'CO4FHMEFM300123',
  HTTP_DEVICE.deviceKey,
  FAKE_LOCAL_SOLARFLOW_DEVICE.deviceKey,
];

const config = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY, enable_local_mqtt: true });

let gladys;
let zenSdk;
let stopPush = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup({
  deviceList = [HTTP_DEVICE, FAKE_LOCAL_SOLARFLOW_DEVICE],
  reports = { [HTTP_DEVICE.ip]: HTTP_REPORT },
  localFetchImpl,
} = {}) {
  zenSdk = localFetchImpl || createFakeZenSdkFetch({ reports });
  setSolarflowDependencies({
    fetchImpl: createFakeZendureFetch({ deviceList }),
    mqttLibrary: createFakeMqttLibrary(),
    localFetchImpl: zenSdk,
    energyMeters: createTestEnergyMeters().meters,
  });
}

async function start(cfg = config) {
  await buildDiscoveredDevices(gladys, cfg);
  stopPush = solarflow.startPush(gladys, cfg);
  await delay(50);
  await pollLocalHttpNow();
}

function assertMasked(text) {
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `secret "${secret}" leaked`);
  }
  for (const identifier of IDENTIFIERS) {
    assert.ok(!text.includes(identifier), `identifier "${identifier}" leaked`);
  }
  assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'an IP address leaked');
  assert.doesNotMatch(text, /\.local\b/, 'an mDNS name leaked');
}

beforeEach(() => {
  stopPush?.();
  stopPush = null;
  resetSolarflowRuntime();
  gladys = createFakeGladys();
  setup();
});

afterEach(() => {
  stopPush?.();
  stopPush = null;
  resetSolarflowRuntime();
});

test('maskIdentifier keeps the ends of a serial only', () => {
  assert.equal(maskIdentifier('WOB1A2B3C4D0159'), 'WOB1…0159');
  assert.equal(maskIdentifier('HtTp800'), 'Ht…');
  assert.equal(maskIdentifier('C0A1'), 'C…');
  assert.equal(maskIdentifier(null), '-');
});

test('the redactor always scrubs secrets, and hides identifiers only when masking', () => {
  const text = `key ${FAKE_CLOUD_KEY} pass local-pass ip 10.1.2.3 sn WOB1A2B3C4D0159 zendure-x.local`;
  const masked = createRedactor({
    includeIdentifiers: false,
    secrets: [FAKE_CLOUD_KEY, 'local-pass'],
    identifiers: ['WOB1A2B3C4D0159'],
  });
  assert.equal(
    masked.scrub(text),
    `key <redacted> pass <redacted> ip ${MASKED_HOST} sn WOB1…0159 ${MASKED_HOST}`,
  );
  assert.equal(masked.url('mqtt://192.168.1.50:1883'), `mqtt://${MASKED_HOST}:1883`);
  const full = createRedactor({
    includeIdentifiers: true,
    secrets: [FAKE_CLOUD_KEY, 'local-pass'],
  });
  assert.equal(
    full.scrub(text),
    'key <redacted> pass <redacted> ip 10.1.2.3 sn WOB1A2B3C4D0159 zendure-x.local',
  );
});

test('a long report is cut at a line boundary, with a note', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const cut = truncateReport(text, 2000);
  assert.ok(cut.length <= 2000);
  assert.match(cut, /\n\[\.\.\. report truncated: \d+ more character\(s\)/);
  assert.equal(truncateReport('short', 2000), 'short');
});

test('the fleet report describes the installation, masked by default', async () => {
  await start();
  const snapshot = await describeDiagnostics(gladys, config);
  const report = buildFleetDiagnostic(snapshot);

  assertMasked(report);
  assert.equal(INTEGRATION_VERSION, pkg.version);
  assert.match(report, new RegExp(`Integration version: ${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(report, /Cloud key: set/);
  assert.match(report, /Use the local API of the batteries: on/);
  assert.match(report, /Local MQTT: on/);
  assert.match(
    report,
    /Device list: loaded, 2 device\(s\), 2 supported; last request \d+ s ago: OK/,
  );
  assert.match(
    report,
    /Local MQTT mqtt:\/\/<local-ip>:1883: connected, 1 \(re\)connection\(s\) in the last 5 min/,
  );
  assert.match(report, /Polling: running .*2 device\(s\), 1 answering/);

  // The battery served by its local API.
  assert.match(report, /--- Shed inverter ---/);
  assert.match(report, /Serial: WOB1…0159 {3}Device key: Ht…/);
  assert.match(report, /Telemetry source: local http/);
  assert.match(
    report,
    /Local API: up at <local-ip> \(from the Zendure cloud device list\), 0 consecutive failure\(s\)/,
  );
  assert.match(
    report,
    /Battery: present, level 64 %, packNum 1, 1 pack\(s\): CO4F…0123 1\.92 kWh 64 %/,
  );
  assert.match(report, /Solar input: model has one, current 230 W/);
  assert.match(
    report,
    /Settings: outputLimit 600 W, inputLimit 800 W, acMode 2 \(discharge\), socSet 1000 \(100 %\), minSoc 100 \(10 %\), scale x10, smartMode 1/,
  );
  assert.match(
    report,
    /Remaining time: remainOutTime 135 min, remainInputTime 59940 \(no estimate\); widget shows: empty in 2 h 15/,
  );
  assert.match(report, /Energy counters: .*kWh/);
  // The other one, on its local MQTT broker (its address has no local API).
  assert.match(report, /--- Local battery ---/);
  assert.match(report, /Local MQTT: broker mqtt:\/\/<local-ip>:1883, connected/);
  // Every battery is local: the cloud broker stays idle.
  assert.match(report, /Cloud MQTT: not connected - idle, every battery is served locally/);
});

test('the fleet report shows identifiers only when asked, never the secrets', async () => {
  await start();
  const report = buildFleetDiagnostic(await describeDiagnostics(gladys, config), {
    includeIdentifiers: true,
  });
  for (const secret of SECRETS) {
    assert.ok(!report.includes(secret), `secret "${secret}" leaked`);
  }
  assert.match(report, /WARNING: this report shows full serial numbers and local addresses/);
  assert.ok(report.includes(HTTP_DEVICE.snNumber));
  assert.ok(report.includes('192.168.1.80'));
  assert.ok(report.includes('mqtt://192.168.1.50:1883'));
});

test('the fleet report can be filtered on one battery, and says when nothing matches', async () => {
  await start();
  const one = buildFleetDiagnostic(
    await describeDiagnostics(gladys, config, { filter: HTTP_DEVICE.snNumber.toLowerCase() }),
  );
  assert.match(one, /== Batteries \(1 matching "WOB1…0159"\) ==/);
  assert.doesNotMatch(one, /--- Local battery ---/);
  assertMasked(one);

  const none = buildFleetDiagnostic(await describeDiagnostics(gladys, config, { filter: 'nope' }));
  assert.match(none, /== Batteries: none matches "nope" ==/);
  assert.match(none, /Batteries of the account: Shed inverter, Local battery/);
});

test('a silent local API is reported with its error, and the cloud fallback as degraded', async () => {
  setup({ deviceList: [HTTP_DEVICE], reports: {} });
  const cfg = normalizeConfig({ cloud_key: FAKE_CLOUD_KEY });
  await start(cfg);
  const report = buildFleetDiagnostic(await describeDiagnostics(gladys, cfg));
  assertMasked(report);
  assert.match(
    report,
    /Local API: (pending|down) at <local-ip> .*last answer never, last error EHOSTUNREACH/,
  );
  assert.match(report, /Last data: local http never/);
});

test('the fleet report without a cloud key says so, and the failed request', async () => {
  const cfg = normalizeConfig({ cloud_key: '' });
  const report = buildFleetDiagnostic(await describeDiagnostics(gladys, cfg));
  assert.match(report, /Cloud key: MISSING/);
  assert.match(report, /Device list: NOT loaded; no request yet/);
  assert.match(report, /== Batteries \(0\) ==/);
});

test('the fleet report tells the savings tariff, and why it is ignored', async () => {
  const report = async (cfg) =>
    buildFleetDiagnostic(
      await describeDiagnostics(gladys, normalizeConfig({ cloud_key: '', ...cfg })),
    );
  assert.match(await report({}), /Savings estimate: none\n/);
  assert.match(
    await report({
      tariff_mode: 'peak_offpeak',
      price_peak: 0.2,
      price_offpeak: 0.1,
      offpeak_hours: '01:30-07:30,12:30-14:30',
    }),
    /Savings estimate: peak_offpeak, timezone Europe\/Paris, 2 off-peak range\(s\), resale off\n/,
  );
  assert.match(
    await report({ tariff_mode: 'base' }),
    /Savings estimate: base, timezone Europe\/Paris, resale off — IGNORED: the base price must be/,
  );
});

test('test_local_api reads the report once and lists the properties, masked', async () => {
  await start();
  const outcome = await import('../src/devices/index.js').then((m) =>
    m.testLocalApi(gladys, config, 'shed inverter'),
  );
  const calls = zenSdk.calls.length;
  const report = buildLocalApiTestReport(outcome);
  assert.equal(zenSdk.calls.length, calls, 'formatting sends nothing');
  assert.ok(
    zenSdk.calls.every((call) => call.method === 'GET'),
    'never a write',
  );

  assertMasked(report);
  assert.match(report, /Battery: Shed inverter \(SolarFlow 800\), serial WOB1…0159/);
  assert.match(report, /Address: <local-ip> \(from the Zendure cloud device list\)/);
  assert.match(report, /through the polling runtime, never two requests at once/);
  assert.match(report, /Result: OK - HTTP 200 in \d+ ms/);
  // Sorted properties.
  const keys = [...report.matchAll(/^ {2}(\w+) = /gm)].map((m) => m[1]);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.includes('outputLimit'));
  assert.match(report, /packData: 1 pack\(s\)\n {2}#1 sn CO4F…0123 maxTemp=3011 socLevel=64/);
  assert.match(report, /Other fields: sn="WOB1…0159"/);
});

test('test_local_api explains an mDNS name that does not resolve, without showing it', async () => {
  const { ip: _ip, ...withoutIp } = HTTP_DEVICE;
  const notFound = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  };
  setup({ deviceList: [withoutIp], localFetchImpl: notFound });
  const { testLocalApi } = await import('../src/devices/index.js');
  const outcome = await testLocalApi(gladys, config, HTTP_DEVICE.snNumber);
  assert.equal(outcome.viaRuntime, false, 'no runtime yet: a direct request');
  const report = buildLocalApiTestReport(outcome);
  assertMasked(report);
  assert.match(report, /Address: <local-ip> \(mDNS name, the cloud gives no IP address\)/);
  assert.match(report, /Result: FAILED - ENOTFOUND after \d+ ms/);
  assert.match(
    report,
    /Hint: The mDNS name does not resolve inside the container.*Local API addresses/,
  );

  const full = buildLocalApiTestReport(outcome, { includeIdentifiers: true });
  assert.ok(full.includes(`zendure-SolarFlow800-${HTTP_DEVICE.snNumber}.local`));
});

test('test_local_api hints for the usual failures', () => {
  const ip = { host: '192.168.1.80', origin: 'cloud' };
  assert.match(hintForLocalApiError('EHOSTUNREACH', ip), /same network/);
  assert.match(hintForLocalApiError('ECONNREFUSED', ip), /port 80/);
  assert.match(hintForLocalApiError('TIMEOUT', ip), /No answer in time/);
  assert.match(hintForLocalApiError('HTTP_404', ip), /without the zenSDK API/);
  assert.match(hintForLocalApiError('ENOTFOUND', ip), /does not resolve/);
  assert.match(hintForLocalApiError('HTTP_500', ip), /refused the request/);
});

test('test_local_api: unknown battery, model without local API, no cloud key', async () => {
  const { testLocalApi } = await import('../src/devices/index.js');
  const unknown = buildLocalApiTestReport(await testLocalApi(gladys, config, 'garage'));
  assert.match(unknown, /No battery matches "garage"/);
  assert.match(unknown, /Batteries of the account: Shed inverter, Local battery/);

  setup({ deviceList: [{ ...HTTP_DEVICE, productModel: 'Hyper 2000' }] });
  resetSolarflowRuntime();
  const hyper = buildLocalApiTestReport(await testLocalApi(gladys, config, 'Shed inverter'));
  assert.match(hyper, /This model has no zenSDK local API/);

  resetSolarflowRuntime();
  const ack = await ACTIONS.test_local_api(gladys, {
    fields: { device: 'Shed inverter' },
    config: normalizeConfig({ cloud_key: '' }),
  });
  assert.match(ack.en, /Zendure cloud device list unavailable: Zendure cloud key is missing/);
  await assert.rejects(
    ACTIONS.test_local_api(gladys, { fields: { device: ' ', device_ref: '' }, config }),
    /Pick a battery in the list/,
  );
});

test('the battery picked in the list wins over the free text', () => {
  assert.equal(
    referenceOf({ device: 'ext:zendure:solarflow:abc', device_ref: 'Shed' }),
    'ext:zendure:solarflow:abc',
  );
  assert.equal(referenceOf({ device: '', device_ref: ' Shed inverter ' }), 'Shed inverter');
  assert.equal(referenceOf({}), '');
});

test('a battery picked in the list (its external id) is found', async () => {
  await start();
  const picked = await ACTIONS.test_local_api(gladys, {
    fields: { device: `ext:zendure:solarflow:${HTTP_DEVICE.deviceKey}` },
    config,
  });
  assert.match(picked.en, /Battery: Shed inverter/);
  const typed = await ACTIONS.test_local_api(gladys, {
    fields: { device_ref: 'Shed inverter' },
    config,
  });
  assert.match(typed.en, /Battery: Shed inverter/);
});

test('every manifest action has a handler, and vice versa', () => {
  assert.deepEqual(
    Object.keys(ACTIONS).sort(),
    manifest.actions.map((action) => action.key).sort(),
  );
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
    const keys = action.fields.map((field) => field.key);
    assert.deepEqual(keys, ['device', 'device_ref', 'include_identifiers'], `${action.key} fields`);
    const picker = action.fields[0];
    assert.equal(picker.type, 'select');
    assert.equal(picker.source, 'devices', 'the batteries created in Gladys, as in gladys-tuya');
    assert.equal(action.fields[1].type, 'string');
    const identifiers = action.fields.find((field) => field.key === 'include_identifiers');
    assert.equal(identifiers.type, 'boolean');
    assert.equal(identifiers.default, false, 'identifiers are masked by default');
  }
  for (const intro of Object.values(REPORT_INTROS)) {
    assert.deepEqual(Object.keys(intro).sort(), ['de', 'en', 'es', 'fr']);
  }
});

test('the actions run through the SDK: a report in every language, masked by default', async () => {
  await start();
  const sdk = createSdkFakeGladys({ config: { cloud_key: FAKE_CLOUD_KEY } });
  for (const [key, handler] of Object.entries(ACTIONS)) {
    sdk.onAction(key, (fields) => handler(gladys, { fields, config }));
  }
  await sdk.connect();
  try {
    const fleet = await sdk.fake.action('fleet_diagnostic', {
      device: '',
      include_identifiers: false,
    });
    assert.equal(fleet.success, true);
    const { message } = fleet.data;
    assert.deepEqual(Object.keys(message).sort(), ['de', 'en', 'es', 'fr']);
    for (const [language, text] of Object.entries(message)) {
      assert.ok(text.startsWith(REPORT_INTROS.masked[language]), `${language} intro`);
      assert.match(text, /Zendure integration diagnostic/);
      assertMasked(text);
    }

    const local = await sdk.fake.action('test_local_api', {
      device: 'Shed inverter',
      include_identifiers: true,
    });
    assert.equal(local.success, true);
    assert.ok(local.data.message.fr.startsWith(REPORT_INTROS.full.fr));
    assert.ok(local.data.message.en.includes('192.168.1.80'));
    for (const secret of SECRETS) {
      assert.ok(!local.data.message.en.includes(secret));
    }
  } finally {
    await sdk.disconnect();
  }
});

test('the fleet report details firmware, Wi-Fi, states and packs, still masked', async () => {
  setup({
    reports: {
      [HTTP_DEVICE.ip]: {
        ...HTTP_REPORT,
        properties: {
          ...HTTP_REPORT.properties,
          softVersion: 4101,
          masterSoftVersion: 8197,
          dspversion: 'V1.2',
          rssi: -82,
          wifiState: 1,
          heatState: 0,
          lowTemperature: 0,
          socStatus: 1,
          socLimit: 2,
          pass: 3,
          hemsState: 0,
          faultLevel: 0,
          hyperTmp: 3051,
        },
        packData: [
          {
            sn: 'CO4FHMEFM300123',
            socLevel: 64,
            maxTemp: 3011,
            totalVol: 5210,
            batcur: 65504,
            soh: 1000,
            softVersion: 4103,
          },
        ],
      },
    },
  });
  await start();
  const snapshot = await describeDiagnostics(gladys, config);
  const report = buildFleetDiagnostic(snapshot);

  assertMasked(report);
  assert.match(
    report,
    /Pack #1 CO4F…0123: socLevel 64 %, maxTemp 28 °C \(3011\), totalVol 52\.1 V, batcur -3\.2 A, soh 100 %, softVersion v1\.0\.7 \(4103\)/,
  );
  assert.match(
    report,
    /Firmware: softVersion v1\.0\.5 \(4101\), masterSoftVersion v2\.0\.5 \(8197\), dspversion V1\.2/,
  );
  assert.match(report, /Network: rssi -82 dBm \(WEAK signal, below -75 dBm/);
  assert.match(report, /wifiState 1 \(connected\)/);
  assert.match(
    report,
    /States: heatState 0 \(off\), lowTemperature 0 \(no\), socStatus 1 \(calibrating\), socLimit 2 \(full\), pass 3 \(grid direct supply\), hemsState 0 \(off\), faultLevel 0, hyperTmp 32 °C \(3051\)/,
  );
  // The battery on local MQTT reports none of them.
  assert.match(report, /Firmware: not reported/);
  // The SolarFlow 800 has no off-grid port: no off-grid counter listed.
  const shed = report.slice(report.indexOf('--- Shed inverter ---'));
  assert.match(shed, /Energy counters: .*gridInputEnergy/);
  assert.doesNotMatch(shed.split('\n---')[0], /offGridEnergy/);

  // A good signal gets no hint; 17 detailed batteries stay within the bound.
  const [device] = snapshot.devices.filter((d) => d.name === 'Shed inverter');
  const fleet = { ...snapshot, devices: Array.from({ length: 17 }, () => device) };
  fleet.devices[0] = { ...device, network: { rssi: -60 } };
  const big = buildFleetDiagnostic(fleet);
  assert.match(big, /Network: rssi -60 dBm\n/);
  assert.ok(big.length <= MAX_REPORT_LENGTH);
  assertMasked(big);
});

test('firmware versions and pack currents decode like Zendure-HA', () => {
  assert.equal(formatFirmwareVersion(4101), 'v1.0.5 (4101)');
  assert.equal(formatFirmwareVersion('4101'), 'v1.0.5 (4101)');
  assert.equal(formatFirmwareVersion(0), '0 (not provided)');
  assert.equal(formatFirmwareVersion(3), '3');
  assert.equal(formatFirmwareVersion('V2.1.0'), 'V2.1.0');
  assert.equal(packCurrentAmperes(32), 3.2);
  assert.equal(packCurrentAmperes(65535), -0.1);
  assert.equal(packCurrentAmperes(32768), -3276.8);
  assert.equal(packCurrentAmperes('x'), null);
});
