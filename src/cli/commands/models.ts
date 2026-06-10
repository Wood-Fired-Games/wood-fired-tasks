import { Command } from 'commander';
import { listModels } from '../api/client.js';
import { colorWarn } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import {
  POWER_CATEGORIES,
  ModelPolicySchema,
  type ModelPolicy,
  type ModelRef,
  type RolePolicy,
} from '../../schemas/model-policy.schema.js';

/**
 * Configurable Task Models (Task 12) — CLI surface.
 *
 * `tasks models list`         → enumerate the runtime-discovered Claude model
 *                               catalog (GET /models). Prints one line per
 *                               entry; appends ` (stale)` to each line when the
 *                               catalog was served from the static fallback.
 *
 * The `--<role>-<category>`, `--<role>-default`, and `--planning-constant`
 * flag-assembly helpers below are shared by the `project set-models` and
 * `settings set-models` commands (see `project-set-models.ts` /
 * `settings-set-models.ts`). They turn the flat Commander option bag into a
 * validated partial `ModelPolicy` (`ModelPolicySchema.parse`).
 */

/** The three dispatch roles a policy can configure. */
export const MODEL_ROLES = ['execution', 'validation', 'planning'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Register the per-role model flags on a Commander command:
 *   --<role>-<category> <model|auto>   (byCategory route)
 *   --<role>-default <model|auto>      (role default)
 *   --planning-constant <model|auto>   (planning single constant)
 */
export function addModelPolicyOptions(command: Command): Command {
  for (const role of MODEL_ROLES) {
    for (const category of POWER_CATEGORIES) {
      command.option(
        `--${role}-${category} <model>`,
        `${role} model for the '${category}' power category (a catalog model id or 'auto')`,
      );
    }
    command.option(
      `--${role}-default <model>`,
      `${role} default model when no category route matches (a catalog model id or 'auto')`,
    );
  }
  command.option(
    '--planning-constant <model>',
    "planning single constant model for every task (a catalog model id or 'auto')",
  );
  return command;
}

/** A category flag value is either a concrete model id or the `auto` sentinel. */
function asModelRef(raw: string): ModelRef {
  return raw === 'auto' ? 'auto' : raw;
}

/**
 * Assemble a partial `ModelPolicy` from the flat option bag produced by
 * {@link addModelPolicyOptions}. Returns `undefined` when no model flags were
 * supplied (the caller treats that as "no updates"). Throws (via
 * `ModelPolicySchema.parse`) when the assembled shape is invalid.
 */
export function buildModelPolicyFromOptions(
  options: Record<string, string | undefined>,
): ModelPolicy | undefined {
  const policy: ModelPolicy = {};
  let touched = false;

  for (const role of MODEL_ROLES) {
    const rolePolicy: RolePolicy = {};
    let roleTouched = false;

    for (const category of POWER_CATEGORIES) {
      // Commander camel-cases `--execution-heavy` → `executionHeavy`.
      const key = `${role}${category.charAt(0).toUpperCase()}${category.slice(1)}`;
      const value = options[key];
      if (value !== undefined) {
        rolePolicy.byCategory = { ...rolePolicy.byCategory, [category]: asModelRef(value) };
        roleTouched = true;
      }
    }

    const defaultKey = `${role}Default`;
    const defaultValue = options[defaultKey];
    if (defaultValue !== undefined) {
      rolePolicy.default = asModelRef(defaultValue);
      roleTouched = true;
    }

    if (role === 'planning' && options['planningConstant'] !== undefined) {
      rolePolicy.constant = asModelRef(options['planningConstant']);
      roleTouched = true;
    }

    if (roleTouched) {
      policy[role] = rolePolicy;
      touched = true;
    }
  }

  if (!touched) return undefined;

  // Validate via the shared schema — `.strict()` rejects unknown keys, the
  // union rejects empty model refs. Throws on invalid input.
  return ModelPolicySchema.parse(policy);
}

/**
 * Deep-merge a flag-assembled PARTIAL policy over the currently-stored one,
 * per role and per slot (byCategory entries merge key-wise; `constant` and
 * `default` override only when the partial sets them). The server's
 * `model_policy` write is a wholesale column REPLACE, so this client-side
 * merge is what makes incremental invocations ("add validation routing
 * without retyping the execution flags") non-destructive — the documented
 * `set-models` UX. Returns a schema-validated complete policy to persist.
 */
export function mergeModelPolicies(
  existing: ModelPolicy | null | undefined,
  partial: ModelPolicy,
): ModelPolicy {
  const merged: ModelPolicy = {};
  for (const role of MODEL_ROLES) {
    const base = existing?.[role];
    const patch = partial[role];
    if (base === undefined && patch === undefined) continue;
    const rolePolicy: RolePolicy = { ...base, ...patch };
    if (base?.byCategory !== undefined || patch?.byCategory !== undefined) {
      rolePolicy.byCategory = { ...base?.byCategory, ...patch?.byCategory };
    }
    merged[role] = rolePolicy;
  }
  return ModelPolicySchema.parse(merged);
}

// ── `models list` ───────────────────────────────────────────

const modelsListCommand = new Command('list')
  .description('List the available Claude model catalog (runtime-discovered)')
  .action(async () => {
    try {
      const catalog = await listModels();

      const program = modelsCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      if (isJsonMode) {
        jsonOutput(catalog, { total: catalog.models.length, stale: catalog.stale });
        return;
      }

      if (catalog.models.length === 0) {
        console.log(colorWarn('No models in catalog.'));
      } else {
        const staleSuffix = catalog.stale ? ' (stale)' : '';
        for (const model of catalog.models) {
          console.log(`${model.id}  ${model.display_name}  [${model.family}]${staleSuffix}`);
        }
      }
      if (catalog.stale) {
        console.log(
          colorWarn(
            'Catalog is stale — served from the static fallback (no API key / unreachable).',
          ),
        );
      }
    } catch (error) {
      handleError(error);
    }
  });

export const modelsCommand = new Command('models')
  .description('Inspect the Claude model catalog')
  .addCommand(modelsListCommand);
