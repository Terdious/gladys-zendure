# Feature request: a "degraded" state for device transport badges

*Target: GladysAssistant/Gladys (core) + GladysAssistant/integration-sdk-js — to be posted as a core feature request first.*

---

## Context

Since integration-sdk 0.5.0, external integrations can report a per-device transport via `POST /api/v1/device/transport` with three values: `local`, `cloud`, `unreachable`. The Gladys front renders them as badges (green "Local", blue "Cloud", red "Unreachable"), which is already a big UX win: users see at a glance how each device is reached.

While building **gladys-zendure** (local MQTT with per-device cloud fallback) and looking at **gladys-tuya**, we hit a state that none of the three values describes: **the device is reachable, but not through its nominal transport, or only partially.**

## Problem

Two real-world cases today:

1. **gladys-zendure — local → cloud fallback.** A device normally served by the local MQTT broker goes silent (Wi-Fi drop, firmware bug that stops local publications). The integration automatically falls back to cloud telemetry, and back to local when the device recovers. During the fallback window the badge says "Cloud", which is technically true but hides the important information: *this device is supposed to be local and currently isn't*. The user cannot distinguish "cloud by design" from "cloud because something is wrong on my LAN".

2. **gladys-tuya — discovered but failing.** A device is found by the local UDP scan (so it exists and answers on the network), but every poll returns an error (wrong local key, protocol mismatch…). It is neither `local` (no data flows) nor really `unreachable` (it responds to discovery). Whichever of the two values the integration picks, the badge lies a little.

In both cases the honest answer is "degraded": partially working, or working through a fallback path.

## Proposal

Add a fourth value to `DEVICE_TRANSPORTS`:

```js
const DEVICE_TRANSPORTS = {
  LOCAL: 'local',
  CLOUD: 'cloud',
  DEGRADED: 'degraded',   // new
  UNREACHABLE: 'unreachable',
};
```

- **Semantics**: the device is alive but not in its nominal state — e.g. served by a fallback transport, or discovered but erroring on data retrieval.
- **Front**: an orange badge ("Degraded" / "Dégradé"), between blue and red in the visual hierarchy.
- **Tooltip / detail (optional but valuable)**: allow the integration to attach a short reason string (e.g. "local silent for 2 min, using cloud", "found on LAN but polling fails"), shown on hover or on the device page. If a free-text field is unwanted, even the plain badge is already useful.

## Why not solve it integration-side?

We tried. The integration can log transitions (gladys-zendure logs `local -> cloud fallback (local silent for 95 s)` with durations), but logs are not where users look. The badge is the one glanceable surface, and today it cannot express "working, but not as intended". Any integration with more than one path to a device (local+cloud, scan+poll, hub+direct) will hit this.

## Scope of change

- **core**: accept `degraded` in the transport endpoint validation, add the badge color + i18n keys (en/fr/de).
- **integration-sdk-js**: add `DEGRADED` to `DEVICE_TRANSPORTS` (+ typings). Backward compatible: integrations that never send it see no change, and an older core receiving `degraded` from a newer SDK can simply ignore it (same behaviour as today's "unknown ids ignored" rule).

Happy to contribute the PRs for both repos if the direction is approved.
