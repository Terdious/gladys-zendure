// -----------------------------------------------------------------------------
// Diagnostic reports (manifest actions `fleet_diagnostic` and `test_local_api`).
//
// Supporting a battery that "does not work" used to take several round-trips
// with the user: which transport serves it, does its local API answer, at
// which address, what does it report. The logs carry most of it, but spread
// over hours and mixed with everything else. These reports rebuild the whole
// picture on demand, from the Configuration screen, as plain text the user
// pastes into a GitHub issue in one gesture.
//
// The device layer (src/devices/solarflow.js) gives RAW snapshots; this module
// formats and redacts them:
//   - secrets (cloud key, app key, broker credentials) are never printed, and
//     the final text is scrubbed of them whatever the options;
//   - identifiers (serial numbers, device keys, local IP addresses and host
//     names) are masked unless the user explicitly asks for them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

import { formatRemainingTime, REMAINING_TIME_UNKNOWN_IN_MIN } from './zendure/battery.js';
import { decikelvinToCelsius } from './zendure/deviceMapping.js';
import { ZENSDK_REQUEST_TIMEOUT_IN_MS } from './zendure/zensdk.js';

// Bound of a report, in characters: the result is shown under the action
// button (and acked once per Gladys language), so a 17-battery installation
// must not produce a wall of text. Beyond it the report is cut at a line
// boundary, with a note.
export const MAX_REPORT_LENGTH = 12000;
// Bound of one property value in the local API test.
const MAX_VALUE_LENGTH = 80;
// Bound of the properties listed by the local API test.
const MAX_LISTED_PROPERTIES = 150;

export const MASKED_HOST = '<local-ip>';
const REDACTED = '<redacted>';

// Property keys whose value is an identifier (masked unless asked) or a
// secret (never shown).
const IDENTIFIER_KEY = /(^sn$|sn$|serial|mac$|^ip$|ip$|ssid|host|server)/i;
const SECRET_KEY = /(pass|token|secret|^key$|appkey|auth)/i;

const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const MDNS_PATTERN = /\b[A-Za-z0-9-]+\.local\b/g;

const SOURCE_LABELS = {
  http: 'local http',
  local: 'local mqtt',
  cloud: 'cloud',
  unreachable: 'unreachable',
};

const ORIGIN_LABELS = {
  override: 'from the "Local API addresses" option',
  cloud: 'from the Zendure cloud device list',
  mdns: 'mDNS name, the cloud gives no IP address',
};

const AC_MODES = { 1: 'charge', 2: 'discharge' };

/** Version of the integration, from package.json (shipped in the image). */
export const INTEGRATION_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/**
 * Shorten an identifier so it can be told apart without being usable:
 * `WOB1234560159` -> `WOB1…0159`.
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function maskIdentifier(value) {
  const text = String(value ?? '');
  if (text === '') {
    return '-';
  }
  if (text.length <= 4) {
    return `${text.slice(0, 1)}…`;
  }
  if (text.length <= 8) {
    return `${text.slice(0, 2)}…`;
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The redaction rules of one report.
 * @param {object} options
 * @param {boolean} options.includeIdentifiers show serials and addresses in full
 * @param {Array<string>} [options.secrets] never shown, whatever the options
 * @param {Array<string>} [options.identifiers] serials, device keys (masked)
 * @param {Array<string>} [options.hosts] local addresses and host names (hidden)
 * @returns {{ id: Function, host: Function, url: Function, scrub: Function }}
 */
export function createRedactor({ includeIdentifiers, secrets = [], identifiers = [], hosts = [] }) {
  const mask = includeIdentifiers !== true;
  // Longest first: an mDNS name contains the serial, a secret may contain
  // another one.
  const byLength = (values) =>
    [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length >= 4))].sort(
      (a, b) => b.length - a.length,
    );
  const secretList = byLength(secrets);
  const hostList = byLength(hosts);
  const identifierList = byLength(identifiers);

  const host = (value) => {
    if (value === null || value === undefined || value === '') {
      return '-';
    }
    return mask ? MASKED_HOST : String(value);
  };
  return {
    masked: mask,
    id: (value) => (mask ? maskIdentifier(value) : String(value ?? '-')),
    host,
    /** A broker URL with its host hidden: `mqtt://<local-ip>:1883`. */
    url: (value) => {
      const text = String(value ?? '-');
      if (!mask) {
        return text;
      }
      return text.replace(/^([a-z]+:\/\/)?(\[[^\]]+\]|[^/:]+)/i, (_, scheme = '') => {
        return `${scheme}${MASKED_HOST}`;
      });
    },
    /** Final pass over the whole text (defense in depth). */
    scrub: (text) => {
      // Case-insensitive: a serial typed in lower case in a field is echoed.
      const replaceAll = (input, value, replacement) =>
        input.replace(new RegExp(escapeRegExp(value), 'gi'), replacement);
      let result = String(text);
      for (const secret of secretList) {
        result = replaceAll(result, secret, REDACTED);
      }
      if (mask) {
        for (const value of hostList) {
          result = replaceAll(result, value, MASKED_HOST);
        }
        for (const value of identifierList) {
          result = replaceAll(result, value, maskIdentifier(value));
        }
        result = result.replace(IPV4_PATTERN, MASKED_HOST).replace(MDNS_PATTERN, MASKED_HOST);
      }
      return result;
    },
  };
}

/**
 * Cut a report at a line boundary when it exceeds the bound, with a note.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncateReport(text, max = MAX_REPORT_LENGTH) {
  if (text.length <= max) {
    return text;
  }
  const noteRoom = 200;
  let cut = text.lastIndexOf('\n', max - noteRoom);
  if (cut <= 0) {
    cut = max - noteRoom;
  }
  return (
    `${text.slice(0, cut)}\n[... report truncated: ${text.length - cut} more character(s). ` +
    'Fill the "Battery" field to diagnose one battery at a time.]'
  );
}

/** `3 s ago`, `12 min ago`, `2 h ago`, or `never`. */
export function formatAge(at, now) {
  if (!at) {
    return 'never';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) {
    return `${seconds} s ago`;
  }
  if (seconds < 2 * 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  return `${Math.round(seconds / 3600)} h ago`;
}

const show = (value, unit = '') =>
  value === null || value === undefined ? '-' : `${value}${unit}`;
const yesNo = (value) => {
  if (value === true) {
    return 'yes';
  }
  return value === false ? 'no' : 'unknown';
};

function headerLines(title, now, redactor) {
  return [
    title,
    `Generated: ${new Date(now).toISOString()}`,
    `Integration version: ${INTEGRATION_VERSION} (Node ${process.version})`,
    redactor.masked
      ? 'Identifiers: masked (serial numbers shortened, local addresses hidden). No key nor password.'
      : 'WARNING: this report shows full serial numbers and local addresses: do not post it publicly. No key nor password.',
  ];
}

/** Identifiers and hosts of a fleet snapshot, for the final scrub. */
function sensitiveValuesOf(snapshot) {
  const identifiers = [];
  const hosts = [];
  for (const device of snapshot.devices) {
    identifiers.push(device.serial, device.deviceKey);
    for (const pack of device.battery?.packs || []) {
      identifiers.push(pack.sn);
    }
    hosts.push(device.localHttp?.address?.host);
    if (device.localMqtt?.brokerUrl) {
      hosts.push(hostOfUrl(device.localMqtt.brokerUrl));
    }
  }
  for (const broker of snapshot.brokers) {
    if (broker.kind === 'local') {
      hosts.push(hostOfUrl(broker.url));
    }
  }
  identifiers.push(...(snapshot.config?.addressOverrides?.unmatched || []));
  identifiers.push(...(snapshot.ignored || []).map((device) => device.id));
  return { identifiers, hosts };
}

function hostOfUrl(url) {
  const match = String(url || '').match(/^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^/:]+)/i);
  return match ? match[1] : null;
}

function describeLocalHttp(localHttp, redactor, now) {
  const where = localHttp.address
    ? ` at ${redactor.host(localHttp.address.host)} (${ORIGIN_LABELS[localHttp.address.origin] || localHttp.address.origin})`
    : '';
  switch (localHttp.status) {
    case 'unsupported-model':
      return 'not available on this model (no zenSDK local API)';
    case 'no-serial':
      return 'no serial number in the cloud device list: no address to try';
    case 'off':
      return `option "Use the local API of the batteries" is off (would be tried${where})`;
    case 'not-started':
      return `not started yet${where}`;
    case 'not-polled':
      return `not polled${where}`;
    default: {
      const details = [
        `${localHttp.failures ?? 0} consecutive failure(s)`,
        `last answer ${formatAge(localHttp.lastSuccessAt, now)}`,
      ];
      if (localHttp.lastError) {
        details.push(`last error ${localHttp.lastError}`);
      }
      return `${localHttp.status}${where}, ${details.join(', ')}`;
    }
  }
}

function describeSettings(settings) {
  const percent = (raw) =>
    raw === null || settings.socScale === null
      ? show(raw)
      : `${raw} (${Math.round(raw / settings.socScale)} %)`;
  const acMode =
    settings.acMode === null
      ? '-'
      : `${settings.acMode}${AC_MODES[settings.acMode] ? ` (${AC_MODES[settings.acMode]})` : ''}`;
  return [
    `outputLimit ${show(settings.outputLimit, ' W')}`,
    `inputLimit ${show(settings.inputLimit, ' W')}`,
    `acMode ${acMode}`,
    `socSet ${percent(settings.socSet)}`,
    `minSoc ${percent(settings.minSoc)}`,
    `scale ${settings.socScale === null ? 'unknown' : `x${settings.socScale}`}`,
    `smartMode ${show(settings.smartMode)}`,
  ].join(', ');
}

function describeRemaining(remaining) {
  const minutes = (value) => {
    if (value === null || value === undefined) {
      return '-';
    }
    return value >= REMAINING_TIME_UNKNOWN_IN_MIN ? `${value} (no estimate)` : `${value} min`;
  };
  const shown = remaining.computed
    ? `${remaining.computed.direction === 'charge' ? 'full' : 'empty'} in ${formatRemainingTime(remaining.computed.minutes)}`
    : 'none (idle or no estimate)';
  return `remainOutTime ${minutes(remaining.remainOutTime)}, remainInputTime ${minutes(remaining.remainInputTime)}; widget shows: ${shown}`;
}

function describeBattery(battery, redactor) {
  const parts = [
    battery.presence === null ? 'presence unknown yet' : battery.presence ? 'present' : 'absent',
    `level ${show(battery.level, ' %')}`,
    `packNum ${show(battery.packNum)}`,
  ];
  if (battery.packs === null) {
    parts.push('no packData');
  } else {
    const packs = battery.packs.map(
      (pack) =>
        `${redactor.id(pack.sn)} ${pack.capacityKwh === null ? 'unknown capacity' : `${pack.capacityKwh} kWh`}` +
        `${pack.socLevel === null ? '' : ` ${pack.socLevel} %`}`,
    );
    parts.push(`${battery.packs.length} pack(s)${packs.length ? `: ${packs.join('; ')}` : ''}`);
  }
  parts.push(`capacity ${battery.capacityKwh === null ? 'unknown' : `${battery.capacityKwh} kWh`}`);
  return parts.join(', ');
}

// Below this Wi-Fi signal (dBm) the local API and MQTT start to drop answers.
export const WEAK_RSSI_DBM = -75;
// Longest raw text value printed in the device details.
const MAX_DETAIL_LENGTH = 40;

// Labels of the state codes (Zendure-HA translations), printed after the raw
// value: unknown codes show raw only.
const ON_OFF = { 0: 'off', 1: 'on' };
const STATE_LABELS = {
  heatState: ON_OFF,
  hemsState: ON_OFF,
  wifiState: { 0: 'disconnected', 1: 'connected' },
  localState: ON_OFF,
  lowTemperature: { 0: 'no', 1: 'yes' },
  socStatus: { 0: 'operation', 1: 'calibrating' },
  socLimit: { 0: 'normal', 1: 'limiting', 2: 'full' },
  pass: { 0: 'off', 1: 'on', 2: 'on', 3: 'grid direct supply' },
};

/** A raw detail value, bounded. */
function rawText(value) {
  const text = String(value);
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

/**
 * A firmware version as Zendure-HA shows it: the integer packs
 * major.minor.patch in 4/4/8 bits (`4101` -> `v1.0.5`), kept raw otherwise.
 * @param {number|string} value reported version
 * @returns {string}
 */
export function formatFirmwareVersion(value) {
  const number = Number(value);
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    return rawText(value);
  }
  if (!Number.isInteger(number)) {
    return rawText(value);
  }
  if (number <= 0) {
    return `${number} (not provided)`;
  }
  if (number <= 10) {
    return String(number);
  }
  return `v${(number & 0xf000) >> 12}.${(number & 0x0f00) >> 8}.${number & 0x00ff} (${number})`;
}

/** `raw (label)` for a state code. */
function describeState(key, value) {
  const label = STATE_LABELS[key]?.[value];
  return `${key} ${rawText(value)}${label ? ` (${label})` : ''}`;
}

/** A Celsius line part from a decikelvin value: `28.2 °C (3013)`, raw if absurd. */
function describeTemperature(raw) {
  const celsius = decikelvinToCelsius(Number(raw));
  return celsius === null ? `${rawText(raw)} (out of range)` : `${celsius} °C (${raw})`;
}

/** Signed int16 battery current, tenths of an ampere -> A. */
export function packCurrentAmperes(raw) {
  const number = Number(raw);
  if (!Number.isInteger(number)) {
    return null;
  }
  const signed = number >= 0x8000 && number <= 0xffff ? number - 0x10000 : number;
  return signed / 10;
}

function firmwareLine(firmware) {
  const parts = Object.entries(firmware || {}).map(
    ([key, value]) => `${key} ${formatFirmwareVersion(value)}`,
  );
  return `Firmware: ${parts.length ? parts.join(', ') : 'not reported'}`;
}

function networkLine(network) {
  const parts = [];
  for (const [key, value] of Object.entries(network || {})) {
    if (key === 'rssi') {
      const weak = Number(value) < WEAK_RSSI_DBM;
      parts.push(
        `rssi ${rawText(value)} dBm${weak ? ` (WEAK signal, below ${WEAK_RSSI_DBM} dBm: bring the Wi-Fi access point closer)` : ''}`,
      );
    } else {
      parts.push(describeState(key, value));
    }
  }
  return `Network: ${parts.length ? parts.join(', ') : 'not reported'}`;
}

function statesLine(states) {
  const parts = Object.entries(states || {}).map(([key, value]) =>
    key === 'hyperTmp' ? `hyperTmp ${describeTemperature(value)}` : describeState(key, value),
  );
  return `States: ${parts.length ? parts.join(', ') : 'not reported'}`;
}

function packDetailLines(packs, redactor) {
  const lines = [];
  (packs || []).slice(0, 10).forEach((pack, index) => {
    const details = pack.details || {};
    const parts = [];
    if (details.socLevel !== undefined) {
      parts.push(`socLevel ${rawText(details.socLevel)} %`);
    }
    if (details.maxTemp !== undefined) {
      parts.push(`maxTemp ${describeTemperature(details.maxTemp)}`);
    }
    if (details.totalVol !== undefined) {
      const volts = Number(details.totalVol);
      parts.push(
        `totalVol ${Number.isFinite(volts) ? `${Math.round(volts) / 100} V` : rawText(details.totalVol)}`,
      );
    }
    if (details.batcur !== undefined) {
      const amperes = packCurrentAmperes(details.batcur);
      parts.push(`batcur ${amperes === null ? rawText(details.batcur) : `${amperes} A`}`);
    }
    if (details.soh !== undefined) {
      const soh = Number(details.soh);
      parts.push(`soh ${Number.isFinite(soh) ? `${soh / 10} %` : rawText(details.soh)}`);
    }
    if (details.softVersion !== undefined) {
      parts.push(`softVersion ${formatFirmwareVersion(details.softVersion)}`);
    }
    if (parts.length) {
      lines.push(`  Pack #${index + 1} ${redactor.id(pack.sn)}: ${parts.join(', ')}`);
    }
  });
  if ((packs || []).length > 10) {
    lines.push(`  ... ${packs.length - 10} more pack(s)`);
  }
  return lines;
}

function deviceLines(device, snapshot, redactor) {
  const now = snapshot.generatedAt;
  const lines = [`--- ${device.name} ---`];
  lines.push(`Model: ${device.model}`);
  lines.push(
    `Serial: ${redactor.id(device.serial)}   Device key: ${redactor.id(device.deviceKey)}`,
  );
  lines.push(`Online (cloud device list): ${yesNo(device.online)}`);
  let source = `Telemetry source: ${SOURCE_LABELS[device.source] || device.source}`;
  if (device.sourceSince) {
    source += ` (since ${formatAge(device.sourceSince, now).replace(' ago', '')})`;
  } else if (!device.sourceTracked) {
    source += ' (initial choice, not re-assessed yet)';
  }
  if (device.degraded) {
    source += ` - DEGRADED: ${device.degradedReason}`;
  }
  lines.push(source);
  lines.push(
    `Last data: local http ${formatAge(device.lastDataAt.http, now)} | ` +
      `local mqtt ${formatAge(device.lastDataAt.local, now)} | cloud ${formatAge(device.lastDataAt.cloud, now)}`,
  );
  lines.push(`Local API: ${describeLocalHttp(device.localHttp, redactor, now)}`);
  const mqtt = device.localMqtt;
  lines.push(
    `Local MQTT: ${
      mqtt.configured
        ? `broker ${redactor.url(mqtt.brokerUrl)}, ${mqtt.connected === null ? 'no runtime' : mqtt.connected ? 'connected' : 'disconnected'}`
        : `not used (${snapshot.config.enableLocalMqtt ? 'no broker advertised by the cloud' : `option off${mqtt.advertised ? ', a broker is advertised' : ''}`})`
    }`,
  );
  lines.push(`Battery: ${describeBattery(device.battery, redactor)}`);
  lines.push(...packDetailLines(device.battery.packs, redactor));
  lines.push(firmwareLine(device.firmware));
  lines.push(networkLine(device.network));
  lines.push(statesLine(device.states));
  lines.push(
    `Solar input: model ${device.solar.modelHasInput ? 'has one' : 'has none (AC-coupled)'}, ` +
      `current ${show(device.solar.power, ' W')}${device.solar.hasSolar ? '' : ' (hidden in the widgets)'}`,
  );
  const powers = Object.entries(device.powers)
    .map(([key, value]) => `${key} ${show(value)}`)
    .join(', ');
  lines.push(`Values: ${powers || '-'}`);
  lines.push(`Settings: ${describeSettings(device.settings)}`);
  lines.push(`Remaining time: ${describeRemaining(device.remaining)}`);
  lines.push(
    `Energy counters: ${
      device.energy
        ? Object.entries(device.energy)
            .map(([key, kwh]) => `${key} ${kwh} kWh`)
            .join(', ') || 'none yet'
        : 'not loaded yet'
    }`,
  );
  return lines;
}

function cloudBrokerLines(snapshot, redactor) {
  const lines = [];
  const cloudBroker = snapshot.cloudBroker;
  const brokers = snapshot.brokers;
  const cloud = brokers.find((broker) => broker.kind === 'cloud');
  if (!cloud) {
    if (cloudBroker.allLocal) {
      lines.push(
        'Cloud MQTT: not connected - idle, every battery is served locally ' +
          "(the account's single cloud session is left to other consumers, e.g. Home Assistant)",
      );
    } else {
      lines.push(
        `Cloud MQTT: not connected${cloudBroker.needing.length ? ` (needed by: ${cloudBroker.needing.join(', ')})` : ''}`,
      );
    }
  } else {
    let text = `Cloud MQTT ${redactor.url(cloud.url)}: ${brokerSummary(cloud)}`;
    if (cloudBroker.needing.length > 0) {
      text += `; serving: ${cloudBroker.needing.join(', ')}`;
    } else if (cloudBroker.lastNeededAt) {
      text +=
        `; no battery needs it now, kept ${Math.round(cloudBroker.holdMs / 60000)} min after ` +
        `the last need (${formatAge(cloudBroker.lastNeededAt, snapshot.generatedAt)})`;
    }
    lines.push(text);
    if (cloud.takeOverWarned) {
      lines.push(
        '  WARNING: the cloud session keeps being taken over: another consumer of the same ' +
          'Zendure account (Home Assistant, a second Gladys...) uses it. Zendure allows one.',
      );
    }
  }
  for (const broker of brokers.filter((b) => b.kind === 'local')) {
    lines.push(`Local MQTT ${redactor.url(broker.url)}: ${brokerSummary(broker)}`);
    if (broker.takeOverWarned) {
      lines.push('  WARNING: the session on this broker keeps being taken over.');
    }
  }
  return lines;
}

function brokerSummary(broker) {
  return (
    `${broker.connected ? 'connected' : 'DISCONNECTED'}, ` +
    `${broker.reconnectsInWindow === null ? '?' : broker.reconnectsInWindow} (re)connection(s) in the last 5 min ` +
    `(${broker.connectCount} in total), ${broker.trackedDevices} device(s), ` +
    `${broker.messagesReceived} message(s) received`
  );
}

/**
 * Build the fleet diagnostic text from a describeDiagnostics() snapshot.
 * @param {object} snapshot see describeDiagnostics in src/devices/solarflow.js
 * @param {{ includeIdentifiers?: boolean, maxLength?: number }} [options]
 * @returns {string}
 */
export function buildFleetDiagnostic(
  snapshot,
  { includeIdentifiers = false, maxLength = MAX_REPORT_LENGTH } = {},
) {
  const now = snapshot.generatedAt;
  const redactor = createRedactor({
    includeIdentifiers,
    secrets: snapshot.secrets,
    ...sensitiveValuesOf(snapshot),
  });
  const cfg = snapshot.config;
  const lines = headerLines('Zendure integration diagnostic', now, redactor);

  lines.push('', '== Configuration ==');
  lines.push(`Cloud key: ${cfg.cloudKeySet ? 'set' : 'MISSING'}`);
  lines.push(
    `Refresh interval: ${cfg.pollFrequency} s (Gladys polls every ${cfg.gladysPollFrequencyMs / 1000} s)`,
  );
  lines.push(`Use the local API of the batteries: ${cfg.enableLocalHttp ? 'on' : 'off'}`);
  lines.push(
    `Local API addresses: ${cfg.addressOverrides.count} pair(s), ${cfg.addressOverrides.invalid} invalid` +
      (cfg.addressOverrides.unmatched.length
        ? `, matching no battery: ${cfg.addressOverrides.unmatched.map(redactor.id).join(', ')}`
        : ''),
  );
  lines.push(`Local MQTT: ${cfg.enableLocalMqtt ? 'on' : 'off'}`);
  lines.push(`Feature names: ${cfg.featureNames}`);
  if (cfg.savings) {
    const savings = cfg.savings;
    lines.push(
      `Savings estimate: ${savings.mode}` +
        (savings.mode === 'none'
          ? ''
          : `, timezone ${savings.timeZone}` +
            (savings.mode === 'peak_offpeak'
              ? `, ${savings.offpeakRanges} off-peak range(s)`
              : '') +
            `, resale ${savings.resaleEnabled ? 'on' : 'off'}` +
            (savings.error ? ` — IGNORED: ${savings.error}` : '') +
            (savings.warning ? ` (${savings.warning})` : '')),
    );
  }

  lines.push('', '== Zendure cloud API ==');
  const cloud = snapshot.cloud;
  const lastRequest = cloud.lastFetchAt
    ? `last request ${formatAge(cloud.lastFetchAt, now)}: ${cloud.lastFetchError ? `FAILED (${cloud.lastFetchError})` : 'OK'}`
    : 'no request yet';
  lines.push(
    cloud.loaded
      ? `Device list: loaded, ${cloud.deviceCount} device(s), ${cloud.supportedCount} supported; ${lastRequest}`
      : `Device list: NOT loaded; ${lastRequest}`,
  );
  if (cloud.unsupportedModels.length > 0) {
    lines.push(
      `Unsupported models: ${cloud.unsupportedModels.map((m) => JSON.stringify(m)).join(', ')}`,
    );
  }

  lines.push('', '== Brokers ==');
  lines.push(...cloudBrokerLines(snapshot, redactor));

  lines.push('', '== Local API runtime ==');
  const http = snapshot.localHttp;
  lines.push(
    http
      ? `Polling: ${http.running ? 'running' : 'stopped'}` +
          `${http.startedAt ? ` (started ${formatAge(http.startedAt, now)})` : ''}, ` +
          `${http.trackedDevices} device(s), ${http.devicesUp} answering, ` +
          `${http.requests} request(s), ${http.failures} failure(s) since the start`
      : 'Not running (option off, no battery with a local API, or not started yet)',
  );

  lines.push('');
  const ignored = snapshot.ignored || [];
  if (ignored.length > 0) {
    // Listed once, not diagnosed: nothing follows them until they are created
    // again from the Discover tab.
    lines.push(
      `Ignored (deleted in Gladys): ${ignored.length} battery(ies): ` +
        ignored
          .map(({ name, id }) => (name ? `${name} (${redactor.id(id)})` : redactor.id(id)))
          .join(', ') +
        ' - create it again from the Discover tab to track it again',
      '',
    );
  }
  if (snapshot.filter && snapshot.devices.length === 0) {
    lines.push(
      `== Batteries: none matches "${snapshot.filter}" ==`,
      `Batteries of the account: ${snapshot.availableNames.join(', ') || 'none'}`,
    );
  } else {
    lines.push(
      `== Batteries (${snapshot.devices.length}${snapshot.filter ? ` matching "${snapshot.filter}"` : ''}) ==`,
    );
    for (const device of snapshot.devices) {
      lines.push(...deviceLines(device, snapshot, redactor));
    }
  }

  return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
}

/** One property value, printable and bounded. */
function formatPropertyValue(key, value, redactor) {
  if (SECRET_KEY.test(key)) {
    return REDACTED;
  }
  let text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'null');
  if (IDENTIFIER_KEY.test(key) && typeof value === 'string') {
    text = JSON.stringify(redactor.masked ? maskIdentifier(value) : value);
  }
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}… (${text.length} chars)`
    : text;
}

/** Hint for a failed local API test, from its error code and address. */
export function hintForLocalApiError(errorCode, address) {
  const isMdns = /\.local$/i.test(String(address?.host || ''));
  switch (errorCode) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return isMdns
        ? 'The mDNS name does not resolve inside the container (common with Docker): ' +
            'give the battery its IP address in the "Local API addresses" option, as SERIAL=IP.'
        : 'The host name does not resolve: check the address in the "Local API addresses" option.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return (
        'The battery is not reachable from the Gladys host: check that it is on the same network ' +
        '(no VLAN, guest Wi-Fi or firewall in between) and that its IP address did not change ' +
        '(a DHCP reservation helps).'
      );
    case 'ECONNREFUSED':
      return (
        'The address answers but nothing listens on port 80: wrong address (another device), ' +
        'or a firmware without the local API (update it in the Zendure app).'
      );
    case 'ECONNRESET':
      return 'The connection was cut: unstable Wi-Fi or firmware issue, retry in a minute.';
    case 'TIMEOUT':
      return (
        'No answer in time: the battery may be on weak Wi-Fi, asleep, behind a firewall, ' +
        'or the address is wrong (nothing at it).'
      );
    case 'HTTP_404':
      return (
        'A web server answered but without the zenSDK API: wrong address, or a firmware ' +
        'without the local API (update it in the Zendure app).'
      );
    case 'INVALID_JSON':
    case 'NO_PROPERTIES':
      return 'Something answered, but not a zenSDK report: check that the address is the battery.';
    case 'INVALID_ADDRESS':
      return 'The address is not a valid IP address or host name: fix it in "Local API addresses".';
    default:
      return String(errorCode || '').startsWith('HTTP_')
        ? 'The local API refused the request: restart the battery, or update its firmware.'
        : 'Unexpected error: please report it with this text.';
  }
}

function packLines(packs, redactor) {
  const lines = [`packData: ${packs.length} pack(s)`];
  packs.slice(0, 10).forEach((pack, index) => {
    const fields = Object.keys(pack || {})
      .sort()
      .filter((key) => key !== 'sn')
      .map((key) => `${key}=${formatPropertyValue(key, pack[key], redactor)}`)
      .join(' ');
    const summary = fields.length > 200 ? `${fields.slice(0, 200)}…` : fields;
    lines.push(`  #${index + 1} sn ${redactor.id(pack?.sn)}${summary ? ` ${summary}` : ''}`);
  });
  if (packs.length > 10) {
    lines.push(`  ... ${packs.length - 10} more pack(s)`);
  }
  return lines;
}

/**
 * Build the local API test text from a testLocalApi() outcome.
 * @param {object} outcome see testLocalApi in src/devices/solarflow.js
 * @param {{ includeIdentifiers?: boolean, now?: number, maxLength?: number }} [options]
 * @returns {string}
 */
export function buildLocalApiTestReport(
  outcome,
  { includeIdentifiers = false, now = Date.now(), maxLength = MAX_REPORT_LENGTH } = {},
) {
  const packs = outcome.result?.body?.packData ?? outcome.result?.body?.properties?.packData;
  const redactor = createRedactor({
    includeIdentifiers,
    secrets: outcome.secrets,
    identifiers: [
      outcome.device?.serial,
      outcome.device?.deviceKey,
      outcome.result?.body?.sn,
      ...(Array.isArray(packs) ? packs.map((pack) => pack?.sn) : []),
    ],
    hosts: [outcome.address?.host],
  });
  const lines = headerLines('Zendure local API test', now, redactor);
  lines.push('');

  if (outcome.cloudError) {
    lines.push(`Zendure cloud device list unavailable: ${outcome.cloudError}`);
    lines.push('The battery address comes from it: fix the cloud key first.');
    return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
  }
  if (!outcome.found) {
    lines.push(
      outcome.ambiguous.length > 1
        ? `"${outcome.reference}" matches several batteries: ${outcome.ambiguous.join(', ')}. Type the exact name or the serial number.`
        : `No battery matches "${outcome.reference}".`,
    );
    lines.push(`Batteries of the account: ${outcome.availableNames.join(', ') || 'none'}`);
    return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
  }

  const { device, address, result } = outcome;
  lines.push(`Battery: ${device.name} (${device.model}), serial ${redactor.id(device.serial)}`);
  lines.push(
    `Option "Use the local API of the batteries": ${outcome.optionEnabled ? 'on' : 'off'}`,
  );
  if (!outcome.modelHasZenSdk) {
    lines.push('This model has no zenSDK local API: it is served by MQTT (local or cloud).');
    return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
  }
  if (!address) {
    lines.push('No serial number in the cloud device list: no address to try.');
    return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
  }
  lines.push(
    `Address: ${redactor.host(address.host)} (${ORIGIN_LABELS[address.origin] || address.origin})`,
  );
  lines.push(
    `Request: GET http://${redactor.host(address.host)}/properties/report ` +
      (outcome.viaRuntime
        ? '(through the polling runtime, never two requests at once)'
        : '(direct: this battery is not polled right now)') +
      '. Read-only: nothing is written to the battery.',
  );

  if (!result.ok) {
    lines.push(`Result: FAILED - ${result.error} after ${result.durationMs} ms`);
    lines.push(`Hint: ${hintForLocalApiError(result.errorCode, address)}`);
    return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
  }

  lines.push(`Result: OK - HTTP ${result.status} in ${result.durationMs} ms`);
  if (result.durationMs > ZENSDK_REQUEST_TIMEOUT_IN_MS) {
    lines.push(
      `Note: slower than the ${ZENSDK_REQUEST_TIMEOUT_IN_MS / 1000} s timeout of the polling, ` +
        'which then sees the battery as not answering (weak Wi-Fi?).',
    );
  }
  const properties = result.body.properties;
  const keys = Object.keys(properties).sort();
  lines.push('', `Properties (${keys.length}):`);
  for (const key of keys.slice(0, MAX_LISTED_PROPERTIES)) {
    lines.push(`  ${key} = ${formatPropertyValue(key, properties[key], redactor)}`);
  }
  if (keys.length > MAX_LISTED_PROPERTIES) {
    lines.push(`  ... ${keys.length - MAX_LISTED_PROPERTIES} more`);
  }
  if (Array.isArray(packs)) {
    lines.push('', ...packLines(packs, redactor));
  } else {
    lines.push('', 'packData: absent');
  }
  const others = Object.keys(result.body)
    .filter((key) => key !== 'properties' && key !== 'packData')
    .sort();
  if (others.length > 0) {
    lines.push(
      '',
      `Other fields: ${others.map((key) => `${key}=${formatPropertyValue(key, result.body[key], redactor)}`).join(', ')}`,
    );
  }
  return truncateReport(redactor.scrub(lines.join('\n')), maxLength);
}
