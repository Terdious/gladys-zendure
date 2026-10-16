# Zendure for Gladys Assistant

Connect your **Zendure SolarFlow / Hyper** solar batteries to Gladys Assistant.
Gathers read-only telemetry (battery level, charge/discharge power, home output
and solar production) from the Zendure cloud, and — optionally — directly from
each device's **local MQTT broker** for LAN-speed, offline-resilient updates
with automatic cloud fallback.

## Prerequisites

- A **Zendure account**, with your batteries already set up and online in the
  Zendure app.
- Gladys Assistant **5.1 or later**.

## Supported models

SolarFlow 800, SolarFlow 800 Pro, SolarFlow 1600, SolarFlow 2400,
SolarFlow 2400 AC, SolarFlow 2400 Pro, and Hyper 2000 (experimental — telemetry
mapping to be confirmed by a community tester).

## Features

Each battery is created with ten read-only features, in the Gladys energy
categories (energy charts, history, dashboards):

| Feature                   | Gladys category          | Unit |
| ------------------------- | ------------------------ | ---- |
| Battery level             | Battery storage          | %    |
| Battery charge power      | Battery storage          | W    |
| Battery discharge power   | Battery storage          | W    |
| Home output power         | Home output sensor       | W    |
| Solar input power         | Energy production sensor | W    |
| Battery charged energy    | Battery storage          | kWh  |
| Battery discharged energy | Battery storage          | kWh  |
| Home output energy        | Home output sensor       | kWh  |
| Solar energy              | Energy production sensor | kWh  |
| Battery energy remaining  | Battery storage          | kWh  |

Zendure reports powers only: the four **energy** features (kWh) are computed
by the integration, which adds up each power over time. They are cumulative
indexes, saved in the integration's data volume so a restart does not reset
them; a silence of more than 5 minutes (battery offline, broker down) is left
out instead of being guessed. Gladys turns the **solar energy** index into
its energy production charts. The **energy remaining** is the state of charge
times the capacity of the packs the battery reports (AB1000, AB2000, AB3000,
built-in packs); it stays empty until the battery sends its pack list.

Since version 1.3.0 the battery level is a **battery storage** level, not the
battery of a device to replace: Gladys no longer counts your home battery in
its low-battery alerts. A battery created with an older version keeps its
previous categories until you apply the new definition: in the **Discover**
tab, click **Update** on the battery (marked **Already added**). The features
are updated in place, so their history, scenes and dashboards are kept. The
same **Update** adds the energy features to a battery created before version
1.5.0.

## Getting your Zendure cloud key

The integration authenticates against the Zendure cloud with an **authorization
key** (a base64 token) that you generate once from the Zendure mobile app:

1. Open the **Zendure** mobile app and sign in with your account.
2. Go to the developer / Home Assistant integration section of the app and
   generate (or copy) your **authorization key** (also called the "HA key").
3. Copy that key.

> The key is a secret tied to your Zendure account: keep it private. Gladys
> stores it encrypted and never logs it.

## Configuration

1. Open the **Configuration** tab of the integration in Gladys.
2. Paste your key into **Zendure cloud authorization key**.
3. Set the **Refresh interval** (seconds) — how often the telemetry is refreshed
   when no real-time update is flowing. The default (30 s) is fine.
4. (Optional) Enable **local MQTT (zenSDK)** — see below.
5. (Optional) Choose the language of the **Feature names** (English by default):
   it applies to the batteries you create from now on.
6. Click **Save configuration**. Your batteries appear in the **Discover** tab,
   ready to be added.

### Local MQTT (recommended if you use it)

When you enable local MQTT in the Zendure app (developer mode), each device
publishes its telemetry to a local broker on your network. Turning on **Enable
local MQTT** in Gladys makes the integration read from that broker:

- **Faster**: local values update every 1–3 s instead of ~30 s over the cloud.
- **Resilient**: telemetry keeps flowing during a Zendure cloud or internet
  outage.
- **Automatic fallback**: if a device goes silent on the local broker, the
  integration falls back to the cloud on its own, and returns to local as soon
  as local messages resume — no action needed.

## Transport badges

Each device shows a badge telling you **how it is currently reached**:

- **Local** (green) — served by its local MQTT broker (nominal when local MQTT
  is enabled).
- **Cloud** (blue) — served by the Zendure cloud (nominal when local MQTT is
  off).
- **Cloud + orange dot (degraded)** — the device _should_ be local but is
  temporarily on the cloud fallback (its local broker went silent). Hover the
  badge for the reason. This clears by itself when the device resumes locally.
- **Unreachable** (red) — the Zendure cloud reports the device offline, or it is
  silent on every source.

## Control from scenes

Gladys has no battery setpoint feature yet, so the batteries are controlled
from **scenes** (and from the dashboard widget): in a scene, add an action of
the **Integrations** category.

| Action                    | What it does                                                 |
| ------------------------- | ------------------------------------------------------------ |
| **Set the output limit**  | Maximum power the battery delivers to the home (W)           |
| **Set the charge limit**  | Maximum power the battery draws from the grid, AC charge (W) |
| **Set the AC mode**       | Charge from the grid, or discharge to the home               |
| **Set the charge levels** | Charge target (70-100 %) and discharge floor (0-50 %)        |

The integration protects the battery:

- a limit is clamped to the battery's rating (e.g. 800 W out on a SolarFlow
  800 Pro);
- power limits are sent in "smart mode", kept in memory instead of being
  written to the battery's flash (frequent changes would wear it out);
- one setting cannot change more than once every 3 s (power limits) or 30 s
  (AC mode, charge levels): a scene that tries sooner fails with the delay to
  wait;
- a value the battery already runs with is not sent again (the action output
  **Command sent** is then false);
- the charge levels are refused until the battery has reported its current
  ones (its scale differs between firmwares).

The command goes through the broker that currently serves the battery (local
or cloud); the new value shows up with the battery's next report.

The trigger **Battery reachability changed** starts a scene when a battery
stops reporting on every source, or reports again (local MQTT mode). Its
variables give the battery name, the new state and the telemetry source.

## One cloud consumer per Zendure account

Zendure allows **only one cloud consumer per account** at a time. If another app
uses the same account's cloud connection (Home Assistant, a second Gladys
instance…), the two fight over the connection and telemetry becomes
intermittent. Prefer the **local MQTT** path for any second consumer — the local
broker has no such limit. The integration warns once in its logs when it detects
this take-over pattern.

## Updating the integration

**Installed from the catalog** (the usual case): Gladys checks the store
regularly. When a new version is out, the integration shows an **"Update
available"** badge (also counted next to **Integrations** in the menu), and its
**Supervision** tab names the version offered, with a link to its release
notes. Click **Update**: Gladys pulls the new image **and** applies the new
manifest — new configuration fields appear on their own, there is nothing to
re-paste. Your configuration and your devices are kept.

Gladys can take up to about an hour and a half to notice a new release (store
index refresh). **"Force update"** checks right away: it reads the latest
published version and pulls its image.

**Installed in developer mode** (manifest pasted by hand): **"Force update"**
only re-pulls the image of the tag you installed, and the version shown and the
configuration fields come from the pasted manifest — re-paste the updated
manifest to pick up new fields.

## Troubleshooting

- **A battery is not discovered.** Open the **Logs** tab: a line `Unsupported
Zendure model skipped: productModel "..."` gives the exact model string the
  Zendure cloud reports. Open an issue on
  [gladys-zendure](https://github.com/Terdious/gladys-zendure/issues) with it,
  so the model can be added.
- **One device shows no values (or is slower than the others) while the rest
  work.** Check its transport badge. If it fell back to **Cloud (degraded)**
  while local MQTT is enabled, its firmware may have silently stopped publishing
  locally. In the Zendure app, toggle that device's **MQTT control OFF**, save,
  then **ON** again — it resumes publishing within a minute. The integration
  falls back to the cloud in the meantime and returns to local automatically.
- **`Too Many Requests` in the logs.** The integration paces its updates under
  the Gladys core rate limit and self-throttles when needed; occasional bursts
  are harmless. Persistent floods usually mean a **second integration instance**
  (e.g. a prod and a test container side by side) sharing the same core budget —
  run only one.
- **Everything is silent right after configuration.** Make sure the cloud key is
  correct: an invalid or expired key shows a "Zendure cloud is unreachable or
  the cloud key is invalid" status on the Configuration screen.
- **Full detail.** Set `LOG_LEVEL=debug` and read the integration logs in its
  **Logs** tab (or `docker logs` on the host). Every telemetry-source switch is
  logged on a `telemetry:` line.
