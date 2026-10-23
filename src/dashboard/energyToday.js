// -----------------------------------------------------------------------------
// The `energy_today` widget: the energy of the day, per site or per phase.
//
// Zendure reports powers only; the integration integrates them into energy
// meters (src/zendure/energy.js, /data/energy.json), which also keep the
// totals at the start of every 30-minute slot of the last 26 hours. The
// energy of today is the totals now minus the snapshot of the first slot at
// or after the local midnight, the midnight of the widget's `timezone`
// setting (Gladys gives an integration no instance timezone; empty or
// unknown: Europe/Paris). The chart follows the `chart` setting: the energy
// of each slot to the home (default), charged, discharged or solar, per phase
// on a three-phase site, or the four flows of the whole site.
//
// Same selection as the `site` widget (from the integration configuration
// by default, or the widget's own lists: single-phase, or L1/L2/L3). The
// figures start when the meters saw the batteries: after a first install or
// a day spent offline, the "Counted since" row tells from when.
//
// With an electricity tariff in the configuration and the `show_savings`
// setting on (the default), the widget adds the savings ESTIMATE (no grid
// meter, src/dashboard/savings.js): one tile and a few rows.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { describeBatteries } from '../devices/index.js';
import { tariffFromConfig, TARIFF_MODES } from '../zendure/savings.js';
import { savingsComponents } from './savings.js';
import {
  MAX_STATUS_ROWS,
  T,
  LAYOUTS,
  emptySelectionMessage,
  fitRows,
  localTime,
  messageContent,
  resolveTimezone,
  selectionAlerts,
  siteSelection,
  startOfLocalDay,
  withPacksOf,
} from './common.js';

export const ENERGY_TODAY_WIDGET = 'energy_today';

const FLOWS = {
  charge: 'batteryChargeEnergy',
  discharge: 'batteryDischargeEnergy',
  solar: 'solarEnergy',
  home: 'homeOutputEnergy',
};

const LABELS = {
  charged: T('Charged', 'Chargée', 'Geladen', 'Cargada'),
  discharged: T('Discharged', 'Déchargée', 'Entladen', 'Descargada'),
  solar: T('Solar', 'Solaire', 'Solar', 'Solar'),
  home: T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'),
};

// Values of the `chart` setting, stored in the users' dashboards.
export const ENERGY_CHARTS = {
  HOME: 'home',
  CHARGE: 'charge',
  DISCHARGE: 'discharge',
  SOLAR: 'solar',
  FLOWS: 'flows',
  NONE: 'none',
};

const CHART_TITLES = {
  home: T(
    'To the home, per 30 min',
    'Vers la maison, par 30 min',
    'Zum Haus, je 30 Min.',
    'Al hogar, cada 30 min',
  ),
  charge: T(
    'Charged, per 30 min',
    'Chargée, par 30 min',
    'Geladen, je 30 Min.',
    'Cargada, cada 30 min',
  ),
  discharge: T(
    'Discharged, per 30 min',
    'Déchargée, par 30 min',
    'Entladen, je 30 Min.',
    'Descargada, cada 30 min',
  ),
  solar: T('Solar, per 30 min', 'Solaire, par 30 min', 'Solar, je 30 Min.', 'Solar, cada 30 min'),
  flows: T(
    'Site flows, per 30 min',
    'Flux du site, par 30 min',
    'Anlagenflüsse, je 30 Min.',
    'Flujos, cada 30 min',
  ),
};

const LOADING = T(
  'The energy meters are loading: the figures of the day show up in a few seconds.',
  "Les compteurs d'énergie se chargent : les chiffres du jour arrivent dans quelques secondes.",
  'Die Energiezähler werden geladen: Die Tageswerte erscheinen in wenigen Sekunden.',
  'Los contadores de energía se están cargando: las cifras del día llegan en unos segundos.',
);

// Chart flow -> LABELS key.
const FLOW_LABELS = { charge: 'charged', discharge: 'discharged', solar: 'solar', home: 'home' };

const round = (kwh, digits) => Math.round(kwh * 10 ** digits) / 10 ** digits;

/**
 * Energy of some batteries since a moment: kWh per flow (charge figures
 * from the devices with a pack), per slot and flow, and the earliest
 * counting start.
 * @param {Array<object>} batteries battery snapshots
 * @param {number} since timestamp (ms), the local midnight
 */
export function energyOf(batteries, since) {
  const packIds = new Set(withPacksOf(batteries).map((battery) => battery.externalId));
  const kwh = { charge: 0, discharge: 0, solar: 0, home: 0 };
  const slots = new Map(); // slot start -> { flow: kWh }
  let countingSince = null;
  for (const battery of batteries) {
    const energy = battery.energySince(since);
    if (!energy) {
      continue;
    }
    countingSince =
      countingSince === null ? energy.countingSince : Math.min(countingSince, energy.countingSince);
    for (const [flow, key] of Object.entries(FLOWS)) {
      if (packIds.has(battery.externalId) || flow === 'solar' || flow === 'home') {
        kwh[flow] += energy.kwh[key];
      }
    }
    for (const slot of energy.slots) {
      const total = slots.get(slot.at) ?? { charge: 0, discharge: 0, solar: 0, home: 0 };
      for (const [flow, key] of Object.entries(FLOWS)) {
        if (packIds.has(battery.externalId) || flow === 'solar' || flow === 'home') {
          total[flow] += slot.kwh[key];
        }
      }
      slots.set(slot.at, total);
    }
  }
  return { kwh, slots, countingSince };
}

/** `⌂ 4.2 · ↑ 3.1 · ↓ 2.0 · ☀ 5.5 kWh`: what a phase has. */
function phaseFlows(batteries, kwh) {
  const parts = [`⌂ ${round(kwh.home, 1)}`];
  if (withPacksOf(batteries).length > 0) {
    parts.push(`↑ ${round(kwh.charge, 1)}`, `↓ ${round(kwh.discharge, 1)}`);
  }
  if (batteries.some((battery) => battery.hasSolar)) {
    parts.push(`☀ ${round(kwh.solar, 1)}`);
  }
  return `${parts.join(' · ')} kWh`;
}

/** Inline chart points of one flow of a slot map, in time order (Wh per slot). */
function pointsOf(slots, flow = 'home') {
  return [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, kwh]) => ({ t: new Date(at).toISOString(), v: Math.round(kwh[flow] * 1000) }));
}

/**
 * Content of the energy widget.
 * @param {string|object} title heading
 * @param {ReturnType<typeof siteSelection>} selection
 * @param {{ now: number, timeZone: string, chart?: string, savings?: { tariff: object|null, tariffError: string|null } }} options
 *   `chart`: an ENERGY_CHARTS value (home by default), `savings` absent: no savings shown
 * @returns {object} widget content
 */
export function energyTodayContent(
  title,
  selection,
  { now, timeZone, chart = ENERGY_CHARTS.HOME, savings },
) {
  const { batteries } = selection;
  const since = startOfLocalDay(now, timeZone);
  const site = energyOf(batteries, since);
  const hasPacks = withPacksOf(batteries).length > 0;
  const hasSolar = batteries.some((battery) => battery.hasSolar);
  const tile = (kwh, label, icon) => ({
    type: 'value',
    value: round(kwh, 2),
    unit: 'kWh',
    label,
    icon,
  });

  const components = [{ type: 'text', variant: 'heading', text: title }];
  if (hasPacks) {
    components.push(
      tile(site.kwh.charge, LABELS.charged, 'battery-charging'),
      tile(site.kwh.discharge, LABELS.discharged, 'zap'),
    );
  }
  if (hasSolar) {
    components.push(tile(site.kwh.solar, LABELS.solar, 'sun'));
  }
  components.push(tile(site.kwh.home, LABELS.home, 'home'));
  const savingsParts = savings
    ? savingsComponents(selection, { now, ...savings })
    : { tiles: [], rows: [] };
  components.push(...savingsParts.tiles);

  const rows = [];
  const series = [];
  // One flow charted: per phase on a three-phase site, else the site's.
  const oneFlow = chart in FLOW_LABELS;
  if (selection.layout === LAYOUTS.THREE_PHASE) {
    const phases = selection.phases.map((phase) => ({
      ...phase,
      energy: energyOf(phase.batteries, since),
    }));
    for (const phase of phases) {
      rows.push({
        label: `${phase.label} (${phase.batteries.length})`,
        icon: 'git-commit',
        value:
          phase.batteries.length === 0
            ? T('No battery', 'Aucune batterie', 'Keine Batterie', 'Ninguna batería')
            : phaseFlows(phase.batteries, phase.energy.kwh),
        color: WIDGET_COLORS.NEUTRAL,
      });
      if (phase.energy.slots.size > 0 && oneFlow) {
        series.push({ name: phase.label, points: pointsOf(phase.energy.slots, chart) });
      }
    }
    const homes = phases
      .filter((phase) => phase.batteries.length > 0)
      .map((phase) => ({ label: phase.label, kwh: phase.energy.kwh.home }));
    if (homes.length >= 2) {
      const highest = homes.reduce((best, phase) => (phase.kwh > best.kwh ? phase : best));
      const lowest = homes.reduce((best, phase) => (phase.kwh < best.kwh ? phase : best));
      const spread = round(highest.kwh - lowest.kwh, 1);
      rows.push({
        label: T('Phase balance', 'Équilibre des phases', 'Phasenbalance', 'Equilibrio de fases'),
        icon: 'bar-chart-2',
        value:
          spread === 0
            ? T('Balanced', 'Équilibrées', 'Ausgeglichen', 'Equilibradas')
            : T(
                `Δ ${spread} kWh · ${highest.label} highest`,
                `Δ ${spread} kWh · ${highest.label} la plus haute`,
                `Δ ${spread} kWh · ${highest.label} am höchsten`,
                `Δ ${spread} kWh · ${highest.label} la más alta`,
              ),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  } else if (site.slots.size > 0 && oneFlow) {
    series.push({ name: LABELS[FLOW_LABELS[chart]], points: pointsOf(site.slots, chart) });
  }
  if (chart === ENERGY_CHARTS.FLOWS && site.slots.size > 0) {
    // The flows the site has: no charge figures without a pack, no solar
    // without a PV input.
    const flows = [
      ...(hasPacks ? ['charge', 'discharge'] : []),
      ...(hasSolar ? ['solar'] : []),
      'home',
    ];
    for (const flow of flows) {
      series.push({ name: LABELS[FLOW_LABELS[flow]], points: pointsOf(site.slots, flow) });
    }
  }

  if (series.length > 0) {
    components.push({
      type: 'chart',
      chart_type: 'line',
      title: CHART_TITLES[chart],
      unit: 'Wh',
      series,
    });
  }

  // From when the figures count: the local midnight, or later when the
  // meters first saw a battery today (first install, offline morning).
  const startedLate = site.countingSince !== null && site.countingSince > since;
  const from = `${localTime(site.countingSince ?? since, timeZone)} · ${timeZone}`;
  const countedSince = {
    label: T('Counted since', 'Compté depuis', 'Gezählt seit', 'Contado desde'),
    icon: 'clock',
    value:
      site.countingSince === null
        ? T('No data today', "Rien aujourd'hui", 'Heute keine Daten', 'Sin datos hoy')
        : from,
    color: startedLate || site.countingSince === null ? WIDGET_COLORS.INFO : WIDGET_COLORS.NEUTRAL,
  };
  const alerts = selectionAlerts(selection);
  // The savings rows take the room the others leave, the least important
  // (the end of the breakdown) dropped first.
  const room = Math.max(1, MAX_STATUS_ROWS - rows.length - 1 - alerts.length);
  rows.push(...savingsParts.rows.slice(0, room), countedSince, ...alerts);
  components.push({ type: 'status', items: fitRows(rows) });

  // Energy moves slowly: two minutes.
  return { ttl_seconds: 120, components };
}

export const energyTodayWidget = {
  async get(gladys, { settings = {}, config, now = Date.now() }) {
    const selection = siteSelection(await describeBatteries(gladys, config), settings, config);
    if (selection.batteries.length === 0) {
      return messageContent(emptySelectionMessage(selection));
    }
    if (!selection.batteries.some((battery) => battery.energyReady)) {
      return messageContent(LOADING);
    }
    const title =
      (typeof settings.title === 'string' && settings.title.trim()) ||
      T('Energy today', 'Énergie du jour', 'Energie heute', 'Energía de hoy');
    // The savings: on unless the instance turns them off, and only with a
    // tariff in the configuration (none: nothing shown).
    const showSavings = settings.show_savings !== false && settings.show_savings !== 'false';
    let savings;
    if (showSavings && config?.tariff_mode && config.tariff_mode !== TARIFF_MODES.NONE) {
      const { tariff, error } = tariffFromConfig(config);
      savings = { tariff, tariffError: error };
    }
    return energyTodayContent(title, selection, {
      now,
      timeZone: resolveTimezone(settings.timezone),
      chart: Object.values(ENERGY_CHARTS).includes(settings.chart)
        ? settings.chart
        : ENERGY_CHARTS.HOME,
      savings,
    });
  },
};
