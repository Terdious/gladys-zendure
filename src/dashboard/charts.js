// -----------------------------------------------------------------------------
// Charts of the dashboard widgets, and the order of the battery lists.
//
// The live charts read the 5-minute history the energy meters keep for the
// last day (src/zendure/energy.js historySince): the average power of each
// flow per step and the state of charge at its start. Gladys charts a device
// feature's own history (`device_features`, 4 at most), never a sum: the
// totals of a group or a phase are summed here, as inline series (4 series
// of 300 points at most; a day is 288 steps).
//
// The values of the `chart`, `chart_hours` and `sort` settings are stored in
// the users' dashboards: never rename one.
// -----------------------------------------------------------------------------

import { T, withPacksOf } from './common.js';

// Values of the `chart` setting of the battery_group and site widgets.
export const LIVE_CHARTS = {
  NONE: 'none',
  // The four flows of the batteries summed up (charge, discharge, solar,
  // home), on a three-phase site too.
  POWER: 'power',
  // The home output only (per phase on a three-phase site).
  HOME: 'home',
  // The state of charge (per phase on a three-phase site).
  LEVEL: 'level',
};

// Values of the `chart_hours` setting (a select stores strings).
export const CHART_HOURS = ['3', '6', '12', '24'];
export const DEFAULT_CHART_HOURS = 6;

// Values of the `sort` setting of the battery_group widget.
export const SORTS = {
  // Natural order of the names: "L1.2" before "L1.10", the same on every
  // phase whatever the order the devices were found or picked in.
  NAME: 'name',
  // The order of the widget's own selection, as saved by Gladys.
  SELECTION: 'selection',
  // Highest state of charge first.
  LEVEL: 'level',
  // Highest home output first.
  POWER: 'power',
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Batteries in the order of a `sort` setting (unknown or missing: by name).
 * @param {Array<object>} batteries battery snapshots
 * @param {string} [sort] SORTS value
 * @param {Array<string>} [selection] external ids in the order picked
 * @returns {Array<object>} a sorted copy
 */
export function sortBatteries(batteries, sort, selection = []) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const list = [...batteries];
  if (sort === SORTS.SELECTION && selection.length > 0) {
    const rank = new Map(selection.map((id, index) => [id, index]));
    const at = (battery) => rank.get(battery.externalId) ?? Number.MAX_SAFE_INTEGER;
    return list.sort((a, b) => at(a) - at(b) || byName(a, b));
  }
  if (sort === SORTS.LEVEL || sort === SORTS.POWER) {
    const key = sort === SORTS.LEVEL ? 'batteryLevel' : 'homeOutputPower';
    const value = (battery) => battery.values[key] ?? -1;
    return list.sort((a, b) => value(b) - value(a) || byName(a, b));
  }
  return list.sort(byName);
}

/** The `chart_hours` setting in hours (unknown or missing: the default). */
export function chartHoursOf(settings) {
  const hours = Number(settings?.chart_hours);
  return CHART_HOURS.includes(String(settings?.chart_hours)) ? hours : DEFAULT_CHART_HOURS;
}

/** The `chart` setting, the given default when missing or unknown. */
export function chartOf(settings, fallback) {
  return Object.values(LIVE_CHARTS).includes(settings?.chart) ? settings.chart : fallback;
}

// History flow keys (the energy index keys) of each chart series.
const FLOW_SERIES = [
  { key: 'batteryChargeEnergy', name: T('Charge', 'Charge', 'Laden', 'Carga'), packs: true },
  {
    key: 'batteryDischargeEnergy',
    name: T('Discharge', 'Décharge', 'Entladen', 'Descarga'),
    packs: true,
  },
  { key: 'solarEnergy', name: T('Solar', 'Solaire', 'Solar', 'Solar'), solar: true },
  { key: 'homeOutputEnergy', name: T('Home', 'Maison', 'Haus', 'Hogar') },
];
const HOME_KEY = 'homeOutputEnergy';

/**
 * The live history of some batteries, summed per step: the powers (W) of
 * each flow, from the batteries with a pack for the charge figures, and the
 * state of charge (weighted by the capacities when all are known).
 * @param {Array<object>} batteries battery snapshots
 * @param {number} since timestamp (ms)
 * @returns {Array<{ at: number, watts: Record<string, number>|null, level: number|null }>} in time order
 */
export function historyOf(batteries, since) {
  const packIds = new Set(withPacksOf(batteries).map((battery) => battery.externalId));
  const steps = new Map();
  const stepOf = (at) => {
    if (!steps.has(at)) {
      steps.set(at, { at, watts: null, levels: [] });
    }
    return steps.get(at);
  };
  for (const battery of batteries) {
    for (const entry of battery.historySince?.(since) ?? []) {
      const step = stepOf(entry.at);
      if (entry.watts) {
        step.watts = step.watts ?? Object.fromEntries(FLOW_SERIES.map(({ key }) => [key, 0]));
        for (const { key, packs } of FLOW_SERIES) {
          if (!packs || packIds.has(battery.externalId)) {
            step.watts[key] += entry.watts[key] ?? 0;
          }
        }
      }
      if (packIds.has(battery.externalId) && entry.level !== null) {
        step.levels.push({ level: entry.level, capacity: battery.capacityKwh });
      }
    }
  }
  return [...steps.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ at, watts, levels }) => {
      const weighted = levels.every(({ capacity }) => capacity !== null);
      const weight = ({ capacity }) => (weighted ? capacity : 1);
      const total = levels.reduce((sum, entry) => sum + weight(entry), 0);
      const level =
        total > 0
          ? Math.round(levels.reduce((sum, entry) => sum + entry.level * weight(entry), 0) / total)
          : null;
      return { at, watts, level };
    });
}

const point = (at, v) => ({ t: new Date(at).toISOString(), v });

function wattPoints(history, key) {
  return history.filter((step) => step.watts).map((step) => point(step.at, step.watts[key]));
}

function levelPoints(history) {
  return history.filter((step) => step.level !== null).map((step) => point(step.at, step.level));
}

const TITLES = {
  [LIVE_CHARTS.POWER]: (hours) =>
    T(
      `Powers, last ${hours} h`,
      `Puissances, dernières ${hours} h`,
      `Leistungen, letzte ${hours} h`,
      `Potencias, últimas ${hours} h`,
    ),
  [LIVE_CHARTS.HOME]: (hours) =>
    T(
      `To the home, last ${hours} h`,
      `Vers la maison, dernières ${hours} h`,
      `Zum Haus, letzte ${hours} h`,
      `Al hogar, últimas ${hours} h`,
    ),
  [LIVE_CHARTS.LEVEL]: (hours) =>
    T(
      `Charge level, last ${hours} h`,
      `Niveau de charge, dernières ${hours} h`,
      `Ladestand, letzte ${hours} h`,
      `Nivel de carga, últimas ${hours} h`,
    ),
};

/**
 * The live chart component of some batteries, or null (no chart asked, or
 * nothing recorded yet). `power`: the flows the batteries have, summed.
 * `home` and `level`: one series per phase when phases are given, else one.
 * @param {string} chart LIVE_CHARTS value
 * @param {{ batteries: Array<object>, phases?: Array<{ label: string, batteries: Array<object> }>, hours: number, now: number }} options
 * @returns {object|null} chart component
 */
export function liveChart(chart, { batteries, phases = [], hours, now }) {
  if (chart === LIVE_CHARTS.NONE || !TITLES[chart]) {
    return null;
  }
  const since = now - hours * 3600 * 1000;
  const series = [];
  const withPhases =
    chart === LIVE_CHARTS.POWER ? [] : phases.filter((phase) => phase.batteries.length > 0);
  if (withPhases.length > 0) {
    for (const phase of withPhases) {
      const history = historyOf(phase.batteries, since);
      const points =
        chart === LIVE_CHARTS.LEVEL ? levelPoints(history) : wattPoints(history, HOME_KEY);
      if (points.length > 0) {
        series.push({ name: phase.label, points });
      }
    }
  } else {
    const history = historyOf(batteries, since);
    if (chart === LIVE_CHARTS.LEVEL) {
      series.push({
        name: T('Level', 'Niveau', 'Ladestand', 'Nivel'),
        points: levelPoints(history),
      });
    } else if (chart === LIVE_CHARTS.HOME) {
      series.push({ name: FLOW_SERIES[3].name, points: wattPoints(history, HOME_KEY) });
    } else {
      const hasPacks = withPacksOf(batteries).length > 0;
      const hasSolar = batteries.some((battery) => battery.hasSolar);
      for (const flow of FLOW_SERIES) {
        if ((flow.packs && !hasPacks) || (flow.solar && !hasSolar)) {
          continue;
        }
        series.push({ name: flow.name, points: wattPoints(history, flow.key) });
      }
    }
  }
  const kept = series.filter((entry) => entry.points.length > 0);
  if (kept.length === 0) {
    return null;
  }
  return {
    type: 'chart',
    chart_type: 'line',
    title: TITLES[chart](hours),
    unit: chart === LIVE_CHARTS.LEVEL ? '%' : 'W',
    series: kept,
  };
}
