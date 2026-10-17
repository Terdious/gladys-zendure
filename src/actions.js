// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the integration Configuration screen.
//
// Each key is declared in the manifest `actions` field and registered by
// index.js with `gladys.onAction(key, ...)`. Both are read-only diagnostics
// (src/diagnostic.js): they observe the installation, never write to a
// battery nor change its transport. The report is returned under the button,
// with a short intro in the user's language, and logged at INFO, always in
// its masked form.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { describeDiagnostics, testLocalApi } from './devices/index.js';
import { decodeCloudKey } from './zendure/client.js';
import { buildFleetDiagnostic, buildLocalApiTestReport } from './diagnostic.js';

const logger = createLogger({ name: 'diagnostic' });

// Intro of a report, in every Gladys language: what to do with it.
export const REPORT_INTROS = {
  masked: {
    en: 'Report below (also in the integration logs). Copy it as is into a GitHub issue: serial numbers are shortened, local addresses hidden, and it never contains the cloud key nor any password.',
    fr: "Rapport ci-dessous (aussi dans les journaux de l'intégration). Copiez-le tel quel dans une issue GitHub : les numéros de série sont raccourcis, les adresses locales masquées, et il ne contient jamais la clé cloud ni aucun mot de passe.",
    de: 'Bericht unten (auch in den Protokollen der Integration). Kopiere ihn unverändert in ein GitHub-Issue: Seriennummern sind gekürzt, lokale Adressen verborgen, und er enthält nie den Cloud-Schlüssel oder ein Passwort.',
    es: 'Informe a continuación (también en los registros de la integración). Cópielo tal cual en una issue de GitHub: los números de serie están acortados, las direcciones locales ocultas, y nunca contiene la clave de la nube ni ninguna contraseña.',
  },
  full: {
    en: 'Report below, WITH the full serial numbers and local addresses: do not post it publicly (the logs only keep the masked version). It never contains the cloud key nor any password.',
    fr: "Rapport ci-dessous, AVEC les numéros de série et adresses locales complets : ne le publiez pas (les journaux n'en gardent que la version masquée). Il ne contient jamais la clé cloud ni aucun mot de passe.",
    de: 'Bericht unten, MIT vollständigen Seriennummern und lokalen Adressen: nicht öffentlich posten (die Protokolle behalten nur die maskierte Fassung). Er enthält nie den Cloud-Schlüssel oder ein Passwort.',
    es: 'Informe a continuación, CON los números de serie y direcciones locales completos: no lo publique (los registros solo guardan la versión ocultada). Nunca contiene la clave de la nube ni ninguna contraseña.',
  },
};

export const DEVICE_REQUIRED_MESSAGE = {
  en: 'Type the name or the serial number of a battery.',
  fr: "Saisissez le nom ou le numéro de série d'une batterie.",
  de: 'Gib den Namen oder die Seriennummer einer Batterie ein.',
  es: 'Escriba el nombre o el número de serie de una batería.',
};

/** A form boolean: true, or "true" / "1" / "yes" / "on". */
function isChecked(value) {
  return value === true || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** The cloud key and its app key, scrubbed from an error report. */
function secretsOfKey(cloudKey) {
  try {
    return [cloudKey, decodeCloudKey(cloudKey).appKey];
  } catch {
    return [cloudKey];
  }
}

/** The action result: the localized intro, then the (English) report. */
function withIntro(report, includeIdentifiers) {
  const intro = REPORT_INTROS[includeIdentifiers ? 'full' : 'masked'];
  return Object.fromEntries(
    Object.entries(intro).map(([language, text]) => [language, `${text}\n\n${report}`]),
  );
}

export const ACTIONS = {
  async fleet_diagnostic(gladys, { fields = {}, config }) {
    const includeIdentifiers = isChecked(fields.include_identifiers);
    const filter = String(fields.device ?? '').trim();
    logger.info(
      `Action fleet_diagnostic <- ${filter ? 'one battery filter' : 'every battery'}, ` +
        `identifiers ${includeIdentifiers ? 'shown' : 'masked'}`,
    );
    const snapshot = await describeDiagnostics(gladys, config, { filter });
    const masked = buildFleetDiagnostic(snapshot, { includeIdentifiers: false });
    // The logs keep the masked version only: they get shared too.
    logger.info(`[diagnostic]\n${masked}`);
    const report = includeIdentifiers
      ? buildFleetDiagnostic(snapshot, { includeIdentifiers: true })
      : masked;
    return withIntro(report, includeIdentifiers);
  },

  async test_local_api(gladys, { fields = {}, config }) {
    const reference = String(fields.device ?? '').trim();
    if (reference === '') {
      throw new Error(DEVICE_REQUIRED_MESSAGE.en);
    }
    const includeIdentifiers = isChecked(fields.include_identifiers);
    logger.info(`Action test_local_api <- identifiers ${includeIdentifiers ? 'shown' : 'masked'}`);
    let outcome;
    try {
      outcome = await testLocalApi(gladys, config, reference);
    } catch (e) {
      // No device list (missing or invalid key, cloud down): the address of
      // the battery comes from it.
      outcome = { cloudError: e.message || String(e), secrets: secretsOfKey(config.cloud_key) };
    }
    const now = Date.now();
    const masked = buildLocalApiTestReport(outcome, { includeIdentifiers: false, now });
    logger.info(`[diagnostic]\n${masked}`);
    const report = includeIdentifiers
      ? buildLocalApiTestReport(outcome, { includeIdentifiers: true, now })
      : masked;
    return withIntro(report, includeIdentifiers);
  },
};
