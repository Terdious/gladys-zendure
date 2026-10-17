import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createZendureZenSdk,
  parseAddressOverrides,
  parseAddressOverridesDetailed,
  zenSdkAddressOf,
  zenSdkMdnsName,
  zenSdkRetryDelay,
  ZENSDK_FAILURES_BEFORE_DOWN,
  ZENSDK_MAX_BACKOFF_IN_MS,
  ZENSDK_POLL_INTERVAL_IN_MS,
} from '../../src/zendure/zensdk.js';
import { createFakeZenSdkFetch } from '../helpers/fakeZendure.js';

const DEVICE = {
  deviceKey: 'Dk1',
  snNumber: 'SN-HTTP-1',
  productModel: 'SolarFlow 800 Pro',
  deviceName: 'Garden battery',
  ip: '192.168.1.60',
};
const REPORT = {
  properties: { electricLevel: 64, outputLimit: 600, packNum: 1 },
  packData: [{ sn: 'C0A1' }],
};

function runtimeFor(fetchImpl, devices = [DEVICE], options = {}) {
  const runtime = createZendureZenSdk({ fetchImpl, ...options });
  runtime.setDevices(
    devices.map((rawCloudDevice) => ({ rawCloudDevice, ...zenSdkAddressOf(rawCloudDevice) })),
  );
  return runtime;
}

test('the address comes from the override, else the cloud ip, else the mDNS name', () => {
  const overrides = parseAddressOverrides('SN-HTTP-1=10.0.0.9, SN-2=host.lan:8080;bad pair x=');
  assert.deepEqual(
    [...overrides],
    [
      ['SN-HTTP-1', '10.0.0.9'],
      ['SN-2', 'host.lan:8080'],
    ],
  );
  // Nothing that could reshape the URL is accepted as a host.
  assert.equal(parseAddressOverrides('SN=10.0.0.1/admin?x').size, 0);

  assert.deepEqual(zenSdkAddressOf(DEVICE, overrides), { host: '10.0.0.9', origin: 'override' });
  assert.deepEqual(zenSdkAddressOf(DEVICE), { host: '192.168.1.60', origin: 'cloud' });
  const withoutIp = { ...DEVICE, ip: '' };
  assert.equal(zenSdkMdnsName(withoutIp), 'zendure-SolarFlow800Pro-SN-HTTP-1.local');
  assert.deepEqual(zenSdkAddressOf(withoutIp), {
    host: 'zendure-SolarFlow800Pro-SN-HTTP-1.local',
    origin: 'mdns',
  });
  // Spaces around "=" and the case of the serial number do not matter.
  const loose = parseAddressOverridesDetailed('sn-http-1 = 10.0.0.7,\nSN-3 =10.0.0.8; oops, x=a/b');
  assert.deepEqual(
    [...loose.overrides],
    [
      ['SN-HTTP-1', '10.0.0.7'],
      ['SN-3', '10.0.0.8'],
    ],
  );
  assert.deepEqual(loose.invalid, ['oops', 'x=a/b']);
  assert.deepEqual(zenSdkAddressOf(DEVICE, loose.overrides), {
    host: '10.0.0.7',
    origin: 'override',
  });
  assert.deepEqual(
    zenSdkAddressOf(
      { ...DEVICE, snNumber: 'Sn-Http-1' },
      parseAddressOverrides('SN-HTTP-1=10.0.0.9'),
    ),
    { host: '10.0.0.9', origin: 'override' },
  );
  // No serial number: no mDNS name and no write possible.
  assert.equal(zenSdkAddressOf({ ...DEVICE, snNumber: undefined }), null);
});

test('a poll reads GET /properties/report, caches it by serial and notifies', async () => {
  const fetchImpl = createFakeZenSdkFetch({ reports: { '192.168.1.60': REPORT } });
  const runtime = runtimeFor(fetchImpl);
  const seen = [];
  runtime.onPayload((key, payload) => seen.push({ key, payload }));

  await runtime.pollAll();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://192.168.1.60/properties/report');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.deepEqual(fetchImpl.calls[0].headers, {
    'content-type': 'application/json; charset=UTF-8',
  });
  assert.deepEqual(runtime.getLatestPayload('SN-HTTP-1'), REPORT);
  assert.equal(typeof runtime.getLastPayloadAt('SN-HTTP-1'), 'number');
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), true);
  assert.deepEqual(seen, [{ key: 'SN-HTTP-1', payload: REPORT }]);
  runtime.disconnect();
});

test('a device is down after consecutive failures, up again on the next answer', async () => {
  const fetchImpl = createFakeZenSdkFetch({ reports: { '192.168.1.60': REPORT } });
  const runtime = runtimeFor(fetchImpl);
  await runtime.pollAll();

  fetchImpl.fail('192.168.1.60');
  for (let i = 1; i < ZENSDK_FAILURES_BEFORE_DOWN; i += 1) {
    await runtime.pollAll();
    assert.equal(runtime.isDeviceUp('SN-HTTP-1'), true, 'a single miss is not an outage');
  }
  await runtime.pollAll();
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), false);
  const health = runtime.getDeviceHealth('SN-HTTP-1');
  assert.equal(health.failures, ZENSDK_FAILURES_BEFORE_DOWN);
  assert.equal(health.lastError, 'EHOSTUNREACH');
  assert.equal(health.everAnswered, true);
  // The last good report stays readable (the device layer decides).
  assert.deepEqual(runtime.getLatestPayload('SN-HTTP-1'), REPORT);

  fetchImpl.recover('192.168.1.60');
  await runtime.pollAll();
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), true);
  assert.equal(runtime.getDeviceHealth('SN-HTTP-1').failures, 0);
  runtime.disconnect();
});

test('a device that never answered is not up, and a timeout is a failure', async () => {
  const fetchImpl = createFakeZenSdkFetch();
  fetchImpl.hang('192.168.1.60');
  const runtime = runtimeFor(fetchImpl, [DEVICE], { timeoutMs: 30 });
  await runtime.pollAll();
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), false);
  assert.equal(runtime.getDeviceHealth('SN-HTTP-1').lastError, 'no answer within 0.03 s');
  assert.equal(runtime.getDeviceHealth('SN-HTTP-1').everAnswered, false);
  runtime.disconnect();
});

test('a down device backs off from the poll interval up to the maximum', () => {
  assert.equal(zenSdkRetryDelay(0), ZENSDK_POLL_INTERVAL_IN_MS);
  assert.equal(zenSdkRetryDelay(ZENSDK_FAILURES_BEFORE_DOWN - 1), ZENSDK_POLL_INTERVAL_IN_MS);
  assert.equal(zenSdkRetryDelay(ZENSDK_FAILURES_BEFORE_DOWN), ZENSDK_POLL_INTERVAL_IN_MS * 2);
  assert.equal(zenSdkRetryDelay(ZENSDK_FAILURES_BEFORE_DOWN + 1), ZENSDK_POLL_INTERVAL_IN_MS * 4);
  assert.equal(zenSdkRetryDelay(50), ZENSDK_MAX_BACKOFF_IN_MS);
});

test('one request in flight per device, and a global concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    const text = JSON.stringify(REPORT);
    return { status: 200, text: async () => text };
  };
  const devices = Array.from({ length: 6 }, (_, i) => ({
    ...DEVICE,
    snNumber: `SN-${i}`,
    ip: `10.0.0.${i + 1}`,
  }));
  const runtime = runtimeFor(fetchImpl, devices, { maxConcurrent: 2 });

  // Two overlapping rounds: the second joins the requests in flight.
  await Promise.all([runtime.pollAll(), runtime.pollAll()]);
  assert.equal(calls.length, 6, 'one request per device');
  assert.equal(maxActive, 2, 'never more than the cap at once');
  assert.equal(runtime.getStats().devicesUp, 6);
  runtime.disconnect();
});

test('a write is a POST /properties/write with an incrementing id and the serial', async () => {
  const fetchImpl = createFakeZenSdkFetch({ reports: { '192.168.1.60': REPORT } });
  const runtime = runtimeFor(fetchImpl);

  await runtime.writeDeviceProperties(DEVICE, { smartMode: 1, outputLimit: 300 });
  await runtime.writeDeviceProperties(DEVICE, { acMode: 1 });

  const writes = fetchImpl.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].url, 'http://192.168.1.60/properties/write');
  assert.deepEqual(writes[0].body, {
    id: 1,
    sn: 'SN-HTTP-1',
    properties: { smartMode: 1, outputLimit: 300 },
  });
  assert.equal(writes[1].body.id, 2);

  fetchImpl.fail('192.168.1.60');
  await assert.rejects(
    runtime.writeDeviceProperties(DEVICE, { acMode: 2 }),
    /local HTTP write failed \(EHOSTUNREACH\)/,
  );
  await assert.rejects(
    runtime.writeDeviceProperties({ snNumber: 'other' }, { acMode: 2 }),
    /not served by the local HTTP API/,
  );
  runtime.disconnect();
});

test('an answer without properties is a failure, and nothing survives disconnect', async () => {
  const fetchImpl = createFakeZenSdkFetch({ reports: { '192.168.1.60': { hello: 'world' } } });
  const runtime = runtimeFor(fetchImpl);
  await runtime.pollAll();
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), false);
  assert.match(runtime.getDeviceHealth('SN-HTTP-1').lastError, /no properties/);

  fetchImpl.setReport('192.168.1.60', REPORT);
  await runtime.pollAll();
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), true);
  runtime.disconnect();
  assert.equal(runtime.getLatestPayload('SN-HTTP-1'), null);
  assert.equal(runtime.isDeviceUp('SN-HTTP-1'), false);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const callsTo = (fetchImpl, host) => fetchImpl.calls.filter((call) => call.host === host).length;

test('a moved device is polled at its new address by a single loop', async () => {
  const fetchImpl = createFakeZenSdkFetch({
    reports: { '192.168.1.60': REPORT, '192.168.1.99': REPORT },
  });
  const runtime = runtimeFor(fetchImpl, [DEVICE], { pollIntervalMs: 20 });
  runtime.start();
  await delay(50);
  // Same address again: nothing restarted.
  runtime.setDevices([{ rawCloudDevice: DEVICE, ...zenSdkAddressOf(DEVICE) }]);
  const moved = { ...DEVICE, ip: '192.168.1.99' };
  runtime.setDevices([{ rawCloudDevice: moved, ...zenSdkAddressOf(moved) }]);
  const oldCalls = callsTo(fetchImpl, '192.168.1.60');
  await delay(110);
  assert.equal(callsTo(fetchImpl, '192.168.1.60'), oldCalls, 'the old address is left');
  const newCalls = callsTo(fetchImpl, '192.168.1.99');
  // One loop: about one request per 20 ms (two loops would make ~11).
  assert.ok(newCalls >= 2 && newCalls <= 8, `${newCalls} requests in 110 ms`);
  assert.equal(runtime.getDeviceHealth('SN-HTTP-1').host, '192.168.1.99');
  runtime.disconnect();
});

test('stop() ends the loops and keeps the caches; start() resumes once', async () => {
  const fetchImpl = createFakeZenSdkFetch({ reports: { '192.168.1.60': REPORT } });
  const runtime = runtimeFor(fetchImpl, [DEVICE], { pollIntervalMs: 20 });
  runtime.start();
  await delay(50);
  runtime.stop();
  assert.equal(runtime.connected, false);
  const stoppedAt = fetchImpl.calls.length;
  await delay(80);
  assert.equal(fetchImpl.calls.length, stoppedAt, 'no request after stop()');
  assert.deepEqual(runtime.getLatestPayload('SN-HTTP-1'), REPORT);
  assert.notEqual(runtime.getDeviceHealth('SN-HTTP-1').lastSuccessAt, null);

  runtime.start();
  runtime.start();
  await delay(110);
  const resumed = fetchImpl.calls.length - stoppedAt;
  assert.ok(resumed >= 2 && resumed <= 8, `${resumed} requests in 110 ms`);
  runtime.disconnect();
});
