// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
//   - `battery`: one battery — state of charge gauge and live power tiles
//     (bound to the device features, they follow the published states), its
//     source, remaining time and settings, and two buttons opening a form to
//     change them. A device without a battery pack (a SolarFlow 800 running
//     as a plain micro-inverter) only shows what it has: solar, home output
//     and its output limit; a device without a PV input has no solar tile.
//   - `battery_group`: several batteries summed up under a name of your
//     choice. One instance per group: a three-phase installation adds one per
//     phase (L1, L2, L3), and one more without battery selected for the whole
//     site; a single-phase installation needs just one. Its list follows the
//     `sort` setting (natural order of the names by default), and a live
//     chart of the last hours (src/dashboard/charts.js) follows `chart`.
//   - `site` (src/dashboard/site.js): the whole installation, single-phase or
//     three-phase (batteries assigned to L1, L2, L3 in the integration
//     configuration by default, or in the widget's own lists), with the
//     phase balance, the sources and the alerts.
//   - `energy_today` (src/dashboard/energyToday.js): the energy of the day
//     since local midnight, per site or per phase.
//
// The manifest allows at most 5 widgets and their keys are stored in the
// users' dashboards: think twice before spending the last slot.
//
// index.js registers `get` with onWidgetGet and `action` with
// onWidgetAction. The content budget of the core (8 components, 6 tiles,
// 1 status, 4 buttons) decides what each widget shows.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { controlDevice, describeBatteries } from './devices/index.js';
import { formatRemainingTime } from './zendure/battery.js';
import { AC_MODES, MIN_SOC_RANGE, SOC_SET_RANGE } from './zendure/control.js';
import {
  T,
  UNKNOWN,
  MAX_STATUS_ROWS,
  NO_BATTERY,
  REMAINING_LABELS,
  averageLevel,
  messageContent,
  resolveTimezone,
  sourceStatus,
  sum,
  withPacksOf,
  withUnit,
} from './dashboard/common.js';
import {
  LIVE_CHARTS,
  chartHoursOf,
  chartOf,
  liveChart,
  sortBatteries,
} from './dashboard/charts.js';
import {
  PERIODS,
  fitTiles,
  hasPrevious,
  liveView,
  sharedViews,
  viewButtons,
  viewMessage,
  windowOf,
} from './dashboard/period.js';
import { SITE_WIDGET, siteWidget } from './dashboard/site.js';
import { ENERGY_TODAY_WIDGET, energyTodayWidget } from './dashboard/energyToday.js';

const logger = createLogger({ name: 'widgets' });

export const BATTERY_WIDGET = 'battery';
export const GROUP_WIDGET = 'battery_group';
export { SITE_WIDGET, ENERGY_TODAY_WIDGET };

// Keys of the button actions of the battery widget.
export const BATTERY_ACTIONS = { POWER_LIMITS: 'power_limits', MODE_AND_LEVELS: 'mode_and_levels' };

// Content TTL of the battery widget (s), see batteryContent.
export const BATTERY_TTL_SECONDS = 120;

// Rows of a status component the core keeps (the SDK's MAX_STATUS_ITEMS).
const GROUP_MAX_ROWS = MAX_STATUS_ROWS;

const AC_MODE_TEXT = {
  [AC_MODES.charge]: T('Charge', 'Charge', 'Laden', 'Carga'),
  [AC_MODES.discharge]: T('Discharge', 'Décharge', 'Entladen', 'Descarga'),
};

const CHOOSE_BATTERY = T(
  'Choose a battery in the settings of this widget.',
  'Choisissez une batterie dans les réglages de ce widget.',
  'Wähle in den Einstellungen dieses Widgets eine Batterie.',
  'Elija una batería en los ajustes de este widget.',
);

/** The state of charge gauge, with its unit (a value gauge when known). */
function levelGauge(battery) {
  const label = T('Battery', 'Batterie', 'Batterie', 'Batería');
  const level = battery.values.batteryLevel;
  if (level === null || level === undefined) {
    return {
      type: 'gauge',
      device_feature: battery.featureExternalId('batteryLevel'),
      unit: '%',
      label,
      color: WIDGET_COLORS.SUCCESS,
    };
  }
  return {
    type: 'gauge',
    value: level,
    min: 0,
    max: 100,
    unit: '%',
    label,
    color: WIDGET_COLORS.SUCCESS,
  };
}

function batteryContent(battery) {
  const feature = battery.featureExternalId;
  const { settings } = battery;
  // Unknown presence keeps every battery figure: never hide them on a guess.
  const withBattery = battery.hasBattery !== false;
  const levels =
    settings.socSet === null && settings.minSoc === null
      ? UNKNOWN
      : `${settings.minSoc ?? UNKNOWN} – ${settings.socSet ?? UNKNOWN} %`;
  const statusItems = [
    {
      label: T('Source', 'Source', 'Quelle', 'Fuente'),
      icon: 'wifi',
      ...sourceStatus(battery),
    },
  ];
  if (withBattery) {
    statusItems.push({
      label: T('Energy stored', 'Énergie stockée', 'Gespeicherte Energie', 'Energía almacenada'),
      icon: 'battery',
      value:
        battery.remainingKwh === null
          ? UNKNOWN
          : `${battery.remainingKwh} / ${battery.capacityKwh} kWh`,
      color: WIDGET_COLORS.NEUTRAL,
    });
    if (battery.remainingTime) {
      statusItems.push({
        label: REMAINING_LABELS[battery.remainingTime.direction],
        icon: 'clock',
        value: formatRemainingTime(battery.remainingTime.minutes),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  } else {
    statusItems.push({
      label: T('Battery pack', 'Batterie', 'Batteriepack', 'Batería'),
      icon: 'battery',
      value: T('None', 'Aucune', 'Keiner', 'Ninguna'),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  statusItems.push({
    label: T('Output limit', 'Limite de sortie', 'Ausgangslimit', 'Límite de salida'),
    icon: 'arrow-up-right',
    value: withUnit(settings.outputLimit, 'W'),
    color: WIDGET_COLORS.NEUTRAL,
  });
  if (withBattery) {
    statusItems.push(
      {
        label: T('Charge limit', 'Limite de charge', 'Ladelimit', 'Límite de carga'),
        icon: 'arrow-down-left',
        value: withUnit(settings.inputLimit, 'W'),
        color: WIDGET_COLORS.NEUTRAL,
      },
      {
        label: T('AC mode', 'Mode AC', 'AC-Modus', 'Modo AC'),
        icon: 'repeat',
        value: AC_MODE_TEXT[settings.acMode] ?? UNKNOWN,
        color: WIDGET_COLORS.NEUTRAL,
      },
      {
        label: T('Charge levels', 'Niveaux de charge', 'Ladestände', 'Niveles de carga'),
        icon: 'sliders',
        value: levels,
        color: WIDGET_COLORS.NEUTRAL,
      },
    );
  }

  const powerFields = [
    {
      key: 'output_limit',
      type: 'number',
      label: T(
        'Output limit (W)',
        'Limite de sortie (W)',
        'Ausgangslimit (W)',
        'Límite de salida (W)',
      ),
      min: 0,
      max: 3200,
      ...(settings.outputLimit !== null ? { default: settings.outputLimit } : {}),
    },
  ];
  if (withBattery) {
    powerFields.push({
      key: 'input_limit',
      type: 'number',
      label: T('Charge limit (W)', 'Limite de charge (W)', 'Ladelimit (W)', 'Límite de carga (W)'),
      min: 0,
      max: 3200,
      ...(settings.inputLimit !== null ? { default: settings.inputLimit } : {}),
    });
  }

  const components = [];
  if (withBattery) {
    components.push(
      levelGauge(battery),
      {
        type: 'value',
        device_feature: feature('batteryOutputPower'),
        label: T('Charging', 'Charge', 'Laden', 'Carga'),
        icon: 'battery-charging',
      },
      {
        type: 'value',
        device_feature: feature('batteryInputPower'),
        label: T('Discharging', 'Décharge', 'Entladen', 'Descarga'),
        icon: 'zap',
      },
    );
  }
  if (battery.hasSolar) {
    components.push({
      type: 'value',
      device_feature: feature('solarInputPower'),
      label: T('Solar', 'Solaire', 'Solar', 'Solar'),
      icon: 'sun',
    });
  }
  components.push(
    {
      type: 'value',
      device_feature: feature('homeOutputPower'),
      label: T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'),
      icon: 'home',
    },
    { type: 'status', items: statusItems },
    {
      type: 'button',
      label: T('Power limits', 'Limites de puissance', 'Leistungslimits', 'Límites de potencia'),
      icon: 'sliders',
      style: 'secondary',
      action: {
        key: BATTERY_ACTIONS.POWER_LIMITS,
        params: { device: battery.externalId },
        fields: powerFields,
      },
    },
  );
  if (withBattery) {
    components.push({
      type: 'button',
      label: T('Mode & levels', 'Mode et niveaux', 'Modus & Stände', 'Modo y niveles'),
      icon: 'battery',
      style: 'secondary',
      action: {
        key: BATTERY_ACTIONS.MODE_AND_LEVELS,
        params: { device: battery.externalId },
        fields: [
          {
            key: 'ac_mode',
            type: 'select',
            label: T('AC mode', 'Mode AC', 'AC-Modus', 'Modo AC'),
            display: 'radio',
            options: [
              { value: 'charge', label: AC_MODE_TEXT[AC_MODES.charge] },
              { value: 'discharge', label: AC_MODE_TEXT[AC_MODES.discharge] },
            ],
            ...(AC_MODE_TEXT[settings.acMode]
              ? { default: settings.acMode === AC_MODES.charge ? 'charge' : 'discharge' }
              : {}),
          },
          {
            key: 'max_soc',
            type: 'number',
            label: T(
              'Charge target (%)',
              'Cible de charge (%)',
              'Ladeziel (%)',
              'Objetivo de carga (%)',
            ),
            min: SOC_SET_RANGE.min,
            max: SOC_SET_RANGE.max,
            ...(settings.socSet !== null ? { default: settings.socSet } : {}),
          },
          {
            key: 'min_soc',
            type: 'number',
            label: T(
              'Discharge floor (%)',
              'Plancher de décharge (%)',
              'Entladegrenze (%)',
              'Mínimo de descarga (%)',
            ),
            min: MIN_SOC_RANGE.min,
            max: MIN_SOC_RANGE.max,
            ...(settings.minSoc !== null ? { default: settings.minSoc } : {}),
          },
        ],
      },
    });
  }
  // The power tiles are bound to the device features: the core pushes their
  // states in real time, whatever the TTL. The TTL only refreshes the gauge
  // and the status rows (level, stored energy, remaining time, source,
  // settings), which move by about 1 % a minute at most. Two minutes, not
  // 30 s: a site of 18 batteries has up to 18 instances, and the core
  // answers 429 past 30 content pulls a minute per integration (cache
  // misses, settings edits included), which 18 x 2 pulls a minute exceeded.
  return { ttl_seconds: BATTERY_TTL_SECONDS, components };
}

/** Status row value of a group member: level (and remaining time) or output. */
function groupRowValue(battery) {
  if (battery.hasBattery === false) {
    return withUnit(battery.values.homeOutputPower, 'W');
  }
  if (battery.values.batteryLevel === null) {
    return UNKNOWN;
  }
  const time = battery.remainingTime
    ? ` · ${battery.remainingTime.direction === 'charge' ? '↑' : '↓'} ${formatRemainingTime(battery.remainingTime.minutes)}`
    : '';
  return `${battery.values.batteryLevel} %${time}`;
}

/**
 * Content of the battery group widget.
 * @param {string|object|null} title heading, none without
 * @param {Array<object>} batteries battery snapshots, in list order
 * @param {{ chart?: string, hours?: number, now?: number, window?: object, buttons?: Array<object> }} [options]
 *   the live chart, the window shown and the period buttons (src/dashboard/period.js)
 * @returns {object} widget content
 */
export function groupContent(
  title,
  batteries,
  { chart = LIVE_CHARTS.NONE, hours = 6, now = Date.now(), window, buttons = [] } = {},
) {
  // Devices known to have no pack (micro-inverter mode) count for the powers
  // only, never in the state of charge nor in the stored energy.
  const withPacks = withPacksOf(batteries);
  // Capacity-weighted state of charge when every pack is known, plain
  // average otherwise.
  const level = averageLevel(batteries);
  const power = (key, members = batteries) => sum(members, (battery) => battery.values[key]);
  const tile = (key, label, icon, members) => ({
    type: 'value',
    value: power(key, members) ?? UNKNOWN,
    unit: 'W',
    label,
    icon,
  });
  const stored = sum(withPacks, (battery) => battery.remainingKwh);

  // Tiles, the most useful first: the room the heading, the chart, the
  // status and the period buttons leave goes to the first ones, the others
  // become the first status rows (src/dashboard/period.js fitTiles).
  const candidates = [];
  // A group without any battery shows no battery figure at all (no 0 %).
  if (withPacks.length > 0) {
    candidates.push({
      type: 'gauge',
      value: level ?? 0,
      min: 0,
      max: 100,
      unit: '%',
      label: T('Battery', 'Batterie', 'Batterie', 'Batería'),
      color: level === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.SUCCESS,
    });
  }
  candidates.push(
    tile('homeOutputPower', T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'), 'home'),
  );
  if (withPacks.length > 0) {
    candidates.push(
      tile(
        'batteryOutputPower',
        T('Charging', 'Charge', 'Laden', 'Carga'),
        'battery-charging',
        withPacks,
      ),
      tile(
        'batteryInputPower',
        T('Discharging', 'Décharge', 'Entladen', 'Descarga'),
        'zap',
        withPacks,
      ),
    );
  }
  if (batteries.some((battery) => battery.hasSolar)) {
    candidates.push(tile('solarInputPower', T('Solar', 'Solaire', 'Solar', 'Solar'), 'sun'));
  }
  if (withPacks.length > 0) {
    candidates.push({
      type: 'value',
      value: stored === null ? UNKNOWN : Math.round(stored * 100) / 100,
      unit: 'kWh',
      label: T('Stored', 'Stockée', 'Gespeichert', 'Almacenada'),
      icon: 'battery',
    });
  }
  const chartComponent = liveChart(chart, { batteries, hours, now, window });
  // No chart, nothing to navigate.
  const navigation = chartComponent ? buttons : [];
  const heading = title ? [{ type: 'text', variant: 'heading', text: title }] : [];
  const fitted = fitTiles(
    candidates,
    heading.length + (chartComponent ? 1 : 0) + 1 + navigation.length,
  );
  const components = [...heading, ...fitted.tiles];
  if (chartComponent) {
    components.push(chartComponent);
  }
  const rows = [...fitted.rows];
  const memberRows = batteries.map((battery) => ({
    label: battery.name.slice(0, 40),
    icon: battery.hasBattery === false ? 'sun' : 'battery',
    value: groupRowValue(battery),
    color: sourceStatus(battery).color,
  }));
  rows.push(...memberRows);
  // The core keeps GROUP_MAX_ROWS rows: past that, the last one tells how
  // many batteries are not listed instead of dropping them silently.
  if (rows.length > GROUP_MAX_ROWS) {
    const hidden = rows.length - (GROUP_MAX_ROWS - 1);
    rows.splice(GROUP_MAX_ROWS - 1, rows.length, {
      label: T(`+${hidden} more`, `+${hidden} autres`, `+${hidden} weitere`, `+${hidden} más`),
      icon: 'more-horizontal',
      value: T('not listed', 'non listées', 'nicht aufgeführt', 'no listadas'),
    });
  }
  components.push({ type: 'status', items: rows }, ...navigation);

  // Computed sums: refreshed by the TTL.
  return { ttl_seconds: 30, components };
}

const ACTION_SENT = T(
  'Sent to the battery: the new values show up with its next report.',
  'Envoyé à la batterie : les nouvelles valeurs apparaissent à sa prochaine remontée.',
  'An die Batterie gesendet: Die neuen Werte erscheinen mit ihrer nächsten Meldung.',
  'Enviado a la batería: los nuevos valores aparecen con su próximo informe.',
);
const ACTION_UNCHANGED = T(
  'Nothing to change: the battery already runs with these values.',
  'Rien à changer : la batterie fonctionne déjà avec ces valeurs.',
  'Nichts zu ändern: Die Batterie läuft bereits mit diesen Werten.',
  'Nada que cambiar: la batería ya funciona con estos valores.',
);

// Configuration keys the site widgets read in their `from_config` layout.
const SITE_CONFIG_KEYS = ['site_layout', 'site_phase_l1', 'site_phase_l2', 'site_phase_l3'];

/**
 * After a configuration change, ask the core to re-pull the site widgets
 * when their electrical installation changed: their cached content (keyed by
 * the widget settings, which do not change) would otherwise show the old
 * phases until its TTL. A nudge is rate-limited core-side and costs one pull.
 * @param {object} gladys SDK instance
 * @param {object} previous normalized configuration before the change
 * @param {object} next normalized configuration after the change
 * @returns {Array<string>} the widget keys nudged
 */
export function refreshSiteWidgets(gladys, previous, next) {
  const changed = SITE_CONFIG_KEYS.some(
    (key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]),
  );
  if (!changed || typeof gladys.requestWidgetRefresh !== 'function') {
    return [];
  }
  const keys = [SITE_WIDGET, ENERGY_TODAY_WIDGET];
  for (const key of keys) {
    gladys.requestWidgetRefresh(key);
  }
  return keys;
}

const isSet = (value) => value !== undefined && value !== null && value !== '';

export const WIDGETS = {
  [BATTERY_WIDGET]: {
    async get(gladys, { settings, config }) {
      if (!settings?.device) {
        return messageContent(CHOOSE_BATTERY);
      }
      const battery = (await describeBatteries(gladys, config)).find(
        (candidate) => candidate.externalId === settings.device,
      );
      return battery ? batteryContent(battery) : messageContent(NO_BATTERY);
    },

    // `params.device` comes from our own content, `values` from the form the
    // user filled in (validated by the core against the declared fields).
    async action(gladys, { actionKey, params, values = {}, config }) {
      logger.info(`onWidgetAction <- ${BATTERY_WIDGET}.${actionKey} ${JSON.stringify(values)}`);
      const commands = [];
      if (actionKey === BATTERY_ACTIONS.POWER_LIMITS) {
        if (isSet(values.output_limit)) {
          commands.push({ kind: 'output_limit', watts: values.output_limit });
        }
        if (isSet(values.input_limit)) {
          commands.push({ kind: 'input_limit', watts: values.input_limit });
        }
      } else if (actionKey === BATTERY_ACTIONS.MODE_AND_LEVELS) {
        if (isSet(values.ac_mode)) {
          commands.push({ kind: 'ac_mode', mode: values.ac_mode });
        }
        if (isSet(values.max_soc) || isSet(values.min_soc)) {
          commands.push({ kind: 'soc_limits', max_soc: values.max_soc, min_soc: values.min_soc });
        }
      } else {
        throw new Error(`Unknown widget action: ${actionKey}`);
      }
      let sent = false;
      for (const command of commands) {
        const result = await controlDevice(gladys, config, params.device, command);
        sent = sent || result.sent;
      }
      return sent ? ACTION_SENT : ACTION_UNCHANGED;
    },
  },

  [GROUP_WIDGET]: {
    async get(gladys, { settings, config, now = Date.now() }) {
      const all = await describeBatteries(gladys, config);
      const selected = Array.isArray(settings?.devices) ? settings.devices : [];
      const batteries = sortBatteries(
        selected.length === 0
          ? all
          : all.filter((battery) => selected.includes(battery.externalId)),
        settings?.sort,
        selected,
      );
      if (batteries.length === 0) {
        return messageContent(NO_BATTERY);
      }
      // No default heading: the card already shows the widget name.
      const title = (typeof settings?.title === 'string' && settings.title.trim()) || null;
      const spec = liveView(chartHoursOf(settings));
      const view = sharedViews.get(GROUP_WIDGET, settings, spec);
      const window = windowOf(view.period, view.offset, now, resolveTimezone(settings?.timezone));
      return groupContent(title, batteries, {
        chart: chartOf(settings, LIVE_CHARTS.POWER),
        hours: PERIODS[view.period].hours,
        now,
        window,
        buttons: viewButtons(view, spec.periods, hasPrevious(window, now)),
      });
    },

    // The period buttons (src/dashboard/period.js): the core refreshes the
    // widget after the action.
    async action(gladys, { actionKey, settings, values }) {
      const now = Date.now();
      const spec = liveView(chartHoursOf(settings));
      const view = sharedViews.apply(GROUP_WIDGET, settings, spec, actionKey, values);
      return viewMessage(
        windowOf(view.period, view.offset, now, resolveTimezone(settings?.timezone)),
      );
    },
  },

  [SITE_WIDGET]: siteWidget,
  [ENERGY_TODAY_WIDGET]: energyTodayWidget,
};
