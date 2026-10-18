// -----------------------------------------------------------------------------
// Savings ESTIMATE, without a grid meter.
//
// The integration knows what each battery charged, discharged, received from
// the solar panels, took from the grid (AC charging) and sent to the home,
// per 30-minute slot (src/zendure/energy.js). With the user's electricity
// tariff it values that energy:
//
// - price(slot): the base price, or the peak / off-peak price of the slot in
//   the tariff timezone (a slot straddling a range edge is pro rata).
// - Stored energy carries its acquisition cost, a weighted average per
//   device: grid-charged kWh at price(slot), solar-charged kWh at their
//   opportunity value (the resale price when resale is on, else 0).
// - The home output of the slot is assumed consumed by the house (without a
//   grid meter nothing tells what was exported): its discharge share gains
//   price(slot) - average stored cost, its direct solar share gains
//   price(slot), the rest (grid passing through an AC battery) gains nothing.
// - Exported energy (resale revenue, or "loss" when resale is off) needs the
//   grid meter: the accumulators and the allocation take it already
//   (`exportedKwh`), always 0 today, so the meter-based allocation slots in
//   without a file format change.
//
// Savings = battery time-shift gain + direct solar gain + resale revenue. The
// grid charging cost is shown for information: it is already inside the
// stored cost the battery gain subtracts.
//
// Totals accumulate per calendar day, month and year of the tariff timezone
// (current and previous of each), saved in energy.json with the meters.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'savings' });

export const TARIFF_MODES = { NONE: 'none', BASE: 'base', PEAK_OFFPEAK: 'peak_offpeak' };
export const DEFAULT_TARIFF_TIMEZONE = 'Europe/Paris';

const MINUTES_PER_DAY = 24 * 60;
const SLOT_MINUTES = 30;

// Energy index keys (src/zendure/energy.js ENERGY_FLOWS values) the savings
// read, by role.
export const SAVINGS_FLOWS = {
  charge: 'batteryChargeEnergy',
  discharge: 'batteryDischargeEnergy',
  solar: 'solarEnergy',
  home: 'homeOutputEnergy',
  gridInput: 'gridInputEnergy',
};

// Fields of one accumulator (money in the tariff currency, energy in kWh).
// Saved by name: a field added later loads at 0 from an older file.
export const SAVINGS_FIELDS = [
  'savings', // batteryGain + solarGain + resaleRevenue
  'batteryGain', // discharge share x (price - stored cost)
  'solarGain', // direct solar share x price
  'gridCost', // grid-charged kWh x price (information, inside batteryGain)
  'resaleRevenue', // exported kWh x resale price (grid meter, coming)
  'batteryKwh', // discharge share of the home output
  'solarKwh', // direct solar share of the home output
  'gridChargedKwh',
  'solarChargedKwh',
  'exportedKwh', // grid meter, coming: 0 today
  'lossKwh', // exported without resale: grid meter, coming: 0 today
];

export const PERIODS = ['day', 'month', 'year'];
// Accumulators kept per period: the current one and the previous one.
export const PERIOD_HISTORY = 2;

// --- Off-peak hours --------------------------------------------------------------

function minuteOf(hours, minutes) {
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Parse off-peak hours: `HH:MM-HH:MM` ranges separated by commas (or
 * semicolons), a range ending before it starts crossing midnight, `24:00`
 * accepted as an end.
 * @param {unknown} text e.g. "22:00-06:00" or "01:30-07:30,12:30-14:30"
 * @returns {{ ranges: Array<{ start: number, end: number }> } | { error: string }} minutes of the day
 */
export function parseOffpeakHours(text) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') {
    return { error: 'no off-peak hours' };
  }
  const ranges = [];
  for (const raw of source.split(/[,;]/)) {
    const part = raw.trim();
    const match = part.match(/^(\d{1,2})[:h](\d{2})\s*-\s*(\d{1,2})[:h](\d{2})$/i);
    if (!match) {
      return { error: `"${part}" is not a HH:MM-HH:MM range` };
    }
    const [h1, m1, h2, m2] = match.slice(1).map(Number);
    const start = minuteOf(h1, m1);
    const end = minuteOf(h2, m2);
    if (start === null || end === null) {
      return { error: `"${part}" is not a valid time range` };
    }
    if (start % MINUTES_PER_DAY === end % MINUTES_PER_DAY) {
      return { error: `"${part}" is empty` };
    }
    ranges.push({ start: start % MINUTES_PER_DAY, end });
  }
  return { ranges };
}

/** One flag per minute of the day: off-peak or not (overlaps merge). */
function offpeakMask(ranges) {
  const mask = new Uint8Array(MINUTES_PER_DAY);
  for (const { start, end } of ranges) {
    if (end > start) {
      mask.fill(1, start, end);
    } else {
      mask.fill(1, start, MINUTES_PER_DAY);
      mask.fill(1, 0, end);
    }
  }
  return mask;
}

// --- Local calendar of a timezone ---------------------------------------------------

const formatters = new Map();

function formatterOf(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }),
    );
  }
  return formatters.get(timeZone);
}

/** Wall-clock parts of an instant in a timezone. */
export function localParts(at, timeZone) {
  return Object.fromEntries(
    formatterOf(timeZone)
      .formatToParts(new Date(at))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

/** A known IANA timezone name, or null. */
export function validTimezone(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (value === '') {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const pad = (value) => String(value).padStart(2, '0');

/**
 * Calendar keys of an instant in a timezone (sortable as text).
 * @returns {{ day: string, month: string, year: string }}
 */
export function periodKeysOf(at, timeZone) {
  const { year, month, day } = localParts(at, timeZone);
  return {
    day: `${year}-${pad(month)}-${pad(day)}`,
    month: `${year}-${pad(month)}`,
    year: `${year}`,
  };
}

/** Calendar keys of the day, month and year before the ones of an instant. */
export function previousPeriodKeysOf(at, timeZone) {
  const { year, month, day } = localParts(at, timeZone);
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  return {
    day: `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth() + 1)}-${pad(yesterday.getUTCDate())}`,
    month: month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`,
    year: `${year - 1}`,
  };
}

// --- Tariff ------------------------------------------------------------------------

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The tariff of a normalized configuration (src/config.js), or the reason it
 * cannot be used. `null` tariff: no estimate (mode none, or invalid).
 * @param {object} config normalized configuration
 * @returns {{ tariff: object|null, error: string|null, warning: string|null }}
 */
export function buildTariff(config = {}) {
  const mode = config.tariff_mode;
  if (mode !== TARIFF_MODES.BASE && mode !== TARIFF_MODES.PEAK_OFFPEAK) {
    return { tariff: null, error: null, warning: null };
  }
  let warning = null;
  let timeZone = validTimezone(config.tariff_timezone);
  if (!timeZone) {
    warning = `unknown tariff timezone "${config.tariff_timezone}", ${DEFAULT_TARIFF_TIMEZONE} used`;
    timeZone = DEFAULT_TARIFF_TIMEZONE;
  }
  const resaleEnabled = config.resale_enabled === true;
  const resalePrice = finite(config.resale_price);
  if (resaleEnabled && (resalePrice === null || resalePrice < 0)) {
    return { tariff: null, error: 'the resale price must be a number >= 0', warning };
  }
  const opportunityPrice = resaleEnabled ? resalePrice : 0;
  const common = { mode, timeZone, resaleEnabled, resalePrice: resaleEnabled ? resalePrice : 0 };

  if (mode === TARIFF_MODES.BASE) {
    const price = finite(config.price_base);
    if (price === null || price <= 0) {
      return { tariff: null, error: 'the base price must be a number > 0', warning };
    }
    return {
      tariff: { ...common, opportunityPrice, priceAt: () => price },
      error: null,
      warning,
    };
  }

  const peak = finite(config.price_peak);
  const offpeak = finite(config.price_offpeak);
  if (peak === null || peak <= 0 || offpeak === null || offpeak < 0) {
    return {
      tariff: null,
      error: 'the peak price must be a number > 0 and the off-peak price >= 0',
      warning,
    };
  }
  const parsed = parseOffpeakHours(config.offpeak_hours);
  if (parsed.error) {
    return { tariff: null, error: `invalid off-peak hours: ${parsed.error}`, warning };
  }
  const mask = offpeakMask(parsed.ranges);
  return {
    tariff: {
      ...common,
      opportunityPrice,
      offpeakRanges: parsed.ranges,
      /** Off-peak share (0..1) of the 30-minute slot starting at `slotAt`. */
      offpeakShareAt(slotAt) {
        // Clock changes fall on slot boundaries (whole- or half-hour UTC
        // instants), so the local clock runs straight through a slot.
        const { hour, minute } = localParts(slotAt, timeZone);
        const first = hour * 60 + minute;
        let count = 0;
        for (let i = 0; i < SLOT_MINUTES; i += 1) {
          count += mask[(first + i) % MINUTES_PER_DAY];
        }
        return count / SLOT_MINUTES;
      },
      priceAt(slotAt) {
        const share = this.offpeakShareAt(slotAt);
        return peak + share * (offpeak - peak);
      },
    },
    error: null,
    warning,
  };
}

// Each distinct tariff problem is logged once (the tariff is rebuilt at
// every config update and widget render).
const reportedProblems = new Set();
let lastTariff = { key: null, value: null };

/**
 * buildTariff, memoized on the tariff fields, logging each problem once.
 * @param {object} config normalized configuration
 */
export function tariffFromConfig(config = {}) {
  const key = JSON.stringify([
    config.tariff_mode,
    config.price_base,
    config.price_peak,
    config.price_offpeak,
    config.offpeak_hours,
    config.resale_enabled,
    config.resale_price,
    config.tariff_timezone,
  ]);
  if (lastTariff.key !== key) {
    lastTariff = { key, value: buildTariff(config) };
    for (const problem of [lastTariff.value.error, lastTariff.value.warning]) {
      if (problem && !reportedProblems.has(problem)) {
        reportedProblems.add(problem);
        logger.warn(
          `savings estimate: ${problem}${problem === lastTariff.value.error ? ', tariff ignored' : ''}`,
        );
      }
    }
  }
  return lastTariff.value;
}

// --- Allocation of one slot --------------------------------------------------------

export const emptyAccumulator = () => Object.fromEntries(SAVINGS_FIELDS.map((field) => [field, 0]));

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Value the energy of one 30-minute slot of one device.
 * @param {{ charge: number, discharge: number, solar: number, home: number, gridInput: number }} delta kWh of the slot
 * @param {{ price: number, opportunityPrice: number, resaleEnabled: boolean, resalePrice: number }} prices
 * @param {{ kwh: number, cost: number }} stock stored energy and its average cost before the slot
 * @param {number} [exportedKwh] energy of the home output known exported (grid meter, coming)
 * @returns {{ gains: Record<string, number>, stock: { kwh: number, cost: number } }}
 */
export function allocateSlot(delta, prices, stock, exportedKwh = 0) {
  const charge = positive(delta.charge);
  const discharge = positive(delta.discharge);
  const solar = positive(delta.solar);
  const home = positive(delta.home);
  const { price, opportunityPrice, resaleEnabled, resalePrice } = prices;

  // Charging: from the grid first (AC input, bounded by the charge), the rest
  // from the solar panels.
  const gridCharged = Math.min(positive(delta.gridInput), charge);
  const solarCharged = charge - gridCharged;
  const stockBefore = positive(stock.kwh);
  const cost =
    stockBefore + charge > 0
      ? (stockBefore * stock.cost + gridCharged * price + solarCharged * opportunityPrice) /
        (stockBefore + charge)
      : stock.cost;

  // The home output: exported share (known with the grid meter only), then
  // the discharge, then the solar not used for charging; what remains passed
  // through from the grid.
  const exported = Math.min(positive(exportedKwh), home);
  const consumed = home - exported;
  const batteryKwh = Math.min(discharge, consumed);
  const solarKwh = Math.min(consumed - batteryKwh, Math.max(0, solar - solarCharged));

  const batteryGain = batteryKwh * (price - cost);
  const solarGain = solarKwh * price;
  const resaleRevenue = resaleEnabled ? exported * resalePrice : 0;
  return {
    gains: {
      savings: batteryGain + solarGain + resaleRevenue,
      batteryGain,
      solarGain,
      gridCost: gridCharged * price,
      resaleRevenue,
      batteryKwh,
      solarKwh,
      gridChargedKwh: gridCharged,
      solarChargedKwh: solarCharged,
      exportedKwh: exported,
      lossKwh: resaleEnabled ? 0 : exported,
    },
    stock: { kwh: Math.max(0, stockBefore + charge - discharge), cost },
  };
}

// --- Per-device state ------------------------------------------------------------------

/**
 * Savings state of one device: the totals at the start of the open slot
 * (`mark`), the stored energy and its average cost, the period accumulators.
 */
export function createSavingsState() {
  return { mark: null, stock: null, periods: { day: [], month: [], year: [] } };
}

function addTo(list, key, gains) {
  let entry = list.find((candidate) => candidate.key === key);
  if (!entry) {
    entry = { key, ...emptyAccumulator() };
    list.push(entry);
    // Newest first, the older ones dropped.
    list.sort((a, b) => (a.key < b.key ? 1 : -1));
    list.splice(PERIOD_HISTORY);
    if (!list.includes(entry)) {
      return; // older than everything kept
    }
  }
  for (const field of SAVINGS_FIELDS) {
    entry[field] += gains[field];
  }
}

const flowsOf = (totals) =>
  Object.fromEntries(
    Object.entries(SAVINGS_FLOWS).map(([role, key]) => [role, finite(totals?.[key]) ?? 0]),
  );

/** Value the energy since the mark (the slot starting at mark.at). */
function valueSinceMark(state, totals, tariff, storedKwh) {
  const now = flowsOf(totals);
  const delta = Object.fromEntries(
    Object.keys(SAVINGS_FLOWS).map((role) => [role, Math.max(0, now[role] - state.mark.kwh[role])]),
  );
  const stock = state.stock ?? { kwh: positive(storedKwh), cost: tariff.opportunityPrice };
  const result = allocateSlot(
    delta,
    {
      price: tariff.priceAt(state.mark.at),
      opportunityPrice: tariff.opportunityPrice,
      resaleEnabled: tariff.resaleEnabled,
      resalePrice: tariff.resalePrice,
    },
    stock,
  );
  // The measured stored energy (state of charge x capacity), when known,
  // corrects the drift of the counted one (pack losses, missed reports).
  state.stock = Number.isFinite(storedKwh) ? { ...result.stock, kwh: storedKwh } : result.stock;
  const keys = periodKeysOf(state.mark.at, tariff.timeZone);
  for (const period of PERIODS) {
    addTo(state.periods[period], keys[period], result.gains);
  }
}

/**
 * Close the open slot at a new slot boundary: value its energy (when a
 * tariff is set), then mark the totals at the start of the new slot.
 * @param {ReturnType<typeof createSavingsState>} state mutated
 * @param {Record<string, number>} totals energy index key -> kWh at the boundary
 * @param {number} slotAt start of the new slot (ms)
 * @param {object|null} tariff buildTariff().tariff
 * @param {number|null} [storedKwh] measured stored energy, when known
 */
export function closeSavingsSlot(state, totals, slotAt, tariff, storedKwh = null) {
  if (state.mark && slotAt <= state.mark.at) {
    return;
  }
  if (state.mark && tariff) {
    valueSinceMark(state, totals, tariff, storedKwh);
  }
  state.mark = { at: slotAt, kwh: flowsOf(totals) };
}

/**
 * The savings of a device now: the closed slots plus the open one (valued
 * on a copy, provisionally), for the current and previous day, month, year
 * of the tariff timezone. Null without a tariff.
 * @param {ReturnType<typeof createSavingsState>} state
 * @param {Record<string, number>} totals current totals
 * @param {number} now timestamp (ms)
 * @param {object|null} tariff
 * @param {number|null} [storedKwh]
 */
export function savingsReport(state, totals, now, tariff, storedKwh = null) {
  if (!tariff) {
    return null;
  }
  const view = structuredClone(state);
  if (view.mark) {
    valueSinceMark(view, totals, tariff, storedKwh);
  }
  const current = periodKeysOf(now, tariff.timeZone);
  const previous = previousPeriodKeysOf(now, tariff.timeZone);
  const pick = (period, key) => {
    const entry = view.periods[period].find((candidate) => candidate.key === key);
    return entry
      ? Object.fromEntries(SAVINGS_FIELDS.map((f) => [f, entry[f]]))
      : emptyAccumulator();
  };
  return {
    today: pick('day', current.day),
    month: pick('month', current.month),
    year: pick('year', current.year),
    yesterday: pick('day', previous.day),
    previousMonth: pick('month', previous.month),
    previousYear: pick('year', previous.year),
    storedCost: view.stock ? view.stock.cost : null,
  };
}

/** Sum of accumulators (a site, a phase). */
export function sumAccumulators(list) {
  const total = emptyAccumulator();
  for (const accumulator of list) {
    for (const field of SAVINGS_FIELDS) {
      total[field] += accumulator[field];
    }
  }
  return total;
}

// --- Persistence (energy.json, `savings` of each device) ---------------------------

/** The JSON form of a state (plain, field names kept). */
export function serializeSavings(state) {
  return {
    mark: state.mark,
    stock: state.stock,
    periods: state.periods,
  };
}

/**
 * A state read back from energy.json: missing (a 1.7.0 file), partial or
 * unknown fields tolerated.
 * @param {unknown} saved
 */
export function deserializeSavings(saved) {
  const state = createSavingsState();
  if (!saved || typeof saved !== 'object') {
    return state;
  }
  if (saved.mark && Number.isFinite(saved.mark.at) && saved.mark.kwh) {
    state.mark = {
      at: saved.mark.at,
      kwh: Object.fromEntries(
        Object.keys(SAVINGS_FLOWS).map((role) => [role, finite(saved.mark.kwh[role]) ?? 0]),
      ),
    };
  }
  if (saved.stock && Number.isFinite(saved.stock.kwh) && Number.isFinite(saved.stock.cost)) {
    state.stock = { kwh: Math.max(0, saved.stock.kwh), cost: saved.stock.cost };
  }
  for (const period of PERIODS) {
    const list = Array.isArray(saved.periods?.[period]) ? saved.periods[period] : [];
    state.periods[period] = list
      .filter((entry) => entry && typeof entry.key === 'string')
      .map((entry) => ({
        key: entry.key,
        ...Object.fromEntries(SAVINGS_FIELDS.map((f) => [f, finite(entry[f]) ?? 0])),
      }))
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .slice(0, PERIOD_HISTORY);
  }
  return state;
}
