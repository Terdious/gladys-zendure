// -----------------------------------------------------------------------------
// Zendure zenSDK local HTTP runtime.
//
// Every recent SolarFlow serves a small HTTP API on the home network (the
// "zenSDK" local API). It is what the official Home Assistant integration uses
// for these models — not MQTT:
//   - read:  `GET  http://{address}/properties/report` returns the same JSON as
//            a cloud MQTT `properties/report` (`properties` + `packData`), and
//            it is always COMPLETE (every property), unlike the MQTT reports;
//   - write: `POST http://{address}/properties/write` with
//            `{ id: <incrementing>, sn: <serial number>, properties: {...} }`.
// The address is the device's LAN `ip` from the cloud deviceList, or its mDNS
// name `zendure-{productModel without spaces}-{serial}.local` when the cloud
// gives none (mDNS rarely resolves inside a Docker container: the integration
// accepts an address override per serial number).
//
// The API only answers requests, so this runtime polls it: one request in
// flight per device at most, a short timeout, the devices staggered over the
// interval and a global concurrency cap (no burst of 17 requests at once), and
// a backoff on a device that stopped answering. It exposes the same surface as
// the MQTT runtimes (getLatestPayload, getLastPayloadAt, onPayload,
// writeDeviceProperties, requestDeviceProperties, getStats, disconnect), keyed
// by SERIAL NUMBER like the local MQTT runtime, so the device layer serves it
// through the same code paths.
//
// Attribution: the endpoints, the request shape, the header and the 2 s
// timeout are the ones of the official Home Assistant integration
// Zendure/Zendure-HA (MIT License, (c) 2024 peteS-UK), class `ZendureZenSdk`.
// Only those protocol facts are reused; the code is our own.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { mergeMqttPayload } from './mqtt.js';

const logger = createLogger({ name: 'zendure-zensdk' });

// Live data cadence. Five seconds follows the device closely enough for the
// dashboards and the control automations (Zendure-HA re-reads these devices
// every 2 to 4 s while it regulates them), while the integration's own publish
// channel ticks every ~2 s and deduplicates unchanged values, so polling
// faster would not show up any sooner in Gladys. On a LAN it is negligible:
// 17 devices make ~3.4 small requests per second.
export const ZENSDK_POLL_INTERVAL_IN_MS = 5 * 1000;
// Zendure-HA's own timeout: a LAN device answers in a few tens of ms.
export const ZENSDK_REQUEST_TIMEOUT_IN_MS = 2 * 1000;
// A device that missed this many requests in a row is "down": the device
// layer moves it to another source, and its retries back off.
export const ZENSDK_FAILURES_BEFORE_DOWN = 3;
// Retry cadence of a down device: doubles from the poll interval up to this.
export const ZENSDK_MAX_BACKOFF_IN_MS = 60 * 1000;
// A device without a successful answer for this long is not "up" any more,
// whatever its failure count (covers a stalled loop).
export const ZENSDK_SILENCE_TIMEOUT_IN_MS = 30 * 1000;
// At most this many requests in flight across every device.
export const ZENSDK_MAX_CONCURRENT_REQUESTS = 4;

const HEADERS = { 'content-type': 'application/json; charset=UTF-8' };

// A host is an IPv4 address, a bracketed IPv6 address or a DNS name (with an
// optional port): nothing that could reshape the request URL.
const HOST_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/**
 * Parse the `local_http_addresses` option and keep what was ignored:
 * `SERIAL=ADDRESS` pairs separated by commas, semicolons, spaces or line
 * breaks (spaces around `=` allowed). Serial numbers are compared
 * case-insensitively: the keys are upper-cased.
 * @param {string} text raw option value
 * @returns {{ overrides: Map<string, string>, invalid: Array<string> }}
 *   serial number (upper case) -> host, and the pairs that were not usable
 */
export function parseAddressOverridesDetailed(text) {
  const overrides = new Map();
  const invalid = [];
  const normalized = String(text || '').replace(/\s*=\s*/g, '=');
  for (const pair of normalized.split(/[\s,;]+/)) {
    if (pair === '') {
      continue;
    }
    const separator = pair.indexOf('=');
    const serial = separator > 0 ? pair.slice(0, separator).trim() : '';
    const host = separator > 0 ? pair.slice(separator + 1).trim() : '';
    if (serial !== '' && HOST_PATTERN.test(host)) {
      overrides.set(serial.toUpperCase(), host);
    } else {
      invalid.push(pair);
    }
  }
  return { overrides, invalid };
}

/**
 * Parse the `local_http_addresses` option (see parseAddressOverridesDetailed):
 * invalid pairs are ignored.
 * @param {string} text raw option value
 * @returns {Map<string, string>} serial number (upper case) -> host
 */
export function parseAddressOverrides(text) {
  return parseAddressOverridesDetailed(text).overrides;
}

/**
 * mDNS name a zenSDK device announces itself with (Zendure-HA convention).
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @returns {string}
 */
export function zenSdkMdnsName(rawCloudDevice) {
  const model = String(rawCloudDevice.productModel || '').replace(/\s+/g, '');
  return `zendure-${model}-${rawCloudDevice.snNumber}.local`;
}

/**
 * Where to reach the local HTTP API of a device: the user's override for its
 * serial number, else the `ip` of the cloud deviceList, else its mDNS name.
 * Null without a serial number (needed by the mDNS name and every write).
 * @param {object} rawCloudDevice device from the cloud deviceList
 * @param {Map<string, string>} [overrides] parsed `local_http_addresses`
 * @returns {{ host: string, origin: 'override'|'cloud'|'mdns' }|null}
 */
export function zenSdkAddressOf(rawCloudDevice, overrides = new Map()) {
  const serial = rawCloudDevice?.snNumber;
  if (!serial || typeof serial !== 'string' || serial.trim() === '') {
    return null;
  }
  const override = overrides.get(serial.trim().toUpperCase());
  if (override) {
    return { host: override, origin: 'override' };
  }
  const ip = typeof rawCloudDevice.ip === 'string' ? rawCloudDevice.ip.trim() : '';
  if (ip !== '' && HOST_PATTERN.test(ip)) {
    return { host: ip, origin: 'cloud' };
  }
  return { host: zenSdkMdnsName(rawCloudDevice), origin: 'mdns' };
}

/**
 * Delay before the next poll of a device after `failures` misses in a row:
 * the normal interval while it is up, then doubling up to the maximum.
 * @param {number} failures consecutive failed requests
 * @param {number} [interval] normal poll interval (ms)
 * @returns {number} delay (ms)
 */
export function zenSdkRetryDelay(failures, interval = ZENSDK_POLL_INTERVAL_IN_MS) {
  if (failures < ZENSDK_FAILURES_BEFORE_DOWN) {
    return interval;
  }
  const exponent = failures - ZENSDK_FAILURES_BEFORE_DOWN + 1;
  return Math.min(ZENSDK_MAX_BACKOFF_IN_MS, interval * 2 ** exponent);
}

/** A short, log-friendly reason for a failed request (never a payload). */
function describeError(error, timeoutMs) {
  if (!error) {
    return 'unknown error';
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `no answer within ${timeoutMs / 1000} s`;
  }
  // undici wraps the system error (ENOTFOUND, ECONNREFUSED, EHOSTUNREACH...).
  const code = error.cause?.code || error.code;
  return code ? `${code}` : error.message || String(error);
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Create the zenSDK local HTTP runtime.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injectable fetch (tests)
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxConcurrent]
 * @returns {object} the runtime
 */
export function createZendureZenSdk({
  fetchImpl = globalThis.fetch,
  pollIntervalMs = ZENSDK_POLL_INTERVAL_IN_MS,
  timeoutMs = ZENSDK_REQUEST_TIMEOUT_IN_MS,
  maxConcurrent = ZENSDK_MAX_CONCURRENT_REQUESTS,
} = {}) {
  // serial -> { rawCloudDevice, host, origin, failures, lastError,
  //             lastSuccessAt, inFlight, timer, label }
  const devices = new Map();
  const latestPayloadBySerial = new Map();
  const lastPayloadAtBySerial = new Map();
  const payloadListeners = new Set();
  let running = false;
  // Bumped by disconnect(): answers of requests sent before are dropped.
  let generation = 0;
  let writeId = 0;
  let requestCount = 0;
  let failureCount = 0;

  // Global concurrency cap: a FIFO of waiters for a request slot.
  let activeRequests = 0;
  const slotWaiters = [];
  async function acquireSlot() {
    if (activeRequests < maxConcurrent) {
      activeRequests += 1;
      return;
    }
    await new Promise((resolve) => slotWaiters.push(resolve));
    activeRequests += 1;
  }
  function releaseSlot() {
    activeRequests -= 1;
    const next = slotWaiters.shift();
    if (next) {
      next();
    }
  }

  async function request(entry, path, init = {}) {
    await acquireSlot();
    requestCount += 1;
    // Our own timer rather than AbortSignal.timeout(): it also bounds reading
    // the body, and it is cleared as soon as the request settles.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('request timed out', 'TimeoutError')),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(`http://${entry.host}/${path}`, {
        ...init,
        headers: HEADERS,
        signal: controller.signal,
      });
      if (!response || response.status >= 400) {
        throw new Error(`HTTP ${response?.status}`);
      }
      return { text: await response.text() };
    } finally {
      clearTimeout(timer);
      releaseSlot();
    }
  }

  function isUp(entry, now = Date.now()) {
    return (
      entry.lastSuccessAt !== null &&
      entry.failures < ZENSDK_FAILURES_BEFORE_DOWN &&
      now - entry.lastSuccessAt <= ZENSDK_SILENCE_TIMEOUT_IN_MS
    );
  }

  /** Delay before the next poll of a device: normal, or backing off once down. */
  function nextDelayOf(entry) {
    return zenSdkRetryDelay(entry.failures, pollIntervalMs);
  }

  function schedule(entry, delay) {
    clearTimeout(entry.timer);
    if (!running) {
      return;
    }
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      await pollEntry(entry);
      if (devices.get(entry.serial) === entry) {
        schedule(entry, nextDelayOf(entry));
      }
    }, delay);
    // Do not keep the process alive just for the polling loop.
    if (typeof entry.timer.unref === 'function') {
      entry.timer.unref();
    }
  }

  async function readReport(entry) {
    const { text } = await request(entry, 'properties/report');
    const body = JSON.parse(text);
    if (!isPlainObject(body) || !isPlainObject(body.properties)) {
      throw new Error('unexpected answer (no properties)');
    }
    return body;
  }

  /** One poll of one device: at most one in flight, failures counted. */
  function pollEntry(entry) {
    if (entry.inFlight) {
      return entry.inFlight;
    }
    const startedGeneration = generation;
    entry.inFlight = (async () => {
      try {
        const report = await readReport(entry);
        if (startedGeneration !== generation || devices.get(entry.serial) !== entry) {
          return false;
        }
        const wasDown = entry.lastSuccessAt === null || !isUp(entry);
        entry.failures = 0;
        entry.lastError = null;
        entry.lastSuccessAt = Date.now();
        if (wasDown && entry.reportedDown) {
          logger.info(`local http: ${entry.label} answers again at ${entry.host}`);
        }
        entry.reportedDown = false;
        const merged = mergeMqttPayload(latestPayloadBySerial.get(entry.serial), report);
        latestPayloadBySerial.set(entry.serial, merged);
        lastPayloadAtBySerial.set(entry.serial, entry.lastSuccessAt);
        for (const listener of payloadListeners) {
          try {
            listener(entry.serial, merged, 'properties/report');
          } catch (e) {
            logger.warn(`local http: payload listener failed: ${e.message}`);
          }
        }
        return true;
      } catch (e) {
        if (startedGeneration !== generation) {
          return false;
        }
        failureCount += 1;
        entry.failures += 1;
        entry.lastError = describeError(e, timeoutMs);
        // Log a device going down once (INFO), the retries at debug level.
        if (entry.failures === ZENSDK_FAILURES_BEFORE_DOWN && entry.lastSuccessAt !== null) {
          entry.reportedDown = true;
          logger.info(
            `local http: ${entry.label} stopped answering at ${entry.host} (${entry.lastError})`,
          );
        } else {
          logger.debug(`local http: ${entry.label} at ${entry.host}: ${entry.lastError}`);
        }
        return false;
      } finally {
        entry.inFlight = null;
      }
    })();
    return entry.inFlight;
  }

  /**
   * Start a loop for every device without one yet (start() again after a
   * configuration change, setDevices() with a new or moved device while
   * running): never two loops for one device.
   */
  function startLoops() {
    const entries = [...devices.values()].filter((entry) => !entry.looping);
    entries.forEach((entry, index) => {
      entry.looping = true;
      const offset = Math.round((pollIntervalMs * index) / Math.max(1, entries.length));
      schedule(entry, entry.failures >= ZENSDK_FAILURES_BEFORE_DOWN ? nextDelayOf(entry) : offset);
    });
  }

  return {
    /** Running = polling; the per-device health is `isDeviceUp`. */
    get connected() {
      return running;
    },

    /**
     * Set the devices to poll (replaces the previous set). A device whose
     * address did not change keeps its cache and health; one whose address
     * changed starts afresh at the new one.
     * @param {Array<{ rawCloudDevice: object, host: string, origin: string }>} entries
     */
    setDevices(entries) {
      const next = new Map();
      for (const { rawCloudDevice, host, origin } of entries) {
        const serial = rawCloudDevice.snNumber;
        const previous = devices.get(serial);
        if (previous && previous.host === host) {
          previous.rawCloudDevice = rawCloudDevice;
          previous.origin = origin;
          next.set(serial, previous);
          continue;
        }
        if (previous) {
          clearTimeout(previous.timer);
          latestPayloadBySerial.delete(serial);
          lastPayloadAtBySerial.delete(serial);
        }
        next.set(serial, {
          serial,
          rawCloudDevice,
          host,
          origin,
          label: `${rawCloudDevice.deviceName || rawCloudDevice.productModel || 'device'} (SN ${serial})`,
          failures: 0,
          lastError: null,
          lastSuccessAt: null,
          reportedDown: false,
          looping: false,
          inFlight: null,
          timer: null,
        });
      }
      for (const [serial, entry] of devices) {
        if (!next.has(serial)) {
          clearTimeout(entry.timer);
          latestPayloadBySerial.delete(serial);
          lastPayloadAtBySerial.delete(serial);
        }
      }
      devices.clear();
      for (const [serial, entry] of next) {
        devices.set(serial, entry);
      }
      // A device added or moved to a new address while polling gets its loop
      // now (its previous loop, if any, stops by itself: it is not in the
      // map any more).
      if (running) {
        startLoops();
      }
    },

    /**
     * Poll every device once (the startup probe), concurrency-capped.
     * @returns {Promise<void>}
     */
    async pollAll() {
      await Promise.all([...devices.values()].map((entry) => pollEntry(entry)));
    },

    /**
     * Start the polling loops, the devices staggered over one interval so
     * they never all fire at once. Idempotent.
     */
    start() {
      running = true;
      startLoops();
    },

    /** Same role as the MQTT runtimes: no topics here, devices come from setDevices. */
    subscribeDevice() {},

    /**
     * Ask for fresh properties now (e.g. right after a write).
     * @param {object} rawCloudDevice device from the cloud deviceList
     * @returns {boolean} true when a request was started
     */
    requestDeviceProperties(rawCloudDevice) {
      const entry = devices.get(rawCloudDevice?.snNumber);
      if (!entry) {
        return false;
      }
      pollEntry(entry).catch(() => {});
      return true;
    },

    /**
     * Write properties through `POST /properties/write`.
     * @param {object} rawCloudDevice device from the cloud deviceList
     * @param {Record<string, number>} properties
     * @returns {Promise<void>} rejects when the device did not accept it
     */
    async writeDeviceProperties(rawCloudDevice, properties) {
      const entry = devices.get(rawCloudDevice?.snNumber);
      if (!entry) {
        throw new Error('device not served by the local HTTP API');
      }
      writeId = (writeId + 1) % 1000000;
      try {
        await request(entry, 'properties/write', {
          method: 'POST',
          body: JSON.stringify({ id: writeId, sn: entry.serial, properties }),
        });
      } catch (e) {
        throw new Error(`local HTTP write failed (${describeError(e, timeoutMs)})`, { cause: e });
      }
    },

    /** Whether a device currently answers (see ZENSDK_FAILURES_BEFORE_DOWN). */
    isDeviceUp(serial, now = Date.now()) {
      const entry = devices.get(serial);
      return entry ? isUp(entry, now) : false;
    },

    /**
     * Health of one device, for the logs and the badges.
     * @returns {{ host: string, origin: string, failures: number, lastError: string|null,
     * lastSuccessAt: number|null, everAnswered: boolean }|null}
     */
    getDeviceHealth(serial) {
      const entry = devices.get(serial);
      if (!entry) {
        return null;
      }
      return {
        host: entry.host,
        origin: entry.origin,
        failures: entry.failures,
        lastError: entry.lastError,
        lastSuccessAt: entry.lastSuccessAt,
        everAnswered: entry.lastSuccessAt !== null,
      };
    },

    getLatestPayload(serial) {
      return serial ? latestPayloadBySerial.get(String(serial)) || null : null;
    },

    getLastPayloadAt(serial) {
      return serial ? lastPayloadAtBySerial.get(String(serial)) || null : null;
    },

    getStats() {
      const now = Date.now();
      return {
        connected: running,
        trackedDevices: devices.size,
        devicesUp: [...devices.values()].filter((entry) => isUp(entry, now)).length,
        requests: requestCount,
        failures: failureCount,
        keysWithPayload: latestPayloadBySerial.size,
        connectCount: 0,
      };
    },

    onPayload(listener) {
      payloadListeners.add(listener);
      return () => payloadListeners.delete(listener);
    },

    /**
     * Stop the polling loops (push cleanup), keeping the devices, their
     * health and the caches: start() resumes them.
     */
    stop() {
      running = false;
      for (const entry of devices.values()) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.looping = false;
      }
    },

    /** Stop polling and clear every cache. */
    disconnect() {
      running = false;
      generation += 1;
      for (const entry of devices.values()) {
        clearTimeout(entry.timer);
      }
      devices.clear();
      latestPayloadBySerial.clear();
      lastPayloadAtBySerial.clear();
      payloadListeners.clear();
    },
  };
}
