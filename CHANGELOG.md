# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local API transport (zenSDK, the one Home Assistant's Zendure-HA uses): every
  SolarFlow is read through `GET http://<ip>/properties/report` every 5 s and
  driven through `POST /properties/write`, on by default (**Use the local API
  of the batteries**). The address comes from the Zendure cloud, else the mDNS
  name `zendure-<model>-<serial>.local`, else the new **Local API addresses**
  option (`SERIAL=IP` pairs). Per device the best source wins: local API, then
  local MQTT, then the Zendure cloud, with automatic fallback and return.
  The full report brings the settings (limits, AC mode, charge levels) and the
  pack list (stored energy) that the local MQTT feed lacked.
- Battery widget: remaining time of the current charge or discharge ("Full
  in" / "Empty in"), as the battery reports it (`remainInputTime` /
  `remainOutTime`, minutes, the 999 h "no estimate" value ignored) or computed
  from its capacity and charge levels like Zendure-HA does. The battery group
  shows it on each battery line.

### Changed

- The Zendure cloud MQTT broker is only connected while a device needs it:
  when every battery answers on its local API, it stays disconnected and no
  longer fights Home Assistant over the account's single cloud session.
- Scene and widget commands go through the local API when it serves the
  battery, with the same guards (clamping, smart mode, rate limit, unchanged
  values not re-sent, SoC scale).
- Widgets only show what a battery has: a device without a battery pack (a
  SolarFlow 800 used as a plain micro-inverter, known from `packNum` /
  `packData`) keeps its solar, home output and output limit, without level,
  charge figures, charge levels, AC mode, charge limit nor **Mode & levels**
  button; the battery group leaves it out of its average level and stored
  energy, and a group without any battery shows no battery figure (no 0 %).
  AC-coupled models (1600 AC+, 2400 AC, 2400 AC+) have no solar tile, unless
  they report solar power. While the presence of a pack is not known yet,
  every figure stays.
- The battery widget gauge shows its % unit.
- Transport badges, the battery widget source and the logs
  (`telemetry(local http): ...`) show the local API; the degraded badge tells
  when a battery's local API stopped answering. A battery whose local API
  never answered stays a plain cloud device.

### Fixed

- Local MQTT: the reported settings published on `Zendure/number|select|switch/<serial>/...`
  (outputLimit, inputLimit, socSet, minSoc, acMode...) are now read (command
  `/set` topics stay ignored), so the widget no longer shows them as "—".
- Widgets and controls read the fresh cloud report instead of the discovery
  snapshot when both carry a value.

## [1.5.0] - 2026-10-16

### Added

- Battery control from scenes (scene actions, Integrations category): output
  limit, AC charge limit, AC mode, charge target and discharge floor. Limits
  are clamped to the battery rating, power limits sent in smart mode (RAM,
  not flash), each setting rate limited (3 s for power, 30 s for mode and
  charge levels), unchanged values not re-sent, the SoC scale (percent or
  tenths) read from the battery's own report.
- Dashboard widgets: **Zendure battery** (live level and powers, source,
  stored energy, reported settings, forms to change the power limits, AC mode
  and charge levels) and **Battery group** (several batteries summed up under
  a name: one per phase on a three-phase site, or one for the whole site).
- Scene trigger **Battery reachability changed** (unreachable / reachable
  again, local MQTT mode), with the battery name, state and source.
- Energy features (kWh): charged, discharged, solar and home output energy,
  computed by integrating the powers (Zendure reports no energy counter) and
  saved under `/data` across restarts; a silence of more than 5 minutes is
  left out. The solar energy index feeds the Gladys energy production charts.
- Battery energy remaining (kWh): state of charge x capacity of the reported
  packs. Batteries created before pick up the new features with **Update** in
  the Discover tab.

### Changed

- Gladys Assistant 5.1.0 or later is required (scene actions and triggers).

## [1.4.0] - 2026-10-16

### Added

- **Feature names** option (en, fr, de, es): the language of the feature
  names given to newly discovered batteries. English stays the default; a
  battery already created keeps its names.
- An unsupported Zendure model is logged with its exact `productModel` string
  at each discovery, ready to be reported (documented in Troubleshooting).

## [1.3.1] - 2026-10-16

### Security

- `mqtt` 5.16.0: fixes six advisories reachable from a malicious or
  misbehaving broker (GHSA-c8jq-r765-cq7g, GHSA-rj8f-4655-cgg2,
  GHSA-gfxc-3w7m-8ch4, GHSA-fwrw-4mhv-wxvm, GHSA-8phv-jwjm-93rr,
  GHSA-h8jm-hm87-fqw3), several of which could crash the integration.
  A refused connection keeps being retried, as before: mqtt 5.16 stops
  retrying after a refusal unless asked to, which would have left a battery
  silent until a restart.

### Changed

- Development tools updated (ESLint 10.12, Prettier 3.9.10, globals 17.13,
  ws 8.22).

## [1.3.0] - 2026-10-16

### Added

- German and Spanish: the configuration screen (labels, descriptions, links),
  the catalog description, the connection status messages, the degraded badge
  tooltip and the user documentation (`docs/de.md`, `docs/es.md`) now ship in
  the four languages of Gladys (en, fr, de, es); a test keeps them complete.
- User documentation (en, fr, de, es): prerequisites (Gladys 4.86) and how to
  update the integration from the catalog (Update button, new configuration
  fields applied on their own) or in developer mode.
- Catalog category (Gladys 4.86+): the integration sits on the _Energy_ shelf
  of the integration catalog.
- Manifest tests: `version` matches `package.json`, `docker_image` is tagged
  with it, categories are known and coupled to Gladys 4.86, descriptions hold
  10 to 100 characters, config defaults match the code.
- `CHANGELOG.md`, rolled by the Release workflow.
- A GitHub Release for every version: its changelog section, then the notes
  GitHub generates (merged pull requests, full comparison). The Gladys
  Supervision page links each version to the repository's releases.
- CI runs the tests on Node 22 and 24, and builds the Docker image.
- Dependabot keeps the npm dependencies and the GitHub Actions up to date.
- `SECURITY.md` (how to report a vulnerability).

### Changed

- Gladys energy categories for every feature: battery level, charge and
  discharge power in **battery storage** (so a home battery no longer counts
  in the Gladys low-battery alerts and weekly digest), home output power in
  **home output sensor**, solar input power in **energy production sensor**.
  Batteries created before pick them up with **Update** in the Discover tab;
  their history is kept (same feature ids).
- The pack power features are named after what they measure: "Battery
  charge power" and "Battery discharge power". The zenSDK `packInputPower` is
  the pack discharge and `outputPackPower` its charge; the old names ("Battery
  input/output power") read the other way round.
- Gladys Assistant 4.86.0 or later is required: older releases reject the
  `categories` field.
- Integration SDK 0.15.0; the poll frequencies accepted by Gladys now come
  from the SDK.
- Node.js 22 or later is required (Node 20 is end-of-life).
- The Release workflow keeps the Prettier layout of the manifest (the 1.2.0
  bump had broken the format check), and refuses to release when the
  Unreleased section of this file lists no change.
- The configuration screen and the user documentation name the Gladys tabs and
  buttons by their real labels (Discover, Save configuration, Logs).
- The user documentation is no longer copied into the Docker image: the store
  re-hosts `docs/` and Gladys reads it from there.

- The `/data` volume belongs to the `node` user the integration runs as
  (nothing writes there yet, but a root-owned volume would refuse it).

### Security

- `ip-address` (a dependency of `mqtt`) updated to 10.7.4 (GHSA-mwp4-54f8-5fhr
  and related advisories).

## [1.2.0] - 2026-07-24

### Added

- **Degraded** transport badge: a locally reachable device served by the
  cloud fallback shows an orange dot with the reason, and the badge clears on
  its own once local telemetry resumes.
- User documentation (`docs/en.md`, `docs/fr.md`), linked from the
  Configuration screen, and a "Getting started" section on the form.
- The manifest declares the `local` and `cloud` transports (catalog tags).

### Changed

- Integration SDK 0.9.0.
- Adaptive publish pacing under the Gladys rate limit: ~2 s ticks when the
  core has headroom, slower only while it answers "Too Many Requests".
- Automatic cloud reconnections log at debug level; a take-over fight with
  another consumer of the same Zendure account is reported once.

### Fixed

- The echo of our own MQTT read requests no longer pollutes the telemetry
  cache nor keeps a dead device marked as alive
  ([#17](https://github.com/Terdious/gladys-zendure/issues/17)).
- An empty or invalid refresh interval falls back to 30 s instead of polling
  every second ([#18](https://github.com/Terdious/gladys-zendure/issues/18)).
- Zendure cloud requests time out after 15 s
  ([#19](https://github.com/Terdious/gladys-zendure/issues/19)).
- No cached value is republished while its broker is disconnected.

## [1.1.0] - 2026-07-21

### Added

- Optional local MQTT (zenSDK), with a per-device cloud fallback, automatic
  return to local, live transport badges and a telemetry watchdog in the logs.
- SolarFlow 800, 1600 AC+, 2400 AC+, 2400 AC, 2400 Pro and (experimental)
  Hyper 2000 models.
- Connection status on the Configuration screen.

### Changed

- Integration SDK 0.5.0.

## [1.0.1] - 2026-07-19

### Added

- First release: SolarFlow 800 Pro discovery through the Zendure cloud,
  read-only telemetry (battery level, battery input and output power, home
  output power, solar input power), polling and real-time MQTT push.

[Unreleased]: https://github.com/Terdious/gladys-zendure/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Terdious/gladys-zendure/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Terdious/gladys-zendure/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Terdious/gladys-zendure/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Terdious/gladys-zendure/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-zendure/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Terdious/gladys-zendure/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Terdious/gladys-zendure/releases/tag/v1.0.1
