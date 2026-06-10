import { Command } from 'commander';
import { getProject, updateProject } from '../api/client.js';
import { formatProjectDetail, colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import {
  addModelPolicyOptions,
  buildModelPolicyFromOptions,
  mergeModelPolicies,
} from './models.js';
import type { UpdateProjectInput } from '../api/types.js';

/**
 * Configurable Task Models (Task 12) — `tasks project-set-models <id> [flags]`.
 *
 * Assembles a partial `ModelPolicy` from the per-role flags
 * (`--<role>-<category>`, `--<role>-default`, `--planning-constant`), validates
 * it via `ModelPolicySchema.parse` (inside `buildModelPolicyFromOptions`),
 * merges it CLIENT-SIDE over the project's currently-stored policy (the
 * server's `model_policy` write is a wholesale replace), and persists the
 * merged result through the project update path (`PUT /projects/:id`).
 */
export const projectSetModelsCommand = addModelPolicyOptions(
  new Command('project-set-models')
    .description("Set a project's model policy (per-role / per-category model routing)")
    .argument('<id>', 'Project ID to configure'),
).action(async (idStr: string, options: Record<string, string | undefined>) => {
  try {
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      console.error(colorError('Invalid project ID: must be a number'));
      process.exitCode = 1;
      return;
    }

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

    // Fetch-merge-write: the server replaces the column wholesale, so merge
    // the partial flag policy over the stored one here to keep incremental
    // invocations non-destructive.
    const current = await getProject(id);
    const updates: UpdateProjectInput = {
      model_policy: mergeModelPolicies(current.model_policy ?? null, modelPolicy),
    };
    const project = await updateProject(id, updates);

    const program = projectSetModelsCommand.parent;
    const globalOpts = program?.optsWithGlobals() || {};
    const isJsonMode = globalOpts['json'] || false;

    if (isJsonMode) {
      jsonOutput({ project }, { id: project.id });
    } else {
      console.log(colorSuccess(`Project #${project.id} model policy updated`));
      console.log('');
      console.log(formatProjectDetail(project));
    }
  } catch (error) {
    handleError(error);
  }
});
