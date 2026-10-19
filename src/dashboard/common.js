// -----------------------------------------------------------------------------
// Helpers shared by the dashboard widgets (src/widgets.js): texts in the four
// Gladys languages, the source of a battery, sums over battery snapshots
// (describeBatteries in src/devices/solarflow.js), the phase assignment of
// the site widgets and the local day of a timezone.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

export const T = (en, fr, de, es) => ({ en, fr, de, es });

export const UNKNOWN = '—';

// Rows of a status component the core keeps (the SDK's MAX_STATUS_ITEMS).
export const MAX_STATUS_ROWS = 10;
// Bound of a status row label and value (characters).
const MAX_STATUS_TEXT = 40;

export const SOURCE_STATUS = {
  http: {
    value: T('Local (API)', 'Local (API)', 'Lokal (API)', 'Local (API)'),
    color: WIDGET_COLORS.SUCCESS,
  },
  local: { value: T('Local', 'Local', 'Lokal', 'Local'), color: WIDGET_COLORS.SUCCESS },
  cloud: { value: T('Cloud', 'Cloud', 'Cloud', 'Nube'), color: WIDGET_COLORS.INFO },
  degraded: {
    value: T('Cloud (fallback)', 'Cloud (repli)', 'Cloud (Rückfall)', 'Nube (respaldo)'),
    color: WIDGET_COLORS.WARNING,
  },
  unreachable: {
    value: T('Unreachable', 'Injoignable', 'Nicht erreichbar', 'Inaccesible'),
    color: WIDGET_COLORS.DANGER,
  },
};

export function sourceStatus(battery) {
  return SOURCE_STATUS[battery.degraded ? 'degraded' : battery.source];
}

export function withUnit(value, unit) {
  return value === null || value === undefined ? UNKNOWN : `${value} ${unit}`;
}

/** Sum of the known values, null when none is known. */
export function sum(batteries, pick) {
  const values = batteries.map(pick).filter((value) => value !== null && value !== undefined);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

export const round2 = (value) => (value === null ? null : Math.round(value * 100) / 100);

/** Text-only content, when the widget cannot show anything else. */
export function messageContent(text) {
  return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text }] };
}

export const NO_BATTERY = T(
  'No Zendure battery found: check the Configuration tab of the integration.',
  "Aucune batterie Zendure trouvée : vérifiez l'onglet Configuration de l'intégration.",
  'Keine Zendure-Batterie gefunden: Prüfe den Tab Konfiguration der Integration.',
  'No se encontró ninguna batería Zendure: revise la pestaña Configuración de la integración.',
);

export const REMAINING_LABELS = {
  discharge: T('Empty in', 'Vide dans', 'Leer in', 'Vacía en'),
  charge: T('Full in', 'Pleine dans', 'Voll in', 'Llena en'),
};

/** Devices that carry a pack, or may (unknown presence keeps the figures). */
export const withPacksOf = (batteries) => batteries.filter((b) => b.hasBattery !== false);

/**
 * Average state of charge of the batteries carrying a pack: weighted by the
 * pack capacities when every one is known, plain average otherwise; null
 * when no level is known.
 * @param {Array<object>} batteries battery snapshots
 * @returns {number|null}
 */
export function averageLevel(batteries) {
  const withLevel = withPacksOf(batteries).filter(
    (battery) => battery.values.batteryLevel !== null,
  );
  const weighted = withLevel.every((battery) => battery.capacityKwh !== null);
  const weight = (battery) => (weighted ? battery.capacityKwh : 1);
  const totalWeight = withLevel.reduce((total, battery) => total + weight(battery), 0);
  return totalWeight > 0
    ? Math.round(
        withLevel.reduce(
          (total, battery) => total + battery.values.batteryLevel * weight(battery),
          0,
        ) / totalWeight,
      )
    : null;
}

/** A text cut to a status bound, with an ellipsis. */
export function clip(text, max = MAX_STATUS_TEXT) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Status rows within the core's MAX_STATUS_ROWS: past it, the last row tells
 * how many are not shown instead of letting the core drop them silently.
 * @param {Array<object>} rows status items, most important first
 * @returns {Array<object>}
 */
export function fitRows(rows) {
  if (rows.length <= MAX_STATUS_ROWS) {
    return rows;
  }
  const hidden = rows.length - (MAX_STATUS_ROWS - 1);
  return [
    ...rows.slice(0, MAX_STATUS_ROWS - 1),
    {
      label: T(`+${hidden} more`, `+${hidden} autres`, `+${hidden} weitere`, `+${hidden} más`),
      icon: 'more-horizontal',
      value: T('not shown', 'non affichées', 'nicht angezeigt', 'no mostradas'),
      color: WIDGET_COLORS.NEUTRAL,
    },
  ];
}

// --- Site layout: from the configuration, single-phase or three-phase ------

// Values of the widgets' `layout` setting, stored in the users' dashboards.
// `from_config` (the default) reads the phases from the
// integration configuration: a widget's settings are capped at 1 KB
// serialized by the core (MAX_WIDGET_SETTINGS_BYTES), and a device
// multi-select stores ~50-byte external ids, so the per-widget phase lists
// stop fitting past ~15 batteries; the configuration has no such cap.
export const LAYOUTS = {
  FROM_CONFIG: 'from_config',
  SINGLE_PHASE: 'single_phase',
  THREE_PHASE: 'three_phase',
};
// Values of the `site_layout` configuration option.
export const SITE_LAYOUTS = [LAYOUTS.SINGLE_PHASE, LAYOUTS.THREE_PHASE];
// Setting key -> phase label. The keys are stored in the users' dashboards.
export const PHASE_SETTINGS = [
  { key: 'phase_l1', label: 'L1' },
  { key: 'phase_l2', label: 'L2' },
  { key: 'phase_l3', label: 'L3' },
];
// Widget phase setting -> configuration key of the same phase.
export const CONFIG_PHASE_KEYS = {
  phase_l1: 'site_phase_l1',
  phase_l2: 'site_phase_l2',
  phase_l3: 'site_phase_l3',
};

const asList = (value) =>
  Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];

// Why a `from_config` widget does not show what the configuration asks:
// three-phase with no battery in any phase, or phases filled while the
// installation is set to single-phase.
export const LAYOUT_NOTICES = { NO_PHASES: 'no_phases', PHASES_IGNORED: 'phases_ignored' };

/**
 * The settings a site widget actually runs with. `single_phase` and
 * `three_phase` keep the widget's own lists. Anything else (`from_config`,
 * the default, or a value this version does not know) takes the layout and
 * the phases of the configuration; a single-phase configuration keeps the
 * widget's `devices` (an instance saved before `from_config` existed has no
 * `layout` and gets the new default: its selection must not change). A
 * three-phase configuration without any battery assigned falls back to
 * single-phase, with a notice.
 * @param {object} settings widget instance settings
 * @param {object} config normalized integration configuration
 * @returns {{ settings: object, fromConfig: boolean, notice: string|null }}
 */
export function effectiveSiteSettings(settings = {}, config = {}) {
  if (settings.layout === LAYOUTS.SINGLE_PHASE || settings.layout === LAYOUTS.THREE_PHASE) {
    return { settings, fromConfig: false, notice: null };
  }
  const phases = Object.fromEntries(
    PHASE_SETTINGS.map(({ key }) => [key, asList(config?.[CONFIG_PHASE_KEYS[key]])]),
  );
  const assigned = Object.values(phases).some((ids) => ids.length > 0);
  if (config?.site_layout === LAYOUTS.THREE_PHASE && assigned) {
    return {
      settings: { ...settings, layout: LAYOUTS.THREE_PHASE, ...phases },
      fromConfig: true,
      notice: null,
    };
  }
  let notice = null;
  if (config?.site_layout === LAYOUTS.THREE_PHASE) {
    notice = LAYOUT_NOTICES.NO_PHASES;
  } else if (assigned) {
    notice = LAYOUT_NOTICES.PHASES_IGNORED;
  }
  return {
    settings: { ...settings, layout: LAYOUTS.SINGLE_PHASE },
    fromConfig: true,
    notice,
  };
}

/**
 * The batteries a site widget covers, from its settings. Single-phase: the
 * `devices` selected (none: every battery). Three-phase: the batteries of
 * `phase_l1`, `phase_l2` and `phase_l3`; a battery picked twice counts in
 * its first phase only (reported in `duplicates`), a battery picked nowhere
 * is left out (reported in `unassigned`). A picked device that no longer
 * exists (deleted, or no longer in the account) is counted in `missing`.
 * With the configuration given, a `from_config` widget (the default) takes
 * its layout and phases from it (effectiveSiteSettings).
 * @param {Array<object>} all every battery snapshot
 * @param {object} settings widget instance settings
 * @param {object} [config] normalized integration configuration
 * @returns {{ layout: string, batteries: Array<object>, phases: Array<{ label: string, batteries: Array<object> }>, missing: number, duplicates: Array<object>, unassigned: Array<object>, fromConfig: boolean, notice: string|null }}
 */
export function siteSelection(all, settings = {}, config = {}) {
  const effective = effectiveSiteSettings(settings, config);
  return {
    ...selectionOf(all, effective.settings),
    fromConfig: effective.fromConfig,
    notice: effective.notice,
  };
}

function selectionOf(all, settings) {
  const byId = new Map(all.map((battery) => [battery.externalId, battery]));
  let missing = 0;
  if (settings.layout !== LAYOUTS.THREE_PHASE) {
    const ids = [...new Set(asList(settings.devices))];
    const found = ids.map((id) => byId.get(id)).filter(Boolean);
    missing = ids.length - found.length;
    return {
      layout: LAYOUTS.SINGLE_PHASE,
      batteries: ids.length === 0 ? all : found,
      phases: [],
      missing,
      duplicates: [],
      unassigned: [],
    };
  }
  const seen = new Set();
  const duplicates = new Map();
  const phases = PHASE_SETTINGS.map(({ key, label }) => {
    const batteries = [];
    for (const id of asList(settings[key])) {
      const battery = byId.get(id);
      if (!battery) {
        missing += 1;
      } else if (seen.has(id)) {
        duplicates.set(id, battery);
      } else {
        seen.add(id);
        batteries.push(battery);
      }
    }
    return { label, batteries };
  });
  return {
    layout: LAYOUTS.THREE_PHASE,
    batteries: phases.flatMap((phase) => phase.batteries),
    phases,
    missing,
    duplicates: [...duplicates.values()],
    unassigned: all.filter((battery) => !seen.has(battery.externalId)),
  };
}

export const ASSIGN_PHASES = T(
  'Assign the batteries of each phase (L1, L2, L3) in the settings of this widget.',
  'Attribuez les batteries de chaque phase (L1, L2, L3) dans les réglages de ce widget.',
  'Ordne in den Einstellungen dieses Widgets die Batterien jeder Phase (L1, L2, L3) zu.',
  'Asigne las baterías de cada fase (L1, L2, L3) en los ajustes de este widget.',
);

export const ASSIGN_PHASES_IN_CONFIG = T(
  'None of the batteries of the phases (L1, L2, L3) set in the integration configuration was found: check them there.',
  "Aucune des batteries des phases (L1, L2, L3) de la configuration de l'intégration n'a été trouvée : vérifiez-les.",
  'Keine der Batterien der Phasen (L1, L2, L3) aus der Konfiguration der Integration wurde gefunden: Prüfe sie dort.',
  'No se encontró ninguna de las baterías de las fases (L1, L2, L3) de la configuración de la integración: revíselas.',
);

/**
 * The message a site widget shows when its selection holds no battery.
 * @param {ReturnType<typeof siteSelection>} selection
 */
export function emptySelectionMessage(selection) {
  if (selection.layout !== LAYOUTS.THREE_PHASE) {
    return NO_BATTERY;
  }
  return selection.fromConfig ? ASSIGN_PHASES_IN_CONFIG : ASSIGN_PHASES;
}

const NOTICE_ROWS = {
  [LAYOUT_NOTICES.NO_PHASES]: {
    label: T(
      'No phase assigned',
      'Aucune phase attribuée',
      'Keine Phase zugeordnet',
      'Ninguna fase asignada',
    ),
    icon: 'alert-triangle',
    value: T(
      'See the integration configuration',
      "Voir la configuration de l'intégration",
      'Siehe Konfiguration der Integration',
      'Ver la configuración de la integración',
    ),
    color: WIDGET_COLORS.WARNING,
  },
  [LAYOUT_NOTICES.PHASES_IGNORED]: {
    label: T('Phases ignored', 'Phases ignorées', 'Phasen ignoriert', 'Fases ignoradas'),
    icon: 'info',
    value: T(
      'The configuration is single-phase',
      'La configuration est en monophasé',
      'Die Konfiguration ist einphasig',
      'La configuración es monofásica',
    ),
    color: WIDGET_COLORS.INFO,
  },
};

/** The names of some batteries in one status value: `2: A, B`. */
export function namesOf(batteries) {
  return clip(`${batteries.length}: ${batteries.map((battery) => battery.name).join(', ')}`);
}

/**
 * Alert rows about the selection itself (layout of the configuration,
 * three-phase assignment, devices gone), shared by the site widgets.
 * @param {ReturnType<typeof siteSelection>} selection
 * @returns {Array<object>}
 */
export function selectionAlerts(selection) {
  const rows = [];
  if (selection.notice && NOTICE_ROWS[selection.notice]) {
    rows.push(NOTICE_ROWS[selection.notice]);
  }
  if (selection.missing > 0) {
    const n = selection.missing;
    rows.push({
      label: T('Not found', 'Introuvables', 'Nicht gefunden', 'No encontradas'),
      icon: 'alert-triangle',
      value: T(
        `${n} selected device(s)`,
        `${n} appareil(s) choisi(s)`,
        `${n} gewählte(s) Gerät(e)`,
        `${n} dispositivo(s) elegido(s)`,
      ),
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (selection.duplicates.length > 0) {
    rows.push({
      label: T(
        'In several phases',
        'Dans plusieurs phases',
        'In mehreren Phasen',
        'En varias fases',
      ),
      icon: 'copy',
      value: namesOf(selection.duplicates),
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (selection.unassigned.length > 0) {
    rows.push({
      label: T('In no phase', 'Dans aucune phase', 'In keiner Phase', 'En ninguna fase'),
      icon: 'help-circle',
      value: namesOf(selection.unassigned),
      color: WIDGET_COLORS.INFO,
    });
  }
  return rows;
}

// --- Local day of a timezone ---------------------------------------------------

// Gladys gives an integration no instance timezone: the "Energy today" widget
// takes one in its settings (IANA name), this one when empty or unknown.
export const DEFAULT_TIMEZONE = 'Europe/Paris';

/** The IANA timezone to use: the given one when valid, else DEFAULT_TIMEZONE. */
export function resolveTimezone(timeZone) {
  const name = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (name !== '') {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      // RangeError: not a timezone this Node.js knows.
    }
  }
  return DEFAULT_TIMEZONE;
}

/** Offset (ms) of a timezone at an instant: local wall clock minus UTC. */
function offsetAt(at, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The instant (ms) of the last local midnight of a timezone, DST-aware: the
 * offset is read at midnight itself, not now (a day with a clock change is
 * 23 or 25 hours long).
 * @param {number} now timestamp (ms)
 * @param {string} timeZone IANA timezone
 * @returns {number}
 */
export function startOfLocalDay(now, timeZone) {
  const local = new Date(now + offsetAt(now, timeZone));
  const midnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let midnight = midnightWall - offsetAt(now, timeZone);
  midnight = midnightWall - offsetAt(midnight, timeZone);
  return midnight;
}

/** `HH:MM` of an instant in a timezone. */
export function localTime(at, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
}
