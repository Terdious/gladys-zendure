import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  decodeCloudKey,
  buildSignedHeaders,
  fetchCloudData,
  ZendureCloudError,
} from '../../src/zendure/client.js';
import { AUTH } from '../../src/zendure/constants.js';

const API_URL = 'https://app.zendure.example';
const APP_KEY = 'myAppKey123';
const CLOUD_KEY = Buffer.from(`${API_URL}.${APP_KEY}`).toString('base64');

function jsonResponse(body, status = 200) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function validCloudBody() {
  return {
    success: true,
    code: 200,
    data: {
      deviceList: [{ deviceKey: 'dev1', productKey: 'prod1', productModel: 'SolarFlow 800 Pro' }],
      mqtt: { url: 'broker.zendure.example:1883', username: 'user', password: 'pass' },
    },
  };
}

// --- decodeCloudKey ----------------------------------------------------------

test('decodeCloudKey splits the API URL and the app key on the last dot', () => {
  const { apiUrl, appKey } = decodeCloudKey(CLOUD_KEY);
  assert.equal(apiUrl, API_URL);
  assert.equal(appKey, APP_KEY);
});

test('decodeCloudKey trims surrounding whitespace', () => {
  const { appKey } = decodeCloudKey(`  ${CLOUD_KEY}  `);
  assert.equal(appKey, APP_KEY);
});

test('decodeCloudKey rejects an empty or short key', () => {
  assert.throws(() => decodeCloudKey(''), ZendureCloudError);
  assert.throws(() => decodeCloudKey('abc'), ZendureCloudError);
});

test('decodeCloudKey rejects a token without separator dot', () => {
  const noDot = Buffer.from('no-separator-here').toString('base64');
  assert.throws(() => decodeCloudKey(noDot), ZendureCloudError);
});

test('decodeCloudKey rejects a token with an empty app key part', () => {
  const trailingDot = Buffer.from('https://app.zendure.example.').toString('base64');
  assert.throws(() => decodeCloudKey(trailingDot), ZendureCloudError);
});

// --- buildSignedHeaders ------------------------------------------------------

test('buildSignedHeaders returns the signed header set', () => {
  const headers = buildSignedHeaders(APP_KEY, { timestamp: 1700000000, nonce: '12345' });

  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.timestamp, '1700000000');
  assert.equal(headers.nonce, '12345');
  assert.equal(headers.clientid, AUTH.CLIENT_ID);

  // Recompute the expected SHA1: SIGN_KEY + appKey/nonce/timestamp (sorted) + SIGN_KEY.
  const bodyStr = `appKey${APP_KEY}nonce12345timestamp1700000000`;
  const expected = crypto
    .createHash('sha1')
    .update(`${AUTH.SIGN_KEY}${bodyStr}${AUTH.SIGN_KEY}`, 'utf8')
    .digest('hex')
    .toUpperCase();
  assert.equal(headers.sign, expected);
});

test('buildSignedHeaders generates timestamp and nonce when not provided', () => {
  const headers = buildSignedHeaders(APP_KEY);
  assert.match(headers.timestamp, /^\d{10}$/);
  assert.match(headers.nonce, /^\d{5}$/);
  assert.match(headers.sign, /^[0-9A-F]{40}$/);
});

// --- fetchCloudData ----------------------------------------------------------

test('fetchCloudData POSTs the signed deviceList request and returns the data', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(validCloudBody());
  };

  const data = await fetchCloudData(CLOUD_KEY, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_URL}/api/ha/deviceList`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { appKey: APP_KEY });
  assert.equal(calls[0].options.headers.clientid, AUTH.CLIENT_ID);
  assert.ok(calls[0].options.headers.sign);

  assert.equal(data.deviceList.length, 1);
  assert.equal(data.deviceList[0].deviceKey, 'dev1');
  assert.equal(data.mqtt.username, 'user');
});

test('fetchCloudData rejects on HTTP error status', async () => {
  const fetchImpl = async () => jsonResponse({}, 500);
  await assert.rejects(fetchCloudData(CLOUD_KEY, { fetchImpl }), /HTTP 500/);
});

test('fetchCloudData rejects when the cloud reports a failure', async () => {
  const fetchImpl = async () => jsonResponse({ success: false, code: 401, msg: 'bad key' });
  await assert.rejects(fetchCloudData(CLOUD_KEY, { fetchImpl }), /code=401.*bad key/);
});

test('fetchCloudData rejects when the device list is missing', async () => {
  const body = validCloudBody();
  delete body.data.deviceList;
  const fetchImpl = async () => jsonResponse(body);
  await assert.rejects(fetchCloudData(CLOUD_KEY, { fetchImpl }), /device list is missing/);
});

test('fetchCloudData rejects when the device list is empty', async () => {
  const body = validCloudBody();
  body.data.deviceList = [];
  const fetchImpl = async () => jsonResponse(body);
  await assert.rejects(fetchCloudData(CLOUD_KEY, { fetchImpl }), /no device found/);
});

test('fetchCloudData rejects when the MQTT metadata is missing', async () => {
  const body = validCloudBody();
  body.data.mqtt = {};
  const fetchImpl = async () => jsonResponse(body);
  await assert.rejects(fetchCloudData(CLOUD_KEY, { fetchImpl }), /MQTT metadata is missing/);
});

test('fetchCloudData rejects an invalid cloud key without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(validCloudBody());
  };
  await assert.rejects(fetchCloudData('bad', { fetchImpl }), ZendureCloudError);
  assert.equal(called, false);
});

test('fetchCloudData maps a fetch timeout to a ZendureCloudError', async () => {
  const timeoutError = new Error('The operation was aborted due to timeout');
  timeoutError.name = 'TimeoutError';
  const fetchImpl = async () => {
    throw timeoutError;
  };
  await assert.rejects(
    fetchCloudData(CLOUD_KEY, { fetchImpl }),
    (error) => error.name === 'ZendureCloudError' && /timed out/.test(error.message),
  );
});
