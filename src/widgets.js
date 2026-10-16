// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
//   - `battery`: one battery — state of charge gauge and live power tiles
//     (bound to the device features, they follow the published states), its
//     source and settings, and two buttons opening a form to change them.
//   - `battery_group`: several batteries summed up under a name of your
//     choice. One instance per group: a three-phase installation adds one per
//     phase (L1, L2, L3), and one more without battery selected for the whole
//     site; a single-phase installation needs just one.
//
// index.js registers `get` with onWidgetGet and `action` with
// onWidgetAction. The content budget of the core (8 components, 6 tiles,
// 1 status, 4 buttons) decides what each widget shows.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { controlDevice, describeBatteries } from './devices/index.js';
import { AC_MODES, MIN_SOC_RANGE, SOC_SET_RANGE } from './zendure/control.js';

const logger = createLogger({ name: 'widgets' });

export const BATTERY_WIDGET = 'battery';
export const GROUP_WIDGET = 'battery_group';

// Keys of the button actions of the battery widget.
export const BATTERY_ACTIONS = { POWER_LIMITS: 'power_limits', MODE_AND_LEVELS: 'mode_and_levels' };

const T = (en, fr, de, es) => ({ en, fr, de, es });

const SOURCE_STATUS = {
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

const AC_MODE_TEXT = {
  [AC_MODES.charge]: T('Charge', 'Charge', 'Laden', 'Carga'),
  [AC_MODES.discharge]: T('Discharge', 'Décharge', 'Entladen', 'Descarga'),
};

const UNKNOWN = '—';

function sourceStatus(battery) {
  return SOURCE_STATUS[battery.degraded ? 'degraded' : battery.source];
}

function withUnit(value, unit) {
  return value === null || value === undefined ? UNKNOWN : `${value} ${unit}`;
}

function sum(batteries, pick) {
  const values = batteries.map(pick).filter((value) => value !== null && value !== undefined);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

/** Text-only content, when the widget cannot show a battery. */
function messageContent(text) {
  return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text }] };
}

const CHOOSE_BATTERY = T(
  'Choose a battery in the settings of this widget.',
  'Choisissez une batterie dans les réglages de ce widget.',
  'Wähle in den Einstellungen dieses Widgets eine Batterie.',
  'Elija una batería en los ajustes de este widget.',
);

const NO_BATTERY = T(
  'No Zendure battery found: check the Configuration tab of the integration.',
  "Aucune batterie Zendure trouvée : vérifiez l'onglet Configuration de l'intégration.",
  'Keine Zendure-Batterie gefunden: Prüfe den Tab Konfiguration der Integration.',
  'No se encontró ninguna batería Zendure: revise la pestaña Configuración de la integración.',
);

function batteryContent(battery) {
  const feature = battery.featureExternalId;
  const { settings } = battery;
  const levels =
    settings.socSet === null && settings.minSoc === null
      ? UNKNOWN
      : `${settings.minSoc ?? UNKNOWN} – ${settings.socSet ?? UNKNOWN} %`;
  return {
    // The tiles are live; the status rows only change with the reports.
    ttl_seconds: 30,
    components: [
      {
        type: 'gauge',
        device_feature: feature('batteryLevel'),
        label: T('Battery', 'Batterie', 'Batterie', 'Batería'),
        color: WIDGET_COLORS.SUCCESS,
      },
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
      {
        type: 'value',
        device_feature: feature('solarInputPower'),
        label: T('Solar', 'Solaire', 'Solar', 'Solar'),
        icon: 'sun',
      },
      {
        type: 'value',
        device_feature: feature('homeOutputPower'),
        label: T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'),
        icon: 'home',
      },
      {
        type: 'status',
        items: [
          {
            label: T('Source', 'Source', 'Quelle', 'Fuente'),
            icon: 'wifi',
            ...sourceStatus(battery),
          },
          {
            label: T(
              'Energy stored',
              'Énergie stockée',
              'Gespeicherte Energie',
              'Energía almacenada',
            ),
            icon: 'battery',
            value:
              battery.remainingKwh === null
                ? UNKNOWN
                : `${battery.remainingKwh} / ${battery.capacityKwh} kWh`,
            color: WIDGET_COLORS.NEUTRAL,
          },
          {
            label: T('Output limit', 'Limite de sortie', 'Ausgangslimit', 'Límite de salida'),
            icon: 'arrow-up-right',
            value: withUnit(settings.outputLimit, 'W'),
            color: WIDGET_COLORS.NEUTRAL,
          },
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
        ],
      },
      {
        type: 'button',
        label: T('Power limits', 'Limites de puissance', 'Leistungslimits', 'Límites de potencia'),
        icon: 'sliders',
        style: 'secondary',
        action: {
          key: BATTERY_ACTIONS.POWER_LIMITS,
          params: { device: battery.externalId },
          fields: [
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
            {
              key: 'input_limit',
              type: 'number',
              label: T(
                'Charge limit (W)',
                'Limite de charge (W)',
                'Ladelimit (W)',
                'Límite de carga (W)',
              ),
              min: 0,
              max: 3200,
              ...(settings.inputLimit !== null ? { default: settings.inputLimit } : {}),
            },
          ],
        },
      },
      {
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
      },
    ],
  };
}

function groupContent(title, batteries) {
  // Capacity-weighted state of charge when every pack is known, plain
  // average otherwise.
  const withLevel = batteries.filter((battery) => battery.values.batteryLevel !== null);
  const weighted = withLevel.every((battery) => battery.capacityKwh !== null);
  const weight = (battery) => (weighted ? battery.capacityKwh : 1);
  const totalWeight = withLevel.reduce((total, battery) => total + weight(battery), 0);
  const level =
    totalWeight > 0
      ? Math.round(
          withLevel.reduce(
            (total, battery) => total + battery.values.batteryLevel * weight(battery),
            0,
          ) / totalWeight,
        )
      : null;
  const power = (key) => sum(batteries, (battery) => battery.values[key]);
  const tile = (key, label, icon) => ({
    type: 'value',
    value: power(key) ?? UNKNOWN,
    unit: 'W',
    label,
    icon,
  });
  const stored = sum(batteries, (battery) => battery.remainingKwh);

  return {
    // Computed sums: refreshed by the TTL.
    ttl_seconds: 30,
    components: [
      { type: 'text', variant: 'heading', text: title },
      {
        type: 'gauge',
        value: level ?? 0,
        min: 0,
        max: 100,
        unit: '%',
        label: T('Battery', 'Batterie', 'Batterie', 'Batería'),
        color: level === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.SUCCESS,
      },
      tile('batteryOutputPower', T('Charging', 'Charge', 'Laden', 'Carga'), 'battery-charging'),
      tile('batteryInputPower', T('Discharging', 'Décharge', 'Entladen', 'Descarga'), 'zap'),
      tile('solarInputPower', T('Solar', 'Solaire', 'Solar', 'Solar'), 'sun'),
      tile('homeOutputPower', T('To the home', 'Vers la maison', 'Zum Haus', 'Al hogar'), 'home'),
      {
        type: 'value',
        value: stored === null ? UNKNOWN : Math.round(stored * 100) / 100,
        unit: 'kWh',
        label: T('Stored', 'Stockée', 'Gespeichert', 'Almacenada'),
        icon: 'battery',
      },
      {
        type: 'status',
        items: batteries.slice(0, 10).map((battery) => ({
          label: battery.name.slice(0, 40),
          icon: 'battery',
          value:
            battery.values.batteryLevel === null ? UNKNOWN : `${battery.values.batteryLevel} %`,
          color: sourceStatus(battery).color,
        })),
      },
    ],
  };
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
    async get(gladys, { settings, config }) {
      const all = await describeBatteries(gladys, config);
      const selected = Array.isArray(settings?.devices) ? settings.devices : [];
      const batteries =
        selected.length === 0
          ? all
          : all.filter((battery) => selected.includes(battery.externalId));
      if (batteries.length === 0) {
        return messageContent(NO_BATTERY);
      }
      const title = settings?.title?.trim() || T('Batteries', 'Batteries', 'Batterien', 'Baterías');
      return groupContent(title, batteries);
    },
  },
};
