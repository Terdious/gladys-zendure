// -----------------------------------------------------------------------------
// Scene actions (Gladys 5.1+): battery control from scenes.
//
// Each key is declared in the manifest `scene_actions` field and registered by
// index.js with `gladys.onSceneAction(key, ...)`. `fields` arrive resolved and
// validated by the core; `device` is the external_id of a battery of this
// integration (`"source": "devices"`). Throwing fails this action only: the
// scene logs the message and goes on.
//
// The scene TRIGGER (battery_reachability_changed) is fired by the telemetry
// evaluator, see src/devices/solarflow.js. No action ever fires it, so a scene
// cannot loop through the integration.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { controlDevice } from './devices/index.js';

const logger = createLogger({ name: 'scenes' });

async function run(gladys, config, key, device, command) {
  logger.info(`Scene action ${key} <- ${device} ${JSON.stringify(command)}`);
  return controlDevice(gladys, config, device, command);
}

export const SCENE_ACTIONS = {
  async set_output_limit(gladys, { fields, config }) {
    const result = await run(gladys, config, 'set_output_limit', fields.device, {
      kind: 'output_limit',
      watts: fields.watts,
    });
    return { sent: result.sent, watts: result.applied.outputLimit ?? Number(fields.watts) };
  },

  async set_input_limit(gladys, { fields, config }) {
    const result = await run(gladys, config, 'set_input_limit', fields.device, {
      kind: 'input_limit',
      watts: fields.watts,
    });
    return { sent: result.sent, watts: result.applied.inputLimit ?? Number(fields.watts) };
  },

  async set_ac_mode(gladys, { fields, config }) {
    const result = await run(gladys, config, 'set_ac_mode', fields.device, {
      kind: 'ac_mode',
      mode: fields.mode,
    });
    return { sent: result.sent };
  },

  async set_soc_limits(gladys, { fields, config }) {
    const result = await run(gladys, config, 'set_soc_limits', fields.device, {
      kind: 'soc_limits',
      max_soc: fields.max_soc,
      min_soc: fields.min_soc,
    });
    return { sent: result.sent };
  },
};
