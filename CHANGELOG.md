# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.10.0] - 2026-10-19

### Added

- Scene trigger **Battery alert** (#43): starts a scene when a status code of
  a battery starts or ends — fault (`is_error`, or `faultLevel` above 0),
  heating (`heatState`), calibration (`socStatus`), low temperature
  (`lowTemperature`), reverse flow (`reverseState`) — filtered by battery,
  alert and change (started / ended). A new state must hold 30 seconds over
  two reports; the state at startup, deleted batteries and pack devices never
  fire it. Its variables give the battery name, the alert, the change, the
  reported code and the telemetry source.

## [1.9.0] - 2026-10-19

### Added

- **Battery packs as separate devices** (#16), opt-in (new option, off by
  default): the Discover tab also lists one device per battery pack, named
  `<battery name> — pack <n>`, identified by the pack serial in its own
  namespace (`solarflow-pack:<serial>`: the battery's device and features are
  unchanged). Each pack has its level (`battery` / `integer`, %, so the home
  battery level the Gladys energy dashboards aggregate is not counted twice),
  its hottest cell temperature (`device-temperature-sensor`, °C), its voltage,
  signed current and power (`energy-sensor` / `voltage`, `current`, `power`).
  Values from the pack list of the local API, cloud and legacy local reports
  (raw: hundredths of a volt, signed tenths of an ampere, tenths of a kelvin)
  or from the packs' native local topics `Zendure/sensor/<pack serial>/…`
  (already scaled), through the same paced channel. Turning the option off
  creates nothing new and deletes nothing (the pack devices already created
  stay and stop updating). A deleted pack device is ignored like a deleted
  battery.
- The local broker's legacy JSON reports keep their `packData` (pack list and
  hottest pack temperature on the local MQTT path too).

- **Remaining discharge time** (`remainOutTime`) and **Remaining charge
  time** (`remainInputTime`) as features (`duration`, minutes), as the battery
  estimates them, on every model. The "no estimate" value (999 h, idle
  battery) is never published, so the feature keeps its last estimate instead
  of reading 0 ("empty now") or flattening the charts; a SolarFlow 800 or
  Hyper 2000 reporting no pack publishes nothing. Batteries created before get
  them with **Update** in the Discover tab; the existing features and their
  ids are unchanged.

### Fixed

- A battery **deleted in Gladys** is no longer tracked (#21): its local API
  polling stops, its broker topics are unsubscribed, its effective source and
  cloud need are dropped, and the sources are re-evaluated at once, so a
  deleted battery never keeps the Zendure cloud fallback connected (the cloud
  broker is released right away when no remaining battery needs it). It also
  leaves the watchdog, the dashboard widgets, the scene actions and the
  diagnostic, which lists the ignored batteries once; the logs say
  `N device(s) ignored (deleted in Gladys): …`. The list is saved in a free
  key of the integration configuration (`ignored_devices`, not shown in the
  form), so it survives restarts and updates. The discovery keeps listing the
  battery: creating it again from the Discover tab tracks it again at once,
  without a restart, and re-sends its values immediately.

## [1.8.0] - 2026-10-18

### Added

- New models, **untested hardware** (ratings from Zendure-HA, reports
  welcome): SolarFlow 800 Plus (charge 1000 W / discharge 800 W, solar input),
  SolarFlow 800 Pro 2 (800 Pro class, built-in battery, off-grid output) and
  SolarFlow 4000 AC+ (charge 3200 W / discharge 2400 W, AC-coupled, internal
  8 kWh pack, off-grid output).
- **Off-grid output power** (`home-output-sensor` / `off-grid-power`, W,
  `gridOffPower`, negative values shown as 0) and its computed **Off-grid
  output energy** index (`off-grid-index`, kWh) on the models with an
  off-grid socket: 800 Pro, 800 Pro 2, 1600 AC+, 2400 AC, 2400 AC+, 2400 Pro,
  4000 AC+.
- **Grid charging power** (`grid-sensor` / `input-power`, W,
  `gridInputPower`) and its computed **Grid charging energy** index
  (`input-index`, kWh) on every model. The documentation explains where to
  place the battery in the Gladys energy hierarchy (under the main meter) to
  avoid counting that energy twice.
- **Device temperature** (`hyperTmp`) and **Hottest pack temperature** (the
  highest pack `maxTemp`), `device-temperature-sensor`, °C, converted from
  decikelvin, published only when reported, impossible values ignored.
- The new indexes are saved in `/data/energy.json` with the others (additive:
  a 1.7.0 file loads as is, its "Energy today" snapshots unchanged).
- Batteries created before get the new features with **Update** in the
  Discover tab; the existing features and their ids are unchanged.
- **Diagnostic of the batteries**: firmware versions (device, master, DSP,
  packs), Wi-Fi signal (`rssi`, hint below -75 dBm), `wifiState` /
  `localState`, the raw status codes (`heatState`, `lowTemperature`,
  `socStatus`, `socLimit`, `pass`, `hemsState`, `faultLevel`, `hyperTmp`)
  with their meaning, and per pack its level, hottest temperature, voltage,
  current and state of health. Serial numbers stay masked.
- **Savings estimate, without a grid meter**: a new optional section of the
  configuration takes the electricity tariff (`tariff_mode`: none by default,
  base or peak / off-peak; `price_base`, `price_peak`, `price_offpeak`,
  `offpeak_hours` such as `22:00-06:00` or `01:30-07:30,12:30-14:30`,
  `resale_enabled` and `resale_price`, `tariff_timezone`, `Europe/Paris` by
  default). Every 30 minutes and per battery, the energy sent to the home is
  assumed consumed by the house and valued at the price of the slot, minus the
  weighted-average cost of the stored energy (grid charging at its price,
  solar charging at the resale price or free). Invalid off-peak hours or a
  missing price turn the estimate off, logged once and shown in the
  diagnostic.
- The **Energy today** widget shows it when a tariff is set (new setting
  **Show the savings (estimate)**, on by default): savings today, this month
  and this year, today per phase in three-phase, and today's breakdown
  (battery time-shift, direct solar, grid charging paid, export), marked as
  an estimate. The export and resale rows wait for the grid meter (coming,
  with Gladys changes #3229 and #3230, announced in the configuration).
- The savings (current and previous day, month and year, in the tariff
  timezone) are saved in `/data/energy.json` with the meters (additive: a
  1.7.0 file loads as is, an older release ignores them).

### Changed

- The cloud model name is matched ignoring case and every space, like
  Zendure-HA (`SolarFlow800Pro` = `SolarFlow 800 Pro`); every name matched
  before still matches.

## [1.7.0] - 2026-10-17

### Added

- **Zendure site** widget: the whole installation on one card, with an
  **Electrical layout** setting. Single-phase sums the selected batteries
  (none: all); three-phase takes the batteries ticked in the **Phase L1**,
  **L2** and **L3** lists and adds one line per phase (home output, charge,
  discharge, solar) and a **Phase balance** line (gap between the highest and
  the lowest home output, in warning past the **Phase imbalance alert**
  setting, 500 W by default). Both show the site totals (capacity-weighted
  state of charge, powers, stored energy), stored energy over the known
  capacity, the site's time left at the current power, the batteries per
  source (local, cloud, unreachable) and alert lines (unreachable, cloud
  fallback, a battery in two phases, in none, or deleted). Batteries without a
  pack and AC-coupled models follow the 1.6.0 rules; an unreachable battery's
  stale powers are left out of the sums.
- **Energy today** widget: charged, discharged, solar and home output energy
  since local midnight, per site or per phase (same layout and phase
  settings), the gap between the phases, and a chart of the home output per
  30 minutes. The day starts at the midnight of the widget's **Timezone**
  setting (IANA name, `Europe/Paris` by default; Gladys gives no timezone to
  an integration), DST-aware. The energy counters now keep a snapshot of their
  totals every 30 minutes for 26 hours, saved atomically in
  `/data/energy.json` with the totals (additive: 1.6.0 reads the file as
  before); an interval crossing a slot boundary is split there.

## [1.6.0] - 2026-10-17

### Added

- Local API transport (zenSDK, the one Home Assistant's Zendure-HA uses): every
  SolarFlow is read through `GET http://<ip>/properties/report` every 5 s and
  driven through `POST /properties/write`, on by default (**Use the local API
  of the batteries**). The address comes from the Zendure cloud, else the mDNS
  name `zendure-<model>-<serial>.local`, else the new **Local API addresses**
  option (`SERIAL=IP` pairs, spaces around `=` and the case of the serial
  ignored, unused pairs logged). An address the cloud changes is picked up
  by the next scan. Per device the best source wins: local API, then local
  MQTT, then the Zendure cloud, with automatic fallback and return; the cloud
  only takes over after 90 s without an answer, and at startup a battery has
  the same 90 s for its first answer (unless it already missed three
  requests), so a Wi-Fi blip or a slow first answer stays local.
  The full report brings the settings (limits, AC mode, charge levels) and the
  pack list (stored energy) that the local MQTT feed lacked.
- Battery widget: remaining time of the current charge or discharge ("Full
  in" / "Empty in"), as the battery reports it (`remainInputTime` /
  `remainOutTime`, minutes, the 999 h "no estimate" value ignored) or computed
  from its capacity and charge levels like Zendure-HA does. The battery group
  shows it on each battery line.

- Two read-only diagnostic buttons on the Configuration screen, to paste into
  a GitHub issue. **Diagnostic of the batteries** reports the whole
  installation: version, configuration (never the cloud key), Zendure cloud
  API, each broker (connected, reconnections over the last 5 minutes, cloud
  idle because everything is local, take-over warnings), the local API
  polling, then per battery its source and why, the age of its last data per
  source, its local API address, origin and state, packs, solar input,
  reported settings, remaining time and energy counters; optionally for one
  battery, picked in the list of the batteries created in Gladys (or typed by
  name or serial number for one that is not). **Test the local API of a
  battery** reads its
  `GET /properties/report` once, now, and shows the timing, the address origin
  and the properties, or the exact error with a hint. Serial numbers are
  shortened and local addresses hidden unless **Show serial numbers and local
  addresses** is checked; keys and passwords never appear. Both reports are
  also logged, masked.

### Changed

- The Zendure cloud MQTT broker is only connected while a device needs it:
  when every battery answers on its local API, it stays disconnected and no
  longer fights Home Assistant over the account's single cloud session. Once
  connected for a fallback, it is kept 5 minutes after the last battery that
  needed it (instead of about a minute), so a battery that blinks does not
  take the session and give it back each time.
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

- Battery group widget: past 10 batteries, the last row tells how many are
  not listed ("+3 more") instead of the extra ones being silently dropped.
- Energy totals: two saves at once (the periodic save, the push cleanup and
  the shutdown hook) shared one temporary file, so the second failed with
  `could not save /data/energy.json (ENOENT ... rename ...)`. Saves are now
  serialized, each with its own temporary file, and an update landing during
  a save is kept for the next one.
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

[Unreleased]: https://github.com/Terdious/gladys-zendure/compare/v1.10.0...HEAD
[1.10.0]: https://github.com/Terdious/gladys-zendure/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/Terdious/gladys-zendure/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Terdious/gladys-zendure/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Terdious/gladys-zendure/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Terdious/gladys-zendure/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Terdious/gladys-zendure/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Terdious/gladys-zendure/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Terdious/gladys-zendure/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Terdious/gladys-zendure/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-zendure/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Terdious/gladys-zendure/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Terdious/gladys-zendure/releases/tag/v1.0.1
