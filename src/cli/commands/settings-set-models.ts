import { Command } from 'commander';
import { getModelPolicyDefault, setModelPolicyDefault } from '../api/client.js';
import { colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import {
  addModelPolicyOptions,
  buildModelPolicyFromOptions,
  mergeModelPolicies,
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
    let modelPolicy;
    try {
      modelPolicy = buildModelPolicyFromOptions(options);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(colorError(`Invalid model policy: ${msg}`));
      process.exitCode = 1;
      return;
    }

    if (modelPolicy === undefined) {
      console.log(colorWarn('No model flags specified. Use --help to see available options.'));
      process.exitCode = 1;
      return;
    }

    // Fetch-merge-write: keep incremental invocations non-destructive (the
    // server replaces the stored default wholesale).
    const current = await getModelPolicyDefault();
    const persisted = await setModelPolicyDefault(mergeModelPolicies(current, modelPolicy));

    const program = settingsSetModelsCommand.parent;
    const globalOpts = program?.optsWithGlobals() || {};
    const isJsonMode = globalOpts['json'] || false;

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
