import { Command } from 'commander';
import { getModelPolicyDefault, setModelPolicyDefault } from '../api/client.js';
import { colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import {
  addModelPolicyOptions,
  mergeModelPolicies,
  parseSetModelsOptions,
  resolveSetModelsJsonMode,
} from './models.js';

/**
 * Configurable Task Models (Task 12) — `tasks settings-set-models [flags]`.
 *
 * Assembles a partial `ModelPolicy` from the per-role flags (identical to
 * `project-set-models`), validates it, merges it CLIENT-SIDE over the
 * currently-stored global default (the server's write is a wholesale
 * replace), and persists the merged result via the global default setter
 * (`PUT /settings/model-policy`). A project without its own `model_policy`
 * inherits this default.
 */
export const settingsSetModelsCommand = addModelPolicyOptions(
  new Command('settings-set-models').description(
    'Set the database-wide default model policy (per-role / per-category routing)',
  ),
).action(async (options: Record<string, string | undefined>) => {
  try {
    const parsed = parseSetModelsOptions(options);
    if (parsed.stop) return;
    const modelPolicy = parsed.policy;

    // Fetch-merge-write: keep incremental invocations non-destructive (the
    // server replaces the stored default wholesale).
    const current = await getModelPolicyDefault();
    const persisted = await setModelPolicyDefault(mergeModelPolicies(current, modelPolicy));

    const isJsonMode = resolveSetModelsJsonMode(settingsSetModelsCommand);

    if (isJsonMode) {
      jsonOutput({ model_policy: persisted });
    } else {
      console.log(colorSuccess('Default model policy updated'));
      console.log(JSON.stringify(persisted, null, 2));
    }
  } catch (error) {
    handleError(error);
  }
});
