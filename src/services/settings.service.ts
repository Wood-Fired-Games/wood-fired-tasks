import { ModelPolicySchema, type ModelPolicy } from '../schemas/model-policy.schema.js';

/**
 * Task 7 (project "Configurable Task Models") — settings service: the owner of
 * the database-wide model-policy default. It is the JSON-serialisation and
 * `ModelPolicySchema`-validation boundary over the raw `string | null` port
 * exposed by `settings.repository.ts` (the `app_settings.model_policy_default`
 * column from migration 016).
 *
 * Contract:
 *  - `getModelPolicyDefault()` reads the raw column; `null` (no default set)
 *    round-trips as `null`, otherwise the JSON is parsed and validated through
 *    `ModelPolicySchema` before being returned. A non-conforming stored value
 *    (corrupt JSON, forward-version shape, hand-edited row) DEGRADES TO `null`
 *    rather than throwing — `getGlobalPolicy` runs inside every
 *    `resolve_model` call, so a single bad row must read as "no default", not
 *    brick the entire resolution surface. Mirrors the project-layer read path
 *    (`parseModelPolicy` in project.repository.ts).
 *  - `setModelPolicyDefault(policy)` validates a non-null policy through
 *    `ModelPolicySchema` (rejecting an invalid shape BEFORE persisting), then
 *    stringifies and writes it. Passing `null` clears the default (writes NULL).
 *
 * The dependency is injected as two thin functions so the service is trivially
 * testable against an in-memory store and is decoupled from better-sqlite3.
 * `createSettingsRepository(db)` from the repository module satisfies this shape.
 */

/** Raw read/write port the service serialises/validates over. */
export interface SettingsDeps {
  /** Return the raw `model_policy_default` JSON column value, or `null` when unset. */
  readModelPolicyDefault: () => string | null;
  /** Persist the raw `model_policy_default` column. `null` clears it. */
  writeModelPolicyDefault: (json: string | null) => void;
}

/**
 * Construct the settings service over the supplied read/write port.
 *
 * @returns getter/setter for the global model-policy default. The setter throws
 *   (a `ZodError`) when handed an invalid policy and never persists it.
 */
export function createSettingsService(deps: SettingsDeps) {
  return {
    /**
     * The global model-policy default, or `null` when none is configured.
     * Defensive read: a stored value that fails JSON.parse or the schema
     * degrades to `null` (see the contract note above).
     */
    getModelPolicyDefault(): ModelPolicy | null {
      const raw = deps.readModelPolicyDefault();
      if (raw == null) return null;
      try {
        const parsed = ModelPolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        // Corrupt JSON bytes — degrade, never throw from the read path.
        return null;
      }
    },
    /** Set (or, with `null`, clear) the global model-policy default. Validates before writing. */
    setModelPolicyDefault(policy: ModelPolicy | null): void {
      if (policy === null) {
        deps.writeModelPolicyDefault(null);
        return;
      }
      const validated = ModelPolicySchema.parse(policy);
      deps.writeModelPolicyDefault(JSON.stringify(validated));
    },
  };
}

/** Public type of a constructed settings service. */
export type SettingsService = ReturnType<typeof createSettingsService>;
