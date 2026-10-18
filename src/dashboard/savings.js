// -----------------------------------------------------------------------------
// The savings part of the `energy_today` widget: an ESTIMATE without a grid
// meter (src/zendure/savings.js), summed over the batteries of the widget.
//
// One tile (savings today) and a few status rows: this month and this year,
// today per phase (three-phase), the breakdown of today (battery time-shift,
// direct solar, grid charging paid, export), within the room the other rows
// leave (MAX_STATUS_ROWS). The days follow the tariff timezone.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { sumAccumulators } from '../zendure/savings.js';
import { T } from './common.js';

const money = (value) => (Math.round(value * 100) / 100).toFixed(2);
const kwh = (value) => Math.round(value * 100) / 100;

export const SAVINGS_LABELS = {
  tile: T(
    'Saved today (estimate)',
    'Économie du jour (est.)',
    'Heute gespart (Schätz.)',
    'Ahorro hoy (estimación)',
  ),
  summary: T(
    'Savings (estimate)',
    'Économies (estimation)',
    'Ersparnis (Schätzung)',
    'Ahorro (estimación)',
  ),
  phases: T(
    'Today L1 · L2 · L3',
    "Aujourd'hui L1 · L2 · L3",
    'Heute L1 · L2 · L3',
    'Hoy L1 · L2 · L3',
  ),
  battery: T(
    'Battery time-shift',
    'Décalage batterie',
    'Batterie-Verschiebung',
    'Desplazamiento batería',
  ),
  solar: T('Direct solar', 'Solaire direct', 'Solar direkt', 'Solar directo'),
  grid: T(
    'Grid charging (paid)',
    'Recharge réseau (payée)',
    'Netzladung (bezahlt)',
    'Carga de red (pagada)',
  ),
  resale: T('Resale', 'Revente', 'Einspeisung', 'Reventa'),
  loss: T(
    'Exported, not valued',
    'Injecté, non valorisé',
    'Eingespeist, unbewertet',
    'Inyectado, sin valorar',
  ),
};

const INVALID_TARIFF = T(
  'Tariff invalid: see the logs',
  'Tarif invalide : voir les journaux',
  'Tarif ungültig: siehe Protokoll',
  'Tarifa no válida: ver registros',
);

/**
 * The savings of some batteries now, summed: null when none has a report
 * (no tariff, meters not loaded).
 * @param {Array<object>} batteries battery snapshots (`savingsAt(now)`)
 * @param {number} now timestamp (ms)
 */
export function savingsOf(batteries, now) {
  const reports = batteries
    .map((battery) => (typeof battery.savingsAt === 'function' ? battery.savingsAt(now) : null))
    .filter(Boolean);
  if (reports.length === 0) {
    return null;
  }
  const sum = (period) => sumAccumulators(reports.map((report) => report[period]));
  return {
    today: sum('today'),
    month: sum('month'),
    year: sum('year'),
    yesterday: sum('yesterday'),
    previousMonth: sum('previousMonth'),
    previousYear: sum('previousYear'),
  };
}

const amountAndEnergy = (amount, energy) => `${money(amount)} € · ${kwh(energy)} kWh`;

/**
 * Tile and rows of the savings, or nothing.
 * @param {ReturnType<typeof import('./common.js').siteSelection>} selection
 * @param {{ now: number, tariff: object|null, tariffError: string|null }} options
 * @returns {{ tiles: Array<object>, rows: Array<object> }} rows most important first
 */
export function savingsComponents(selection, { now, tariff, tariffError }) {
  if (!tariff) {
    return tariffError
      ? {
          tiles: [],
          rows: [
            {
              label: SAVINGS_LABELS.summary,
              icon: 'alert-triangle',
              value: INVALID_TARIFF,
              color: WIDGET_COLORS.WARNING,
            },
          ],
        }
      : { tiles: [], rows: [] };
  }
  const site = savingsOf(selection.batteries, now);
  if (!site) {
    return { tiles: [], rows: [] };
  }
  const { today, month, year } = site;
  const tiles = [
    {
      type: 'value',
      value: Math.round(today.savings * 100) / 100,
      unit: '€',
      label: SAVINGS_LABELS.tile,
      icon: 'trending-up',
    },
  ];
  const rows = [
    {
      label: SAVINGS_LABELS.summary,
      icon: 'trending-up',
      value: T(
        `Month ${money(month.savings)} € · Year ${money(year.savings)} €`,
        `Mois ${money(month.savings)} € · Année ${money(year.savings)} €`,
        `Monat ${money(month.savings)} € · Jahr ${money(year.savings)} €`,
        `Mes ${money(month.savings)} € · Año ${money(year.savings)} €`,
      ),
      color: WIDGET_COLORS.INFO,
    },
  ];
  if (selection.layout === 'three_phase') {
    rows.push({
      label: SAVINGS_LABELS.phases,
      icon: 'git-commit',
      value: selection.phases
        .map((phase) => {
          const phaseSavings = phase.batteries.length > 0 ? savingsOf(phase.batteries, now) : null;
          return phaseSavings ? `${money(phaseSavings.today.savings)} €` : '—';
        })
        .join(' · '),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  rows.push({
    label: SAVINGS_LABELS.battery,
    icon: 'battery-charging',
    value: amountAndEnergy(today.batteryGain, today.batteryKwh),
    color: WIDGET_COLORS.NEUTRAL,
  });
  if (selection.batteries.some((battery) => battery.hasSolar)) {
    rows.push({
      label: SAVINGS_LABELS.solar,
      icon: 'sun',
      value: amountAndEnergy(today.solarGain, today.solarKwh),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  rows.push({
    label: SAVINGS_LABELS.grid,
    icon: 'zap',
    value: amountAndEnergy(today.gridCost, today.gridChargedKwh),
    color: WIDGET_COLORS.NEUTRAL,
  });
  // Export: known with the grid meter only (coming), 0 until then.
  const known = today.exportedKwh > 0;
  rows.push(
    tariff.resaleEnabled
      ? {
          label: SAVINGS_LABELS.resale,
          icon: 'upload',
          value: known
            ? amountAndEnergy(today.resaleRevenue, today.exportedKwh)
            : T(
                'Needs the grid meter (soon)',
                'Compteur réseau requis (bientôt)',
                'Netzzähler nötig (demnächst)',
                'Requiere contador de red (pronto)',
              ),
          color: WIDGET_COLORS.INFO,
        }
      : {
          label: SAVINGS_LABELS.loss,
          icon: 'upload',
          value: known
            ? `${kwh(today.lossKwh)} kWh`
            : T(
                '0 kWh: grid meter (soon)',
                '0 kWh : compteur réseau (bientôt)',
                '0 kWh: Netzzähler (demnächst)',
                '0 kWh: contador de red (pronto)',
              ),
          color: WIDGET_COLORS.INFO,
        },
  );
  return { tiles, rows };
}
