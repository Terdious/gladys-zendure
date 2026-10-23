// -----------------------------------------------------------------------------
// The `site` widget: the whole Zendure installation on one card.
//
// Layout `from_config` (the default): the layout and the phases of the
// integration configuration (`site_layout`, `site_phase_l1..3`), since a
// widget's settings are capped at 1 KB and three phase lists of external ids
// overflow it past ~15 batteries. `single_phase` / `three_phase` keep the
// widget's own lists, for the small sites set up before.
// Single-phase: the totals of the selected batteries (none: all of them).
// Three-phase: the batteries assigned to L1, L2 and L3 in three device
// multi-selects (the SDK offers `source: "devices"` selects and no other
// grouping), one status row per phase (home output, charge, discharge,
// solar), and a phase balance row: the spread between the highest and the
// lowest home output, in warning past the `imbalance_threshold` setting.
//
// Both layouts lead with the site totals (capacity-weighted state of charge,
// charge, discharge, solar, home output, stored energy), then the stored
// energy over the known capacity, the time left at the current power, and
// the sources serving the batteries, with alert rows (unreachable, cloud
// fallback, assignment mistakes). The content budget of the core (8
// components, 6 tiles, 1 status of 10 rows) caps it at: 1 heading, 6 tiles,
// 1 status. With the live chart of the `chart` setting (home output per
// phase by default, src/dashboard/charts.js), the stored energy tile makes
// room for it: the "Stored / capacity" row keeps the figure.
//
// The 1.6.0 rules hold: a device without a pack counts for the powers only
// (never in the level, the charge figures nor the stored energy), a site
// without any solar input (AC-coupled models) has no solar figure. An
// unreachable battery reports nothing: its last powers are left out of the
// sums (they would freeze the site at stale values), its level and stored
// energy are kept (a pack does not empty itself by going offline).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { describeBatteries } from '../devices/index.js';
import { formatRemainingTime } from '../zendure/battery.js';
import { LIVE_CHARTS, chartHoursOf, chartOf, liveChart } from './charts.js';
import {
  MAX_COMPONENTS,
  PERIODS,
  fitTiles,
  hasPrevious,
  liveView,
  sharedViews,
  viewButtons,
  viewMessage,
  windowOf,
} from './period.js';
import {
  T,
  UNKNOWN,
  LAYOUTS,
  REMAINING_LABELS,
  averageLevel,
  emptySelectionMessage,
  fitRows,
  messageContent,
  namesOf,
  resolveTimezone,
  round2,
  selectionAlerts,
  siteSelection,
  sum,
  withPacksOf,
} from './common.js';

export const SITE_WIDGET = 'site';

// Default of the `imbalance_threshold` setting (W), the manifest's too.
export const DEFAULT_IMBALANCE_THRESHOLD = 500;

// The device's own "no estimate" cap: 999 h.
const MAX_REMAINING_TIME_IN_MIN = 999 * 60;

const LABELS = {
  battery: T('Battery', 'Batterie', 'Batterie', 'Batería'),
  charging: T('Charging', 'Charge', 'Laden', 'Carga'),
  discharging: T('Discharging', 'Décharge', 'Entladen', 'Descarga'),
  solar: T('Solar', 'Solaire', 'Solar', 'Solar'),
  home: T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'),
  stored: T('Stored', 'Stockée', 'Gespeichert', 'Almacenada'),
};

const live = (battery) => battery.source !== 'unreachable';

/**
 * Site powers (W) of some batteries: the charge figures from the devices
 * with a pack, every figure from the reachable devices only.
 * @param {Array<object>} batteries battery snapshots
 */
export function powersOf(batteries) {
  const reachable = batteries.filter(live);
  const packs = withPacksOf(reachable);
  const power = (members, key) => sum(members, (battery) => battery.values[key]);
  return {
    charge: power(packs, 'batteryOutputPower'),
    discharge: power(packs, 'batteryInputPower'),
    solar: power(reachable, 'solarInputPower'),
    home: power(reachable, 'homeOutputPower'),
  };
}

/**
 * Time left until the site's packs reach their discharge floors (or charge
 * targets) at the current net pack power: the energy between each known
 * level and its limit, over the net power of the site. Null when idle or
 * when no battery gives its capacity, level and limit.
 * @param {Array<object>} batteries battery snapshots
 * @returns {{ direction: 'charge'|'discharge', minutes: number }|null}
 */
export function siteRemainingTime(batteries) {
  const { charge, discharge } = powersOf(batteries);
  const net = (discharge ?? 0) - (charge ?? 0);
  if (net === 0) {
    return null;
  }
  const direction = net > 0 ? 'discharge' : 'charge';
  let kwh = 0;
  let known = 0;
  for (const battery of withPacksOf(batteries)) {
    const level = battery.values.batteryLevel;
    const limit = direction === 'discharge' ? battery.settings.minSoc : battery.settings.socSet;
    if (battery.capacityKwh === null || level === null || limit === null) {
      continue;
    }
    known += 1;
    const left = direction === 'discharge' ? level - limit : limit - level;
    kwh += (battery.capacityKwh * Math.max(0, left)) / 100;
  }
  if (known === 0 || kwh <= 0) {
    return null;
  }
  const minutes = Math.round(((kwh * 1000) / Math.abs(net)) * 60);
  return { direction, minutes: Math.min(MAX_REMAINING_TIME_IN_MIN, minutes) };
}

/** `⌂ 820 · ↑ 0 · ↓ 850 · ☀ 0 W`: the four flows of a phase, what it has. */
function phaseFlows(batteries, powers) {
  const parts = [`⌂ ${powers.home ?? UNKNOWN}`];
  if (withPacksOf(batteries).length > 0) {
    parts.push(`↑ ${powers.charge ?? UNKNOWN}`, `↓ ${powers.discharge ?? UNKNOWN}`);
  }
  if (batteries.some((battery) => battery.hasSolar)) {
    parts.push(`☀ ${powers.solar ?? UNKNOWN}`);
  }
  return `${parts.join(' · ')} W`;
}

function phaseRows(phases) {
  return phases.map(({ label, batteries }) => {
    if (batteries.length === 0) {
      return {
        label,
        icon: 'git-commit',
        value: T('No battery', 'Aucune batterie', 'Keine Batterie', 'Ninguna batería'),
        color: WIDGET_COLORS.NEUTRAL,
      };
    }
    const level = averageLevel(batteries);
    const reachable = batteries.filter(live).length;
    return {
      // "L1 (6) · 64 %": the phase, its batteries, its level.
      label: `${label} (${batteries.length})${level === null ? '' : ` · ${level} %`}`,
      icon: 'git-commit',
      value: phaseFlows(batteries, powersOf(batteries)),
      color:
        reachable === batteries.length
          ? WIDGET_COLORS.SUCCESS
          : reachable === 0
            ? WIDGET_COLORS.DANGER
            : WIDGET_COLORS.WARNING,
    };
  });
}

/**
 * Phase balance: spread between the highest and the lowest home output of
 * the phases that have batteries. Null with fewer than two such phases.
 * @param {Array<{ label: string, batteries: Array<object> }>} phases
 * @param {number} threshold warning threshold (W)
 */
export function phaseBalance(phases, threshold) {
  const outputs = phases
    .filter((phase) => phase.batteries.length > 0)
    .map((phase) => ({ label: phase.label, home: powersOf(phase.batteries).home ?? 0 }));
  if (outputs.length < 2) {
    return null;
  }
  const highest = outputs.reduce((best, phase) => (phase.home > best.home ? phase : best));
  const lowest = outputs.reduce((best, phase) => (phase.home < best.home ? phase : best));
  const spread = Math.round(highest.home - lowest.home);
  return { spread, highest: highest.label, warning: spread > threshold };
}

function balanceRow(balance) {
  const { spread, highest } = balance;
  return {
    label: T('Phase balance', 'Équilibre des phases', 'Phasenbalance', 'Equilibrio de fases'),
    icon: 'bar-chart-2',
    value:
      spread === 0
        ? T('Balanced', 'Équilibrées', 'Ausgeglichen', 'Equilibradas')
        : T(
            `Δ ${spread} W · ${highest} highest`,
            `Δ ${spread} W · ${highest} la plus haute`,
            `Δ ${spread} W · ${highest} am höchsten`,
            `Δ ${spread} W · ${highest} la más alta`,
          ),
    color: balance.warning ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  };
}

function storageRow(batteries) {
  const packs = withPacksOf(batteries);
  const stored = round2(sum(packs, (battery) => battery.remainingKwh));
  const capacity = round2(sum(packs, (battery) => battery.capacityKwh));
  const unknown = packs.filter((battery) => battery.capacityKwh === null).length;
  let value = capacity === null ? UNKNOWN : `${stored ?? UNKNOWN} / ${capacity} kWh`;
  if (capacity !== null && unknown > 0) {
    value = T(
      `${value} · ${unknown} unknown`,
      `${value} · ${unknown} inconnue(s)`,
      `${value} · ${unknown} unbekannt`,
      `${value} · ${unknown} desconocida(s)`,
    );
  }
  return {
    label: T(
      'Stored / capacity',
      'Stockée / capacité',
      'Gespeichert / Kapazität',
      'Almacenada / capacidad',
    ),
    icon: 'battery',
    value,
    color: WIDGET_COLORS.NEUTRAL,
  };
}

const SOURCE_GROUPS = {
  local: T('local', 'local', 'lokal', 'local'),
  cloud: T('cloud', 'cloud', 'Cloud', 'nube'),
  unreachable: T('unreachable', 'injoignable', 'nicht erreichbar', 'inaccesible'),
};

/** How many batteries each source serves: `15 local · 2 cloud`. */
export function sourceCounts(batteries) {
  const counts = { local: 0, cloud: 0, unreachable: 0 };
  for (const battery of batteries) {
    if (battery.source === 'http' || battery.source === 'local') {
      counts.local += 1;
    } else if (battery.source === 'unreachable') {
      counts.unreachable += 1;
    } else {
      counts.cloud += 1;
    }
  }
  return counts;
}

function sourceRows(batteries) {
  const counts = sourceCounts(batteries);
  const text = (language) =>
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([group, count]) => `${count} ${SOURCE_GROUPS[group][language]}`)
      .join(' · ');
  const unreachable = batteries.filter((battery) => battery.source === 'unreachable');
  const degraded = batteries.filter((battery) => battery.degraded);
  const rows = [
    {
      label: T('Sources', 'Sources', 'Quellen', 'Fuentes'),
      icon: 'wifi',
      value: T(text('en'), text('fr'), text('de'), text('es')),
      color:
        unreachable.length > 0
          ? WIDGET_COLORS.DANGER
          : degraded.length > 0
            ? WIDGET_COLORS.WARNING
            : WIDGET_COLORS.SUCCESS,
    },
  ];
  if (unreachable.length > 0) {
    rows.push({
      label: T('Unreachable', 'Injoignables', 'Nicht erreichbar', 'Inaccesibles'),
      icon: 'wifi-off',
      value: namesOf(unreachable),
      color: WIDGET_COLORS.DANGER,
    });
  }
  if (degraded.length > 0) {
    rows.push({
      label: T('Cloud fallback', 'Repli cloud', 'Cloud-Rückfall', 'Respaldo en la nube'),
      icon: 'cloud',
      value: namesOf(degraded),
      color: WIDGET_COLORS.WARNING,
    });
  }
  return rows;
}

/**
 * Content of the site widget.
 * @param {string|object} title heading
 * @param {ReturnType<typeof siteSelection>} selection
 * @param {{ threshold?: number, chart?: string, hours?: number, now?: number }} [options]
 *   `chart`: the live chart (src/dashboard/charts.js), none by default
 * @returns {object} widget content
 */
export function siteContent(
  title,
  selection,
  {
    threshold = DEFAULT_IMBALANCE_THRESHOLD,
    chart = LIVE_CHARTS.NONE,
    hours = 6,
    now = Date.now(),
    window,
    buttons = [],
  } = {},
) {
  const { batteries } = selection;
  const packs = withPacksOf(batteries);
  const powers = powersOf(batteries);
  const tile = (value, label, icon, unit = 'W') => ({
    type: 'value',
    value: value ?? UNKNOWN,
    unit,
    label,
    icon,
  });

  // Tiles, the most useful first: the room the heading, the chart, the
  // status and the period buttons leave goes to the first ones, the others
  // become the first status rows (src/dashboard/period.js fitTiles). The
  // stored energy has its "Stored / capacity" row: its tile only fills a
  // spare place.
  const candidates = [];
  if (packs.length > 0) {
    const level = averageLevel(batteries);
    candidates.push({
      type: 'gauge',
      value: level ?? 0,
      min: 0,
      max: 100,
      unit: '%',
      label: LABELS.battery,
      color: level === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.SUCCESS,
    });
  }
  candidates.push(tile(powers.home, LABELS.home, 'home'));
  if (packs.length > 0) {
    candidates.push(
      tile(powers.charge, LABELS.charging, 'battery-charging'),
      tile(powers.discharge, LABELS.discharging, 'zap'),
    );
  }
  if (batteries.some((battery) => battery.hasSolar)) {
    candidates.push(tile(powers.solar, LABELS.solar, 'sun'));
  }
  const chartComponent = liveChart(chart, {
    batteries,
    phases: selection.layout === LAYOUTS.THREE_PHASE ? selection.phases : [],
    hours,
    now,
    window,
  });
  // No chart, nothing to navigate.
  const navigation = chartComponent ? buttons : [];
  const heading = title ? [{ type: 'text', variant: 'heading', text: title }] : [];
  const others = heading.length + (chartComponent ? 1 : 0) + 1 + navigation.length;
  if (packs.length > 0 && candidates.length < MAX_COMPONENTS - others) {
    candidates.push(
      tile(round2(sum(packs, (battery) => battery.remainingKwh)), LABELS.stored, 'battery', 'kWh'),
    );
  }
  const fitted = fitTiles(candidates, others);
  const components = [...heading, ...fitted.tiles];

  const rows = [...fitted.rows];
  if (selection.layout === LAYOUTS.THREE_PHASE) {
    rows.push(...phaseRows(selection.phases));
    const balance = phaseBalance(selection.phases, threshold);
    if (balance) {
      rows.push(balanceRow(balance));
    }
  }
  if (packs.length > 0) {
    rows.push(storageRow(batteries));
    const remaining = siteRemainingTime(batteries);
    if (remaining) {
      rows.push({
        label: REMAINING_LABELS[remaining.direction],
        icon: 'clock',
        value: formatRemainingTime(remaining.minutes),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  rows.push(...sourceRows(batteries), ...selectionAlerts(selection));
  if (chartComponent) {
    components.push(chartComponent);
  }
  components.push({ type: 'status', items: fitRows(rows) }, ...navigation);

  // Computed sums: refreshed by the TTL.
  return { ttl_seconds: 30, components };
}

/** The `imbalance_threshold` setting, a non-negative number of watts. */
function thresholdOf(settings) {
  const value = Number(settings?.imbalance_threshold);
  return settings?.imbalance_threshold !== undefined &&
    settings?.imbalance_threshold !== '' &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : DEFAULT_IMBALANCE_THRESHOLD;
}

export const siteWidget = {
  async get(gladys, { settings = {}, config, now = Date.now() }) {
    const selection = siteSelection(await describeBatteries(gladys, config), settings, config);
    if (selection.batteries.length === 0) {
      return messageContent(emptySelectionMessage(selection));
    }
    // No default heading: the card already shows the widget name.
    const title = (typeof settings.title === 'string' && settings.title.trim()) || null;
    const spec = liveView(chartHoursOf(settings));
    const view = sharedViews.get(SITE_WIDGET, settings, spec);
    const window = windowOf(view.period, view.offset, now, resolveTimezone(settings.timezone));
    // The home output of each phase by default: what a three-phase site
    // watches (single-phase: the site's).
    return siteContent(title, selection, {
      threshold: thresholdOf(settings),
      chart: chartOf(settings, LIVE_CHARTS.HOME),
      hours: PERIODS[view.period].hours,
      now,
      window,
      buttons: viewButtons(view, spec.periods, hasPrevious(window, now)),
    });
  },

  // The period buttons (src/dashboard/period.js): the core refreshes the
  // widget after the action.
  async action(gladys, { actionKey, settings = {}, values }) {
    const now = Date.now();
    const spec = liveView(chartHoursOf(settings));
    const view = sharedViews.apply(SITE_WIDGET, settings, spec, actionKey, values);
    return viewMessage(windowOf(view.period, view.offset, now, resolveTimezone(settings.timezone)));
  },
};
