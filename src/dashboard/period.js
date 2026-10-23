// -----------------------------------------------------------------------------
// Period shown by a widget with a chart, chosen live (the same buttons as the
// gladys-beem-energy widgets).
//
// A widget carries a "Period" button opening a form with its periods (the
// widget action forms of Gladys 5.2; an older core relays the tap without
// values, and the period simply cycles), and "Previous" / "Next" buttons to
// step by one period. The core refreshes the widget after a successful
// action, the content then follows the new view.
//
// The view lives here, in memory, per widget instance: the core identifies
// an instance by its settings only (the content cache and the actions are
// keyed on them), so the view is keyed on the widget key and the settings.
// Two dashboards showing the same widget with the same settings share their
// view; a restart goes back to the default period.
//
// How far back: the live charts read the 5-minute history
// (HISTORY_RETENTION_IN_MS, 48 h), the energy charts the 30-minute slots
// (SLOT_RETENTION_IN_MS, 8 days) of src/zendure/energy.js. Zendure gives no
// longer history: no month nor year view.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { HISTORY_RETENTION_IN_MS, SLOT_RETENTION_IN_MS } from '../zendure/energy.js';
import { T, localTime, startOfLocalDay } from './common.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Period keys, kept in memory only (never stored in a dashboard).
export const PERIODS = {
  hours_3: { label: T('3 hours', '3 heures', '3 Stunden', '3 horas'), hours: 3 },
  hours_6: { label: T('6 hours', '6 heures', '6 Stunden', '6 horas'), hours: 6 },
  hours_12: { label: T('12 hours', '12 heures', '12 Stunden', '12 horas'), hours: 12 },
  hours_24: { label: T('24 hours', '24 heures', '24 Stunden', '24 horas'), hours: 24 },
  day: { label: T('Day', 'Jour', 'Tag', 'Día') },
  week: { label: T('7 days', '7 jours', '7 Tage', '7 días') },
};

// The views of the live charts (battery group, site) and of the energy one.
export const LIVE_PERIODS = ['hours_3', 'hours_6', 'hours_12', 'hours_24'];
export const ENERGY_VIEW = { periods: ['day', 'week'], defaultPeriod: 'day' };

/** The view spec of a live chart widget, its default from `chart_hours`. */
export const liveView = (hours) => ({
  periods: LIVE_PERIODS,
  defaultPeriod: LIVE_PERIODS.find((key) => PERIODS[key].hours === hours) ?? 'hours_6',
});

export const PERIOD_ACTION = 'period';
export const PREVIOUS_ACTION = 'previous';
export const NEXT_ACTION = 'next';
export const VIEW_ACTIONS = [PERIOD_ACTION, PREVIOUS_ACTION, NEXT_ACTION];

const WEEKDAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  fr: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  de: ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'],
  es: ['dom.', 'lun.', 'mar.', 'mié.', 'jue.', 'vie.', 'sáb.'],
};

/** Local wall-clock parts of an instant in a timezone. */
function partsOf(at, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    date: `${parts.day}/${parts.month}`,
  };
}

/** `22/10` of an instant. */
export const dateLabel = (at, timeZone) => partsOf(at, timeZone).date;

/** `Thu 22/10` / `jeu. 22/10` of the local day of an instant. */
export function dayTitle(at, timeZone) {
  const { weekday, date } = partsOf(at, timeZone);
  return T(
    `${WEEKDAYS.en[weekday]} ${date}`,
    `${WEEKDAYS.fr[weekday]} ${date}`,
    `${WEEKDAYS.de[weekday]} ${date}`,
    `${WEEKDAYS.es[weekday]} ${date}`,
  );
}

/**
 * The local midnight `days` days after the one of an instant (negative:
 * before), DST-aware: noon of the target day is always inside it.
 */
export function shiftedMidnight(midnight, days, timeZone) {
  return startOfLocalDay(midnight + days * DAY_MS + 12 * HOUR_MS, timeZone);
}

/**
 * The window of a period, `offset` periods before the current one (0: the
 * current one, -1: the previous one...).
 * @param {string} period key of PERIODS
 * @param {number} offset 0 or less
 * @param {number} now timestamp (ms)
 * @param {string} timeZone IANA timezone (the labels, the local days)
 * @returns {{ period: string, current: boolean, from: number, to: number, days?: Array<{ from: number, to: number }>, label: object|string }}
 *   `to` is now for the current window; `days` lists the local days of a
 *   day or week window
 */
export function windowOf(period, offset, now, timeZone) {
  const current = offset === 0;
  if (PERIODS[period]?.hours) {
    const length = PERIODS[period].hours * HOUR_MS;
    const to = now + offset * length;
    const from = to - length;
    return {
      period,
      current,
      from,
      to,
      label: `${dateLabel(from, timeZone)} ${localTime(from, timeZone)} → ${localTime(to, timeZone)}`,
    };
  }
  const today = startOfLocalDay(now, timeZone);
  const dayOf = (shift) => {
    const from = shiftedMidnight(today, shift, timeZone);
    return { from, to: shift === 0 ? now : shiftedMidnight(today, shift + 1, timeZone) };
  };
  if (period === 'week') {
    const last = offset * 7;
    const days = Array.from({ length: 7 }, (_, i) => dayOf(last - 6 + i));
    return {
      period,
      current,
      from: days[0].from,
      to: days[6].to,
      days,
      label: `${dateLabel(days[0].from, timeZone)} → ${dateLabel(days[6].from, timeZone)}`,
    };
  }
  const day = dayOf(offset);
  return {
    period: 'day',
    current,
    from: day.from,
    to: day.to,
    days: [day],
    label: dayTitle(day.from, timeZone),
  };
}

/**
 * Whether the period before a window still holds data: the 5-minute history
 * for the hour periods, the 30-minute slots for the days.
 * @param {ReturnType<typeof windowOf>} window
 * @param {number} now timestamp (ms)
 */
export function hasPrevious(window, now) {
  const retention = PERIODS[window.period]?.hours ? HISTORY_RETENTION_IN_MS : SLOT_RETENTION_IN_MS;
  return window.from > now - retention;
}

/** A stable key of an instance: the widget key and its settings. */
export function instanceKey(widgetKey, settings = {}) {
  const sorted = Object.keys(settings ?? {})
    .sort()
    .map((key) => [key, settings[key]]);
  return `${widgetKey}:${JSON.stringify(sorted)}`;
}

/**
 * The views of the widget instances.
 * @param {{ maxInstances?: number }} [options]
 */
export function createViews({ maxInstances = 200 } = {}) {
  const views = new Map();
  return {
    /**
     * The view of an instance.
     * @param {string} widgetKey
     * @param {object} settings
     * @param {{ periods: string[], defaultPeriod: string }} spec
     * @returns {{ period: string, offset: number }}
     */
    get(widgetKey, settings, { periods, defaultPeriod }) {
      const view = views.get(instanceKey(widgetKey, settings));
      return view && periods.includes(view.period)
        ? { ...view }
        : { period: defaultPeriod, offset: 0 };
    },

    /**
     * Apply a tap on a view button.
     * @returns {{ period: string, offset: number }} the new view
     */
    apply(widgetKey, settings, spec, actionKey, values = {}) {
      const view = this.get(widgetKey, settings, spec);
      if (actionKey === PERIOD_ACTION) {
        const chosen = values?.period;
        view.period = spec.periods.includes(chosen)
          ? chosen
          : // No form on this core: the tap cycles the periods.
            spec.periods[(spec.periods.indexOf(view.period) + 1) % spec.periods.length];
        view.offset = 0;
      } else if (actionKey === PREVIOUS_ACTION) {
        view.offset -= 1;
      } else if (actionKey === NEXT_ACTION) {
        view.offset = Math.min(0, view.offset + 1);
      } else {
        throw new Error(`Unknown widget action: ${actionKey}`);
      }
      const key = instanceKey(widgetKey, settings);
      views.delete(key);
      views.set(key, view);
      // The oldest instances go first: a dashboard edited many times leaves
      // settings nobody shows anymore.
      while (views.size > maxInstances) {
        views.delete(views.keys().next().value);
      }
      return { ...view };
    },
  };
}

/**
 * The buttons of a view: the period form, previous (when there is data
 * before), next (once stepped back).
 * @param {{ period: string, offset: number }} view
 * @param {string[]} periods
 * @param {boolean} canGoBack
 */
export function viewButtons(view, periods, canGoBack) {
  const buttons = [
    {
      type: 'button',
      label: PERIODS[view.period].label,
      icon: 'calendar',
      style: 'secondary',
      action: {
        key: PERIOD_ACTION,
        fields: [
          {
            key: 'period',
            type: 'select',
            label: T('Period', 'Période', 'Zeitraum', 'Periodo'),
            required: true,
            default: view.period,
            display: 'radio',
            options: periods.map((key) => ({ value: key, label: PERIODS[key].label })),
          },
        ],
      },
    },
  ];
  if (canGoBack) {
    buttons.push({
      type: 'button',
      label: T('Previous', 'Précédent', 'Zurück', 'Anterior'),
      icon: 'chevron-left',
      style: 'secondary',
      action: { key: PREVIOUS_ACTION },
    });
  }
  if (view.offset < 0) {
    buttons.push({
      type: 'button',
      label: T('Next', 'Suivant', 'Weiter', 'Siguiente'),
      icon: 'chevron-right',
      style: 'secondary',
      action: { key: NEXT_ACTION },
    });
  }
  return buttons;
}

/** A window label as a multi-language text. */
export const labelText = (label) =>
  typeof label === 'string' ? T(label, label, label, label) : label;

/** The toast after a tap: the period now shown. */
export function viewMessage(window) {
  const label = labelText(window.label);
  return T(
    `Showing ${label.en}`,
    `Affichage : ${label.fr}`,
    `Anzeige: ${label.de}`,
    `Mostrando ${label.es}`,
  );
}

/** The views of this process, shared by the widgets. */
export const sharedViews = createViews();

// Components of a content the core keeps, buttons included.
export const MAX_COMPONENTS = 8;

/**
 * Fit the tiles in the room the other components leave (the core keeps 8
 * components, buttons included): the first tiles stay, the others become
 * status rows, at the top of the rows.
 * @param {Array<object>} tiles value and gauge components, most useful first
 * @param {number} others the other components (heading, chart, status, buttons)
 * @returns {{ tiles: Array<object>, rows: Array<object> }}
 */
export function fitTiles(tiles, others) {
  const room = Math.max(0, MAX_COMPONENTS - others);
  return {
    tiles: tiles.slice(0, room),
    rows: tiles.slice(room).map((tile) => ({
      label: tile.label,
      icon: tile.icon ?? 'battery',
      value:
        typeof tile.value === 'number'
          ? `${tile.value}${tile.unit ? ` ${tile.unit}` : ''}`
          : tile.value,
      color: WIDGET_COLORS.NEUTRAL,
    })),
  };
}
