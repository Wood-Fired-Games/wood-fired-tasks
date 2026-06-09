# Configurable Task Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let wood-fired-tasks route the loop worker (execution), the verifier (validation), and planning agents (decompose/audit) to different Anthropic models, configured per-project over a database-wide default, expressed in six power categories, with runtime model discovery and an adaptive interview.

**Architecture:** A nullable `model_policy` JSON column on `projects` (mirrors `value_charter`, migration 014) plus a singleton `app_settings.model_policy_default`. A single owner service `model-policy.service.ts` performs the two-layer per-slot merge and the `jobSize`→category bijection; `model-catalog.service.ts` discovers live models from the Anthropic Models API with a static fallback. Read-only MCP tools (`resolve_model`, `list_models`) and read/write surfaces (MCP/CLI/API) expose both layers. Loop/decompose/audit skills call `resolve_model` and pass the result to the `Agent` `model:` param, falling back to the session model on `null` or harness rejection.

**Tech Stack:** TypeScript (Node ≥ 22 ESM), Zod schemas, better-sqlite3 + umzug migrations, `@modelcontextprotocol/sdk`, Commander CLI, Fastify API, vitest, biome.

**Spec:** `docs/superpowers/specs/2026-06-09-configurable-task-models-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/schemas/model-policy.schema.ts` | Zod contract: `ModelRef`, `PowerCategory`, `RolePolicy`, `ModelPolicy`, nullable variant | Create |
| `src/types/task.ts` | `ModelPolicy`/`ModelRef` TS types; `model_policy` on `Project` + DTOs | Modify |
| `src/db/migrations/016-model-policy.ts` | `projects.model_policy` column + `app_settings` table | Create |
| `src/services/model-policy.service.ts` | Two-layer per-slot merge, category bijection, `resolveModel` | Create |
| `src/services/model-catalog.service.ts` | Anthropic Models API discovery, cache, static fallback | Create |
| `src/services/settings.service.ts` | Read/write the `app_settings.model_policy_default` singleton | Create |
| `src/repositories/settings.repository.ts` | `app_settings` row access (serialize/parse boundary) | Create |
| `src/repositories/project.repository.ts` | Serialize/parse `model_policy` (alongside `value_charter`) | Modify |
| `src/mcp/tools/model-tools.ts` | `list_models`, `resolve_model`, `get_model_defaults`, `set_model_defaults` | Create |
| `src/mcp/tools/project-tools.ts` | Carry `model_policy` on `get_project`/`update_project` | Modify |
| `src/mcp/server.ts` | Conditionally register model tools | Modify |
| `src/cli/commands/project.ts` (+ `settings.ts`, `models.ts`) | `project set-models`, `settings set-models`, `models list` | Modify/Create |
| `src/api/routes/projects/*`, `src/api/routes/settings/*`, `src/api/routes/models/*` | `model_policy` field + settings + models routes | Modify/Create |
| `skills/tasks/set-models.md` | Adaptive interview skill | Create |
| `skills/tasks/loop.md`, `loop-dag.md`, `decompose.md`, `audit.md` | `resolve_model` integration + run-arg overrides | Modify |
| `docs/MCP.md`, `docs/CLI.md`, `docs/API.md` | Document the new surfaces | Modify |

---

## Phase 1 — Schema, types, migration (no behavior change)

### Task 1: `ModelPolicy` Zod schema

**Files:**
- Create: `src/schemas/model-policy.schema.ts`
- Test: `src/schemas/__tests__/model-policy.schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  ModelRefSchema,
  PowerCategorySchema,
  ModelPolicySchema,
  ModelPolicyNullableSchema,
  POWER_CATEGORIES,
} from '../model-policy.schema.js';

describe('model-policy schema', () => {
  it('accepts a concrete model id and the auto sentinel', () => {
    expect(ModelRefSchema.parse('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(ModelRefSchema.parse('auto')).toBe('auto');
  });

  it('rejects an empty model ref', () => {
    expect(() => ModelRefSchema.parse('')).toThrow();
  });

  it('exposes the six power categories in ascending order', () => {
    expect(POWER_CATEGORIES).toEqual(['minimal', 'light', 'moderate', 'strong', 'heavy', 'maximum']);
    expect(() => PowerCategorySchema.parse('mega')).toThrow();
  });

  it('accepts a full per-role policy', () => {
    const policy = {
      execution: { byCategory: { minimal: 'auto', maximum: 'claude-opus-4-8' }, default: 'auto' },
      validation: { default: 'claude-sonnet-4-6' },
      planning: { constant: 'claude-opus-4-8' },
    };
    expect(ModelPolicySchema.parse(policy)).toEqual(policy);
  });

  it('rejects unknown top-level and per-role keys (strict)', () => {
    expect(() => ModelPolicySchema.parse({ orchestrator: { constant: 'x' } })).toThrow();
    expect(() => ModelPolicySchema.parse({ execution: { byFib: {} } })).toThrow();
  });

  it('round-trips null via the nullable variant', () => {
    expect(ModelPolicyNullableSchema.parse(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/schemas/__tests__/model-policy.schema.test.ts`
Expected: FAIL — cannot resolve `../model-policy.schema.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/schemas/model-policy.schema.ts
import { z } from 'zod';

/**
 * Six power categories implying how much model power a task warrants. A fixed
 * 1:1 relabel of the WSJF `jobSize` Fibonacci tiers {1,2,3,5,8,13}; the
 * bijection lives in `model-policy.service.ts`. Listed ascending by power.
 */
export const POWER_CATEGORIES = ['minimal', 'light', 'moderate', 'strong', 'heavy', 'maximum'] as const;
export const PowerCategorySchema = z.enum(POWER_CATEGORIES);
export type PowerCategory = (typeof POWER_CATEGORIES)[number];

/** A concrete catalog model id, or the `auto` sentinel (resolve at dispatch). */
export const ModelRefSchema = z.union([z.string().min(1).max(200), z.literal('auto')]);
export type ModelRef = z.infer<typeof ModelRefSchema>;

const ByCategorySchema = z
  .object({
    minimal: ModelRefSchema,
    light: ModelRefSchema,
    moderate: ModelRefSchema,
    strong: ModelRefSchema,
    heavy: ModelRefSchema,
    maximum: ModelRefSchema,
  })
  .partial()
  .strict();

/** One role's policy: category-routed OR a single constant, plus a default. */
export const RolePolicySchema = z
  .object({
    byCategory: ByCategorySchema.optional(),
    constant: ModelRefSchema.optional(),
    default: ModelRefSchema.optional(),
  })
  .strict();
export type RolePolicy = z.infer<typeof RolePolicySchema>;

export const ModelPolicySchema = z
  .object({
    execution: RolePolicySchema,
    validation: RolePolicySchema,
    planning: RolePolicySchema,
  })
  .partial()
  .strict();
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

export const ModelPolicyNullableSchema = ModelPolicySchema.nullable();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/schemas/__tests__/model-policy.schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/model-policy.schema.ts src/schemas/__tests__/model-policy.schema.test.ts
git commit -m "feat(schema): add ModelPolicy schema (power categories + auto)"
```

### Task 2: TS types + DTO wiring

**Files:**
- Modify: `src/types/task.ts` (add `model_policy` to `Project`, `CreateProjectDTO`, `UpdateProjectDTO`; re-export `ModelPolicy`)
- Modify: `src/schemas/project.schema.ts:59-75` (ride `model_policy` on Create/Update like `value_charter`)
- Test: `src/schemas/__tests__/project.schema.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — add to the project schema test file:

```ts
import { ModelPolicyNullableSchema } from '../model-policy.schema.js';

it('accepts model_policy on update', () => {
  const parsed = UpdateProjectSchema.parse({ model_policy: { execution: { default: 'auto' } } });
  expect(parsed.model_policy).toEqual({ execution: { default: 'auto' } });
});

it('accepts explicit null model_policy (clear)', () => {
  expect(UpdateProjectSchema.parse({ model_policy: null }).model_policy).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/schemas/__tests__/project.schema.test.ts`
Expected: FAIL — `model_policy` stripped/rejected.

- [ ] **Step 3: Write minimal implementation**

In `src/schemas/project.schema.ts`, import and add the field to both DTO schemas (mirroring `value_charter`):

```ts
import { ModelPolicyNullableSchema } from './model-policy.schema.js';
// inside CreateProjectSchema and UpdateProjectSchema object bodies:
  model_policy: ModelPolicyNullableSchema.optional(),
```

In `src/types/task.ts`:

```ts
import type { ModelPolicy } from '../schemas/model-policy.schema.js';
export type { ModelPolicy } from '../schemas/model-policy.schema.js';
// on interface Project:
  model_policy: ModelPolicy | null;
// on CreateProjectDTO and UpdateProjectDTO:
  model_policy?: ModelPolicy | null;
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/schemas/__tests__/project.schema.test.ts && npm run build`
Expected: PASS; build (typecheck) clean.

- [ ] **Step 5: Commit**

```bash
git add src/types/task.ts src/schemas/project.schema.ts src/schemas/__tests__/project.schema.test.ts
git commit -m "feat(types): ride model_policy on project DTOs"
```

### Task 3: Migration 016 — column + app_settings table

**Files:**
- Create: `src/db/migrations/016-model-policy.ts`
- Test: `src/db/__tests__/migrate.test.ts` (extend with a 016-specific case)

- [ ] **Step 1: Write the failing test**

```ts
it('016 adds projects.model_policy and the app_settings singleton', async () => {
  const db = await freshMigratedDb(); // existing helper; mirror the 014/015 test setup
  const cols = db.prepare("PRAGMA table_info('projects')").all() as { name: string }[];
  expect(cols.some((c) => c.name === 'model_policy')).toBe(true);
  const settings = db.prepare("PRAGMA table_info('app_settings')").all() as { name: string }[];
  expect(settings.some((c) => c.name === 'model_policy_default')).toBe(true);
  const row = db.prepare('SELECT id, model_policy_default FROM app_settings WHERE id = 1').get() as
    | { id: number; model_policy_default: string | null }
    | undefined;
  expect(row?.id).toBe(1);
  expect(row?.model_policy_default).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/__tests__/migrate.test.ts -t "016"`
Expected: FAIL — no such column/table.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/db/migrations/016-model-policy.ts
import type Database from '../driver.js';

/**
 * Migration 016: configurable task models.
 *  - projects.model_policy TEXT NULL — per-project ModelPolicy JSON (mirrors
 *    value_charter, migration 014; serialized at the repository boundary).
 *  - app_settings (id=1 singleton) with model_policy_default TEXT NULL — the
 *    database-wide default policy. No CHECK constraints; shape is validated by
 *    ModelPolicySchema at the service boundary. Existing rows load as NULL.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects ADD COLUMN model_policy TEXT');
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         model_policy_default TEXT
       )`,
    );
    db.exec('INSERT OR IGNORE INTO app_settings (id, model_policy_default) VALUES (1, NULL)');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS app_settings');
    db.exec('ALTER TABLE projects DROP COLUMN model_policy');
  })();
}
```

- [ ] **Step 4: Run test + full migration round-trip**

Run: `npx vitest run src/db/__tests__/migrate.test.ts && npm run migrate`
Expected: PASS; `npm run migrate` applies 016 cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/016-model-policy.ts src/db/__tests__/migrate.test.ts
git commit -m "feat(db): migration 016 — model_policy column + app_settings"
```

### Task 4: Project repository serialize/parse `model_policy`

**Files:**
- Modify: `src/repositories/project.repository.ts` (find the `value_charter` JSON.stringify on write / JSON.parse on read sites; add `model_policy` beside each)
- Test: `src/repositories/__tests__/project.repository.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it('persists and reads back model_policy', () => {
  const repo = makeProjectRepo(); // existing test helper
  const id = repo.create({ name: 'p', model_policy: { validation: { default: 'auto' } } }).id;
  expect(repo.getById(id)?.model_policy).toEqual({ validation: { default: 'auto' } });
});

it('reads model_policy as null when unset', () => {
  const repo = makeProjectRepo();
  const id = repo.create({ name: 'p2' }).id;
  expect(repo.getById(id)?.model_policy).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/repositories/__tests__/project.repository.test.ts -t "model_policy"`
Expected: FAIL — field absent/undefined.

- [ ] **Step 3: Write minimal implementation**

In `project.repository.ts`, at every place `value_charter` is handled, add the parallel `model_policy` line:
- Write (INSERT/UPDATE column list + params): add `model_policy` column and bind `dto.model_policy != null ? JSON.stringify(dto.model_policy) : null`.
- Read (row → `Project` mapper): add `model_policy: row.model_policy != null ? JSON.parse(row.model_policy) : null`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/repositories/__tests__/project.repository.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/project.repository.ts src/repositories/__tests__/project.repository.test.ts
git commit -m "feat(repo): serialize/parse project.model_policy"
```

---

## Phase 2 — Resolution service (the single owner)

### Task 5: Category bijection + `resolveModel` (project-only + global-only)

**Files:**
- Create: `src/services/model-policy.service.ts`
- Test: `src/services/__tests__/model-policy.service.test.ts`

**Interface (define once, used by all later tasks):**

```ts
export type PipelineRole = 'execution' | 'validation' | 'planning';
export type ResolvedModel = { model: string } | { model: 'auto' } | null;

export interface ModelPolicyService {
  /** jobSize Fibonacci tier → power category (or null if off-scale/absent). */
  categoryForJobSize(jobSize: number | null | undefined): PowerCategory | null;
  /** Two-layer per-slot merge; null = inherit session model. */
  resolveModel(projectId: number, role: PipelineRole, taskId?: number): ResolvedModel;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createModelPolicyService } from '../model-policy.service.js';

const fakeDeps = (project: any, global: any, jobSizeByTask: Record<number, number | null> = {}) => ({
  getProjectPolicy: () => project,
  getGlobalPolicy: () => global,
  getJobSize: (taskId: number) => jobSizeByTask[taskId] ?? null,
});

describe('categoryForJobSize', () => {
  it('maps the six Fibonacci tiers in order', () => {
    const s = createModelPolicyService(fakeDeps(null, null));
    expect([1, 2, 3, 5, 8, 13].map((f) => s.categoryForJobSize(f))).toEqual([
      'minimal', 'light', 'moderate', 'strong', 'heavy', 'maximum',
    ]);
    expect(s.categoryForJobSize(4)).toBeNull();
    expect(s.categoryForJobSize(null)).toBeNull();
  });
});

describe('resolveModel — single layer', () => {
  it('returns the project byCategory model for a scored task', () => {
    const s = createModelPolicyService(
      fakeDeps({ execution: { byCategory: { heavy: 'claude-opus-4-8' } } }, null, { 7: 8 }),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'claude-opus-4-8' });
  });

  it('falls back to role default when the task is unscored', () => {
    const s = createModelPolicyService(
      fakeDeps({ execution: { byCategory: { heavy: 'x' }, default: 'auto' } }, null, { 7: null }),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'auto' });
  });

  it('uses the global default when the project has no policy', () => {
    const s = createModelPolicyService(fakeDeps(null, { validation: { default: 'claude-sonnet-4-6' } }));
    expect(s.resolveModel(1, 'validation', 9)).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('returns null when neither layer sets anything', () => {
    const s = createModelPolicyService(fakeDeps(null, null));
    expect(s.resolveModel(1, 'execution', 9)).toBeNull();
  });

  it('uses constant for the planning role', () => {
    const s = createModelPolicyService(fakeDeps({ planning: { constant: 'claude-opus-4-8' } }, null));
    expect(s.resolveModel(1, 'planning')).toEqual({ model: 'claude-opus-4-8' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/model-policy.service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/model-policy.service.ts
import type { ModelPolicy, PowerCategory, RolePolicy } from '../schemas/model-policy.schema.js';

export type PipelineRole = 'execution' | 'validation' | 'planning';
export type ResolvedModel = { model: string } | { model: 'auto' } | null;

export interface ModelPolicyDeps {
  getProjectPolicy: (projectId: number) => ModelPolicy | null;
  getGlobalPolicy: () => ModelPolicy | null;
  getJobSize: (taskId: number) => number | null;
}

const FIB_TO_CATEGORY: Record<number, PowerCategory> = {
  1: 'minimal', 2: 'light', 3: 'moderate', 5: 'strong', 8: 'heavy', 13: 'maximum',
};

export function createModelPolicyService(deps: ModelPolicyDeps) {
  const categoryForJobSize = (jobSize: number | null | undefined): PowerCategory | null =>
    jobSize == null ? null : (FIB_TO_CATEGORY[jobSize] ?? null);

  const toResolved = (ref: string | undefined): ResolvedModel =>
    ref == null ? null : ref === 'auto' ? { model: 'auto' } : { model: ref };

  const resolveModel = (projectId: number, role: PipelineRole, taskId?: number): ResolvedModel => {
    const proj = deps.getProjectPolicy(projectId)?.[role] as RolePolicy | undefined;
    const glob = deps.getGlobalPolicy()?.[role] as RolePolicy | undefined;
    const category = taskId != null ? categoryForJobSize(deps.getJobSize(taskId)) : null;

    // Per-slot merge: project preferred over global, computed independently.
    const byCat = category
      ? (proj?.byCategory?.[category] ?? glob?.byCategory?.[category])
      : undefined;
    const constant = proj?.constant ?? glob?.constant;
    const dflt = proj?.default ?? glob?.default;

    return toResolved(byCat ?? constant ?? dflt);
  };

  return { categoryForJobSize, resolveModel };
}
export type ModelPolicyService = ReturnType<typeof createModelPolicyService>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/model-policy.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/model-policy.service.ts src/services/__tests__/model-policy.service.test.ts
git commit -m "feat(service): model-policy resolver (category bijection + single layer)"
```

### Task 6: Per-slot merge across both layers

**Files:**
- Modify: `src/services/model-policy.service.ts` (already merges; this task adds the cross-layer cases the prior test omitted)
- Test: `src/services/__tests__/model-policy.service.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe('resolveModel — per-slot merge', () => {
  it('prefers the project category over the global category', () => {
    const s = createModelPolicyService(fakeDeps(
      { execution: { byCategory: { heavy: 'proj-model' } } },
      { execution: { byCategory: { heavy: 'glob-model' } } },
      { 7: 8 },
    ));
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'proj-model' });
  });

  it('inherits an unset project category from the global category', () => {
    const s = createModelPolicyService(fakeDeps(
      { execution: { byCategory: { minimal: 'proj-min' } } },        // heavy unset on project
      { execution: { byCategory: { heavy: 'glob-heavy' } } },
      { 7: 8 },
    ));
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'glob-heavy' });
  });

  it('merges default independently of byCategory', () => {
    const s = createModelPolicyService(fakeDeps(
      { execution: { default: 'proj-default' } },
      { execution: { byCategory: { heavy: 'glob-heavy' } } },
      { 7: 99 }, // off-scale -> no category -> default path
    ));
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'proj-default' });
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/services/__tests__/model-policy.service.test.ts -t "per-slot merge"`
Expected: PASS (the Task 5 implementation already satisfies these — this task is the regression lock; if any fail, fix the merge expression in `resolveModel`).

- [ ] **Step 3: (only if a test failed) fix the merge** — ensure `byCat`, `constant`, `dflt` are each `proj ?? glob` independently. No change expected.

- [ ] **Step 4: Run full service tests + build**

Run: `npx vitest run src/services/__tests__/model-policy.service.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/__tests__/model-policy.service.test.ts
git commit -m "test(service): lock per-slot two-layer merge behavior"
```

### Task 7: Settings repository + service (global defaults owner)

**Files:**
- Create: `src/repositories/settings.repository.ts`
- Create: `src/services/settings.service.ts`
- Test: `src/services/__tests__/settings.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createSettingsService } from '../settings.service.js';

describe('settings service — model policy default', () => {
  it('returns null before any default is set', () => {
    const store: { v: string | null } = { v: null };
    const svc = createSettingsService({
      readModelPolicyDefault: () => store.v,
      writeModelPolicyDefault: (json) => { store.v = json; },
    });
    expect(svc.getModelPolicyDefault()).toBeNull();
  });

  it('validates against ModelPolicySchema on write and round-trips', () => {
    const store: { v: string | null } = { v: null };
    const svc = createSettingsService({
      readModelPolicyDefault: () => store.v,
      writeModelPolicyDefault: (json) => { store.v = json; },
    });
    svc.setModelPolicyDefault({ planning: { constant: 'auto' } });
    expect(svc.getModelPolicyDefault()).toEqual({ planning: { constant: 'auto' } });
  });

  it('rejects an invalid policy on write', () => {
    const svc = createSettingsService({ readModelPolicyDefault: () => null, writeModelPolicyDefault: () => {} });
    expect(() => svc.setModelPolicyDefault({ execution: { byFib: {} } } as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/settings.service.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/settings.service.ts
import { ModelPolicySchema, type ModelPolicy } from '../schemas/model-policy.schema.js';

export interface SettingsDeps {
  readModelPolicyDefault: () => string | null;
  writeModelPolicyDefault: (json: string | null) => void;
}

export function createSettingsService(deps: SettingsDeps) {
  return {
    getModelPolicyDefault(): ModelPolicy | null {
      const raw = deps.readModelPolicyDefault();
      return raw == null ? null : ModelPolicySchema.parse(JSON.parse(raw));
    },
    setModelPolicyDefault(policy: ModelPolicy | null): void {
      if (policy === null) { deps.writeModelPolicyDefault(null); return; }
      const validated = ModelPolicySchema.parse(policy);
      deps.writeModelPolicyDefault(JSON.stringify(validated));
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
```

```ts
// src/repositories/settings.repository.ts
import type Database from '../db/driver.js';

export function createSettingsRepository(db: Database.Database) {
  return {
    readModelPolicyDefault(): string | null {
      const row = db.prepare('SELECT model_policy_default FROM app_settings WHERE id = 1').get() as
        | { model_policy_default: string | null } | undefined;
      return row?.model_policy_default ?? null;
    },
    writeModelPolicyDefault(json: string | null): void {
      db.prepare('UPDATE app_settings SET model_policy_default = ? WHERE id = 1').run(json);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/settings.service.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/repositories/settings.repository.ts src/services/settings.service.ts src/services/__tests__/settings.service.test.ts
git commit -m "feat(service): settings service for global model_policy default"
```

---

## Phase 3 — Runtime model catalog

### Task 8: `model-catalog.service.ts` — discovery + cache + degrade

**Files:**
- Create: `src/services/model-catalog.service.ts`
- Test: `src/services/__tests__/model-catalog.service.test.ts`

**Interface:**

```ts
export interface ModelCatalogEntry { id: string; display_name: string; family: string; created_at: string; }
export interface ModelCatalog { models: ModelCatalogEntry[]; stale: boolean; }
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createModelCatalogService, STATIC_FALLBACK_MODELS } from '../model-catalog.service.js';

describe('model-catalog service', () => {
  it('parses a /v1/models payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-01-01T00:00:00Z' }],
    }), { status: 200 }));
    const svc = createModelCatalogService({ apiKey: 'sk-test', fetchImpl, now: () => 0 });
    const cat = await svc.list();
    expect(cat.stale).toBe(false);
    expect(cat.models[0]).toMatchObject({ id: 'claude-opus-4-8', family: 'opus' });
  });

  it('returns the static fallback (stale) when no api key', async () => {
    const svc = createModelCatalogService({ apiKey: undefined, fetchImpl: vi.fn(), now: () => 0 });
    const cat = await svc.list();
    expect(cat.stale).toBe(true);
    expect(cat.models).toEqual(STATIC_FALLBACK_MODELS);
  });

  it('falls back (stale) and never throws on network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const svc = createModelCatalogService({ apiKey: 'sk', fetchImpl, now: () => 0 });
    const cat = await svc.list();
    expect(cat.stale).toBe(true);
    expect(cat.models.length).toBeGreaterThan(0);
  });

  it('caches within the TTL window', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    let t = 0;
    const svc = createModelCatalogService({ apiKey: 'sk', fetchImpl, now: () => t, ttlMs: 1000 });
    await svc.list(); t = 500; await svc.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 2000; await svc.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/model-catalog.service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/model-catalog.service.ts
export interface ModelCatalogEntry { id: string; display_name: string; family: string; created_at: string; }
export interface ModelCatalog { models: ModelCatalogEntry[]; stale: boolean; }

export const STATIC_FALLBACK_MODELS: ModelCatalogEntry[] = [
  { id: 'claude-opus-4-8',   display_name: 'Claude Opus 4.8',   family: 'opus',   created_at: '2026-01-01T00:00:00Z' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', family: 'sonnet', created_at: '2025-09-01T00:00:00Z' },
  { id: 'claude-haiku-4-5',  display_name: 'Claude Haiku 4.5',  family: 'haiku',  created_at: '2025-10-01T00:00:00Z' },
];

const familyOf = (id: string): string =>
  ['opus', 'sonnet', 'haiku'].find((f) => id.includes(f)) ?? id.split('-')[1] ?? 'unknown';

export interface CatalogDeps {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  baseUrl?: string;
}

export function createModelCatalogService(deps: CatalogDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
  const baseUrl = deps.baseUrl ?? 'https://api.anthropic.com/v1/models';
  let cache: { at: number; value: ModelCatalog } | null = null;

  const fallback = (): ModelCatalog => ({ models: STATIC_FALLBACK_MODELS, stale: true });

  async function fetchLive(): Promise<ModelCatalog> {
    if (!deps.apiKey) return fallback();
    try {
      const res = await fetchImpl(baseUrl, {
        headers: { 'x-api-key': deps.apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) return fallback();
      const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
      const models = (body.data ?? []).map((m) => ({
        id: m.id,
        display_name: m.display_name ?? m.id,
        family: familyOf(m.id),
        created_at: m.created_at ?? '',
      }));
      return { models, stale: false };
    } catch {
      return fallback();
    }
  }

  return {
    async list(): Promise<ModelCatalog> {
      if (cache && now() - cache.at < ttlMs) return cache.value;
      const value = await fetchLive();
      cache = { at: now(), value };
      return value;
    },
    async refresh(): Promise<ModelCatalog> { cache = null; return this.list(); },
  };
}
export type ModelCatalogService = ReturnType<typeof createModelCatalogService>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/model-catalog.service.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/model-catalog.service.ts src/services/__tests__/model-catalog.service.test.ts
git commit -m "feat(service): runtime model catalog (Models API + static fallback)"
```

---

## Phase 4 — MCP surfaces

### Task 9: `model-tools.ts` — `list_models` + `resolve_model`

**Files:**
- Create: `src/mcp/tools/model-tools.ts`
- Test: `src/mcp/__tests__/model-tools.test.ts`

- [ ] **Step 1: Write the failing test** — follow the existing MCP tool test harness used by `src/mcp/__tests__/` (construct an `McpServer`, register, call the tool). Assert:
  - `list_models` returns `structuredContent` with `models[]` + `stale`.
  - `resolve_model` with `{ project_id, role: 'execution', task_id }` returns `structuredContent` `{ model: string | 'auto' | null }` from the injected `ModelPolicyService`.

```ts
it('resolve_model returns the resolver output verbatim', async () => {
  const server = makeTestServer(); // existing helper
  registerModelTools(server, {
    catalog: { list: async () => ({ models: [], stale: true }) } as any,
    modelPolicy: { resolveModel: () => ({ model: 'auto' }) } as any,
  });
  const out = await callTool(server, 'resolve_model', { project_id: 1, role: 'execution', task_id: 7 });
  expect(out.structuredContent).toEqual({ model: 'auto' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/__tests__/model-tools.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mcp/tools/model-tools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toStructuredContent } from '../lib/structured-content.js';
import { convertToMcpError } from '../errors.js';
import type { ModelCatalogService } from '../../services/model-catalog.service.js';
import type { ModelPolicyService, PipelineRole } from '../../services/model-policy.service.js';

export function registerModelTools(
  server: McpServer,
  deps: { catalog: ModelCatalogService; modelPolicy: ModelPolicyService },
): void {
  server.registerTool(
    'list_models',
    {
      description:
        'List Anthropic models available at runtime (from the Models API, with a static ' +
        'fallback when offline). Returns models[] and a `stale` flag. Read-only.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const catalog = await deps.catalog.list();
        return {
          content: [{ type: 'text', text: `${catalog.models.length} models${catalog.stale ? ' (stale fallback)' : ''}` }],
          structuredContent: toStructuredContent(catalog),
        };
      } catch (error) { throw convertToMcpError(error); }
    },
  );

  server.registerTool(
    'resolve_model',
    {
      description:
        'Resolve the model for a pipeline role (execution|validation|planning) for a project, ' +
        'optionally task-scoped for size routing. Returns { model } (concrete id), { model: "auto" } ' +
        '(resolve from live catalog at dispatch), or null (inherit the session model). Read-only.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        role: z.enum(['execution', 'validation', 'planning']),
        task_id: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const resolved = deps.modelPolicy.resolveModel(args.project_id, args.role as PipelineRole, args.task_id);
        return {
          content: [{ type: 'text', text: resolved == null ? 'inherit (session model)' : resolved.model }],
          structuredContent: toStructuredContent(resolved),
        };
      } catch (error) { throw convertToMcpError(error); }
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/__tests__/model-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/model-tools.ts src/mcp/__tests__/model-tools.test.ts
git commit -m "feat(mcp): list_models + resolve_model tools"
```

### Task 10: `get_model_defaults` / `set_model_defaults` + project tools carry `model_policy`

**Files:**
- Modify: `src/mcp/tools/model-tools.ts` (add the two settings tools, taking a `SettingsService`)
- Modify: `src/mcp/tools/project-tools.ts` (include `model_policy` in `get_project` structured output; accept it on `update_project` — it already flows through `UpdateProjectSchema` from Task 2, so verify the tool's input schema passes it through)
- Test: `src/mcp/__tests__/model-tools.test.ts`, `src/mcp/__tests__/project-tools.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```ts
it('set_model_defaults then get_model_defaults round-trips', async () => {
  const store: { v: any } = { v: null };
  const settings = { getModelPolicyDefault: () => store.v, setModelPolicyDefault: (p: any) => { store.v = p; } } as any;
  const server = makeTestServer();
  registerModelDefaultsTools(server, { settings });
  await callTool(server, 'set_model_defaults', { model_policy: { planning: { constant: 'auto' } } });
  const out = await callTool(server, 'get_model_defaults', {});
  expect(out.structuredContent).toEqual({ model_policy: { planning: { constant: 'auto' } } });
});

it('update_project accepts model_policy', async () => {
  // existing project-tools test harness with a fake projectService.update
  const out = await callTool(projectServer, 'update_project', { id: 1, model_policy: { execution: { default: 'auto' } } });
  expect(out.structuredContent.model_policy).toEqual({ execution: { default: 'auto' } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp/__tests__/model-tools.test.ts src/mcp/__tests__/project-tools.test.ts`
Expected: FAIL — `registerModelDefaultsTools` missing; `update_project` strips `model_policy`.

- [ ] **Step 3: Write minimal implementation**

Add to `model-tools.ts`:

```ts
import { ModelPolicyNullableSchema } from '../../schemas/model-policy.schema.js';
import type { SettingsService } from '../../services/settings.service.js';

export function registerModelDefaultsTools(server: McpServer, deps: { settings: SettingsService }): void {
  server.registerTool('get_model_defaults',
    { description: 'Get the database-wide default ModelPolicy. Read-only.', inputSchema: z.object({}) },
    async () => {
      try {
        const policy = deps.settings.getModelPolicyDefault();
        return { content: [{ type: 'text', text: policy ? 'set' : 'unset' }], structuredContent: toStructuredContent({ model_policy: policy }) };
      } catch (error) { throw convertToMcpError(error); }
    });
  server.registerTool('set_model_defaults',
    { description: 'Set (or clear with null) the database-wide default ModelPolicy.', inputSchema: z.object({ model_policy: ModelPolicyNullableSchema }) },
    async (args) => {
      try {
        deps.settings.setModelPolicyDefault(args.model_policy);
        return { content: [{ type: 'text', text: 'updated' }], structuredContent: toStructuredContent({ model_policy: args.model_policy }) };
      } catch (error) { throw convertToMcpError(error); }
    });
}
```

In `project-tools.ts`: confirm `update_project`'s input schema is `UpdateProjectSchema` (passes `model_policy` through from Task 2) and that `get_project`'s structured output maps the field. If the tool re-declares a narrower inline schema, add `model_policy: ModelPolicyNullableSchema.optional()`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/mcp/__tests__/model-tools.test.ts src/mcp/__tests__/project-tools.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/model-tools.ts src/mcp/tools/project-tools.ts src/mcp/__tests__/model-tools.test.ts src/mcp/__tests__/project-tools.test.ts
git commit -m "feat(mcp): model defaults tools + model_policy on project tools"
```

### Task 11: Conditionally register the model tools in `server.ts`

**Files:**
- Modify: `src/mcp/server.ts` (add optional `modelCatalogService` + `modelPolicyService` + `settingsService` params; register when present — mirror the `if (topologyService)` block at line ~120)
- Modify: `src/mcp/index.ts` (wire the three concrete services like `TopologyService` is wired)
- Test: `src/mcp/__tests__/server.test.ts` (extend: tool count / presence assertions when services provided vs omitted)

- [ ] **Step 1: Write the failing test**

```ts
it('registers model tools only when the services are provided', () => {
  const withSvc = buildServer({ withModelServices: true });   // helper toggles the optional deps
  expect(toolNames(withSvc)).toEqual(expect.arrayContaining(['list_models', 'resolve_model', 'get_model_defaults', 'set_model_defaults']));
  const without = buildServer({ withModelServices: false });
  expect(toolNames(without)).not.toContain('resolve_model');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/__tests__/server.test.ts -t "model tools"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation** — in `server.ts`, after the topology/wsjf blocks:

```ts
if (modelCatalogService && modelPolicyService) {
  registerModelTools(server, { catalog: modelCatalogService, modelPolicy: modelPolicyService });
}
if (settingsService) {
  registerModelDefaultsTools(server, { settings: settingsService });
}
```

Add the params to the server factory signature (all optional, mirroring `topologyService?`), import the registrars, and wire concrete instances in `src/mcp/index.ts` (construct `createModelCatalogService({ apiKey: process.env.ANTHROPIC_API_KEY })`, the settings repo+service, and `createModelPolicyService` with deps reading the project repo + settings repo + wsjf task repo for `getJobSize`).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/mcp/__tests__/server.test.ts && npm run build`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/index.ts src/mcp/__tests__/server.test.ts
git commit -m "feat(mcp): conditionally register model tools + wire services"
```

---

## Phase 5 — CLI + API surfaces

### Task 12: CLI — `tasks models list`, `tasks settings set-models`, `tasks project set-models`

**Files:**
- Create: `src/cli/commands/models.ts` (list)
- Create/Modify: `src/cli/commands/settings.ts` (global set-models, non-interactive flags)
- Modify: `src/cli/commands/project.ts` (project set-models flags; show `model_policy` in the project view)
- Test: `src/cli/__tests__/models.test.ts`, extend project/settings command tests

- [ ] **Step 1: Write the failing test** — use the existing CLI command test harness (invoke the Commander action with a fake service). Assert:
  - `models list` prints one line per catalog entry and a `(stale)` marker when stale.
  - `project set-models <id> --execution-heavy claude-opus-4-8 --validation-default auto` calls `update_project` with the merged `model_policy`.
  - `settings set-models --planning-constant auto` calls `setModelPolicyDefault`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/models.test.ts`
Expected: FAIL — command missing.

- [ ] **Step 3: Write minimal implementation** — register subcommands following the existing Commander patterns in `src/cli/commands/`. The non-interactive flags assemble a partial `ModelPolicy` (category flags `--<role>-<category>`, default flags `--<role>-default`, constant flag `--planning-constant`), validate via `ModelPolicySchema.parse`, then call the project update / settings setter through the CLI's service client. Show `model_policy` in the project detail view (pretty-print the JSON).

- [ ] **Step 4: Run tests + build + lint**

Run: `npx vitest run src/cli/__tests__/ && npm run build && npm run lint`
Expected: PASS; clean; warning-free.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/models.ts src/cli/commands/settings.ts src/cli/commands/project.ts src/cli/__tests__/
git commit -m "feat(cli): models list + project/settings set-models (non-interactive)"
```

### Task 13: API — `GET /models`, `GET|PUT /settings/model-policy`, `model_policy` on project routes

**Files:**
- Create: `src/api/routes/models/index.ts` (`GET /models`)
- Create: `src/api/routes/settings/model-policy.ts` (`GET`/`PUT /settings/model-policy`)
- Modify: `src/api/routes/projects/*` (include `model_policy` in project responses; accept on update — flows via `UpdateProjectSchema`)
- Test: `src/api/__tests__/models.test.ts`, `src/api/__tests__/settings.test.ts`, extend project route tests

- [ ] **Step 1: Write the failing test** — use the existing Fastify `app.inject` harness. Assert:
  - `GET /models` → 200, body `{ models: [...], stale: boolean }`.
  - `PUT /settings/model-policy` with a valid body → 200; `GET /settings/model-policy` returns it; invalid body → 400.
  - `PUT /projects/:id` with `model_policy` persists and `GET /projects/:id` returns it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/__tests__/models.test.ts src/api/__tests__/settings.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Write minimal implementation** — register the routes following existing route module patterns (Zod schema validation, service injection via the app's DI). `GET /models` calls the catalog service; settings routes call `SettingsService`; project routes already carry the DTO field — ensure the response serializer includes `model_policy`.

- [ ] **Step 4: Run tests + build + lint**

Run: `npx vitest run src/api/__tests__/ && npm run build && npm run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/models src/api/routes/settings src/api/routes/projects src/api/__tests__/
git commit -m "feat(api): /models, /settings/model-policy, model_policy on projects"
```

---

## Phase 6 — Skills (interview + dispatch integration)

### Task 14: `/tasks:set-models` adaptive interview skill

**Files:**
- Create: `skills/tasks/set-models.md`
- Modify: `src/skills/__tests__/*` or the skill-count/registry test that enumerates `skills/tasks/*.md` (the suite asserts a known skill set — update the expected count/list; see AGENTS.md "Test-only fix" recipe)

- [ ] **Step 1: Update the skill-registry test** to include `set-models` (find the test that lists known skills; add the entry). Run it to confirm it now expects the new skill and fails because the file is absent.

Run: `npx vitest run -t "skills"` → Expected: FAIL (file missing).

- [ ] **Step 2: Write the skill** — `skills/tasks/set-models.md` with frontmatter (`name: set-models`, `disable-model-invocation: false`, argument-hint `[--global | --project <id>]`). Body specifies the interview procedure verbatim:
  1. Load tools (`ToolSearch` for `list_models`, `resolve_model`, `get_project`, `update_project`, `get_model_defaults`, `set_model_defaults`).
  2. Resolve the target (`--global` → settings; else project by id/name).
  3. Call `list_models`; if `stale`, warn the suggestions are from the static fallback.
  4. For `execution` then `validation`: walk `minimal → maximum`; one `AskUserQuestion` per category; options = discovered models + "Let me decide (auto)". After each pick, set the next category's recommended (first) option to ≥ the last pick's capability (monotonic ladder); `auto` picks are skipped in the ladder.
  5. For `planning`: one question (single model or `auto`); advanced branch to route by category only if requested.
  6. Echo the assembled `ModelPolicy`, confirm, persist via `update_project` (project) or `set_model_defaults` (global).
  7. Print the resolved per-category table back.

- [ ] **Step 3: Run the registry test to verify it passes**

Run: `npx vitest run -t "skills" && npm run build`
Expected: PASS; clean.

- [ ] **Step 4: Sync to dist if the repo tracks `dist/skills`** — the repo has `dist/skills/tasks/*`; confirm whether the build regenerates it (`npm run build`) or it is checked in. If checked in and stale, the build/test will flag it; regenerate per the project's skill-build script.

- [ ] **Step 5: Commit**

```bash
git add skills/tasks/set-models.md src/skills dist/skills 2>/dev/null
git commit -m "feat(skill): /tasks:set-models adaptive model interview"
```

### Task 15: Integrate `resolve_model` into `loop.md` + `loop-dag.md`

**Files:**
- Modify: `skills/tasks/loop.md` (Step 4 worker dispatch; Step 7b verifier dispatch; §2 preflight ToolSearch list; §1 run-arg parsing; §9c LOOP-RUN.md frontmatter)
- Modify: `skills/tasks/loop-dag.md` (§3b worker; §3d verifier; preflight; frontmatter)
- Modify: `skills/tasks/loop-shared.md` (add a shared "§N. Model resolution" block both skills cite)
- Test: the skill-content lint/test if one asserts cross-references resolve (the repo has a README/skill drift check)

- [ ] **Step 1: Add `loop-shared.md` §N — Model resolution** documenting:
  - Roles: worker→`execution`, verifier→`validation`.
  - Procedure: before each `Agent` dispatch, call `resolve_model { project_id, role, task_id }`. On `{ model }` pass `model:` to `Agent`; on `{ model: 'auto' }` call `list_models` and pick the live model matching the slot's power category (worker uses the task's category; verifier likewise); on `null` pass no `model:` (inherit).
  - **Dispatch fallback:** if the `Agent` call errors with an unrecognized-model error, retry once WITHOUT `model:` and log a one-line warning. (Covers the §13 harness-acceptance risk.)
  - Run-arg overrides `--execution-model` / `--validation-model` force a single ref for the run, bypassing per-category resolution.
  - Anti-fabrication note: the resolved model id is read from the `resolve_model` result that returned in a prior turn (consistent with §L).

- [ ] **Step 2: Edit `loop.md`** — at Step 4 and Step 7b add: "Resolve the dispatch model first — see [loop-shared.md §N](loop-shared.md#n-model-resolution)." Add `mcp__wood-fired-tasks__resolve_model` (and `list_models`) to the §2 `ToolSearch` preload list. Add `--execution-model` / `--validation-model` / `--planning-model` to §1 argument parsing. Add the optional `execution_model` / `validation_model` / `planning_model` fields to the §9c frontmatter table (omitted when unset). Mirror in `loop-dag.md` §3b/§3d and its frontmatter section.

- [ ] **Step 3: Run the skill drift / cross-reference checks**

Run: `npm test -- -t "drift" || npx vitest run -t "skill"` (use whichever the repo defines) and `npm run build`.
Expected: PASS; clean. If a README/skill drift test tracks anchors, ensure the new `#n-model-resolution` anchor and cross-refs resolve.

- [ ] **Step 4: Re-run the full suite + lint**

Run: `npm test && npm run lint`
Expected: PASS; warning-free.

- [ ] **Step 5: Commit**

```bash
git add skills/tasks/loop.md skills/tasks/loop-dag.md skills/tasks/loop-shared.md dist/skills 2>/dev/null
git commit -m "feat(skill): resolve_model integration in loop + loop-dag"
```

### Task 16: Integrate `planning` role into `decompose.md` + `audit.md` + integration-auditor

**Files:**
- Modify: `skills/tasks/decompose.md` (recon Explore, planner, critic dispatches → `resolve_model … role=planning`)
- Modify: `skills/tasks/audit.md` (audit agent dispatch)
- Modify: `skills/agents/integration-auditor.md` (note the orchestrator resolves its model via `planning`) and the loop-dag §3f/§4 dispatch sites
- Test: skill drift / build

- [ ] **Step 1: Edit decompose.md** — at each `Agent` dispatch (Step recon, planner, critic) add: "Resolve the model via `resolve_model { project_id, role: 'planning' }` (decompose has no `project_id` until tasks are materialized — use the target project id when known, else skip resolution and inherit the session model). See [loop-shared.md §N]." Note that decompose's recon/planner/critic run before tasks exist, so `task_id` is omitted and the `planning` `constant`/`default` slot governs.

- [ ] **Step 2: Edit audit.md + integration-auditor dispatch** — same `role: 'planning'` resolution before the `Agent` call.

- [ ] **Step 3: Run build + skill drift + full suite**

Run: `npm run build && npm test && npm run lint`
Expected: PASS; warning-free.

- [ ] **Step 4: Update docs** — add the new MCP tools to `docs/MCP.md`, CLI commands to `docs/CLI.md`, routes to `docs/API.md`, and a short "Configurable models" section pointing at `/tasks:set-models`.

- [ ] **Step 5: Commit**

```bash
git add skills/tasks/decompose.md skills/tasks/audit.md skills/agents/integration-auditor.md docs/MCP.md docs/CLI.md docs/API.md dist/skills 2>/dev/null
git commit -m "feat(skill): planning-role model resolution in decompose/audit/integration-auditor + docs"
```

---

## Self-Review

**Spec coverage:** §2 goals → Tasks 1–16. Power categories/bijection → Task 1 + Task 5. `auto` → Tasks 1, 5, 15. Two-layer per-slot merge → Tasks 5–7. Runtime discovery + degrade → Task 8. `list_models`/`resolve_model`/defaults tools → Tasks 9–11. CLI/API → Tasks 12–13. Interview → Task 14. Dispatch integration + harness fallback (§9/§13.1) → Tasks 15–16. Backward compat (NULL columns, conditional registration) → Tasks 3, 11, 15. Testing matrix (§12) → Tasks 1, 3, 5–8.

**Open-question carry-through (§13):** harness model acceptance → Task 15 Step 1 fallback; Models API auth across run modes → Task 8 degrade + Task 11 wiring (`ANTHROPIC_API_KEY`); `auto` ranking heuristic → Task 14 Step 2 (monotonic ladder) + Task 15 §N; planning granularity → Task 16 (constant-first, category-routing optional).

**Type consistency:** `ModelPolicy`, `RolePolicy`, `ModelRef`, `PowerCategory`, `PipelineRole` (`execution|validation|planning`), `ResolvedModel` (`{model}|{model:'auto'}|null`), `ModelCatalog` (`{models,stale}`) used consistently across tasks. Category keys `minimal|light|moderate|strong|heavy|maximum` fixed in Task 1 and reused verbatim. Service factories `createModelPolicyService` / `createSettingsService` / `createModelCatalogService` and registrars `registerModelTools` / `registerModelDefaultsTools` named consistently.

---

## Execution Handoff

Decompose into wood-fired-tasks tasks (per user request) using `/tasks:decompose`, then drain with `/tasks:loop` or `/tasks:loop-dag`.
