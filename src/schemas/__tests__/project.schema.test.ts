import { describe, it, expect } from 'vitest';
import {
  FibSchema,
  ValueThemeSchema,
  ValueCharterSchema,
  ValueCharterNullableSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  ArchiveProjectSchema,
  ArchivedFilterSchema,
} from '../project.schema.js';
import * as taskSchemaBarrel from '../task.schema.js';
import { TaskFiltersSchema, ListTasksMcpSchema } from '../task.schema.js';
import { ProjectResponseSchema } from '../../api/routes/projects/schemas.js';

describe('project.schema — ValueCharter', () => {
  const validCharter = {
    mission: 'win the checkout wedge',
    value_themes: [{ name: 'checkout reliability', weight: 8, description: 'no dropped carts' }],
    time_context: 'launch window Q3',
    risk_posture: 'security + outage first',
    out_of_scope: ['marketing site'],
    interview_version: 1,
    updated_at: '2026-06-01T00:00:00.000Z',
  };

  it('FibSchema accepts every Fibonacci tier and rejects off-scale values', () => {
    for (const f of [1, 2, 3, 5, 8, 13]) {
      expect(FibSchema.safeParse(f).success).toBe(true);
    }
    for (const bad of [0, 4, 6, 7, 9, 13.5, -1]) {
      expect(FibSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts a well-formed charter', () => {
    const res = ValueCharterSchema.safeParse(validCharter);
    expect(res.success).toBe(true);
  });

  it('rejects a non-Fibonacci theme weight', () => {
    const bad = {
      ...validCharter,
      value_themes: [{ name: 'theme', weight: 4, description: 'd' }],
    };
    const res = ValueCharterSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it('rejects a theme weight of 7 via ValueThemeSchema directly', () => {
    expect(ValueThemeSchema.safeParse({ name: 't', weight: 7, description: 'd' }).success).toBe(
      false,
    );
  });

  it('allows null via the nullable charter schema', () => {
    expect(ValueCharterNullableSchema.safeParse(null).success).toBe(true);
    expect(ValueCharterNullableSchema.safeParse(validCharter).success).toBe(true);
  });

  it('rejects a charter missing the required mission field', () => {
    const { mission: _omit, ...rest } = validCharter;
    expect(ValueCharterSchema.safeParse(rest).success).toBe(false);
  });
});

/**
 * Regression guard for the remote-transport value_charter parity bug: the REST
 * project routes and the remote MCP proxy both import the project create/update
 * schemas from `task.schema.ts`. A stale local duplicate there silently lacked
 * `value_charter`, so the entire remote (REST + proxy) write path stripped the
 * charter while stdio worked. These assertions fail loudly if the barrel ever
 * re-diverges from the canonical `project.schema.ts` source of truth.
 */
describe('project schema parity (task.schema barrel ≡ project.schema source)', () => {
  const validCharter = {
    mission: 'win the checkout wedge',
    value_themes: [{ name: 'reliability', weight: 8, description: 'no dropped carts' }],
    time_context: 'launch window Q3',
    risk_posture: 'security + outage first',
    out_of_scope: ['marketing site'],
    interview_version: 1,
    updated_at: '2026-06-01T00:00:00.000Z',
  };

  it('re-exports the identical canonical Create/Update project schemas', async () => {
    const project = await import('../project.schema.js');
    const barrel = await import('../task.schema.js');
    // Referential identity — the barrel must forward, never re-declare.
    expect(barrel.CreateProjectSchema).toBe(project.CreateProjectSchema);
    expect(barrel.UpdateProjectSchema).toBe(project.UpdateProjectSchema);
  });

  it('the barrel Create/Update schemas accept and retain a value_charter', async () => {
    const { CreateProjectSchema, UpdateProjectSchema } = await import('../task.schema.js');
    const created = CreateProjectSchema.safeParse({
      name: 'p',
      value_charter: validCharter,
    });
    expect(created.success).toBe(true);
    expect(created.success && created.data.value_charter).toEqual(validCharter);

    const updated = UpdateProjectSchema.safeParse({ value_charter: validCharter });
    expect(updated.success).toBe(true);
    expect(updated.success && updated.data.value_charter).toEqual(validCharter);

    // null clears; a malformed charter (off-scale weight) is rejected.
    expect(UpdateProjectSchema.safeParse({ value_charter: null }).success).toBe(true);
    expect(
      CreateProjectSchema.safeParse({
        name: 'p',
        value_charter: {
          ...validCharter,
          value_themes: [{ name: 't', weight: 7, description: 'd' }],
        },
      }).success,
    ).toBe(false);
  });
});

/**
 * Configurable Task Models (task #911): `model_policy` rides onto the project
 * create/update DTOs the same way `value_charter` does —
 * `ModelPolicyNullableSchema.optional()`. An object is preserved on parse,
 * explicit `null` round-trips as `null` (clear), and absence is `undefined`.
 */
describe('project.schema — model_policy DTO wiring', () => {
  it('accepts model_policy on update', () => {
    const parsed = UpdateProjectSchema.parse({ model_policy: { execution: { default: 'auto' } } });
    expect(parsed.model_policy).toEqual({ execution: { default: 'auto' } });
  });

  it('accepts explicit null model_policy (clear)', () => {
    expect(UpdateProjectSchema.parse({ model_policy: null }).model_policy).toBeNull();
  });

  it('accepts model_policy on create and preserves the field', () => {
    const parsed = CreateProjectSchema.parse({
      name: 'p',
      model_policy: { execution: { default: 'auto' } },
    });
    expect(parsed.model_policy).toEqual({ execution: { default: 'auto' } });
  });
});

/**
 * Archived project state (docs/design/project-archived-state.md §2.2, §3.2).
 */
describe('project.schema — ArchiveProjectSchema', () => {
  it('accepts an empty body (plain archive)', () => {
    expect(ArchiveProjectSchema.parse({})).toEqual({});
  });

  it('accepts an optional reason without force', () => {
    expect(ArchiveProjectSchema.parse({ reason: 'shipped in v2.9.0' })).toEqual({
      reason: 'shipped in v2.9.0',
    });
  });

  it('accepts force: true with a reason', () => {
    expect(ArchiveProjectSchema.parse({ force: true, reason: 'abandoned' })).toEqual({
      force: true,
      reason: 'abandoned',
    });
  });

  it('rejects force: true without reason', () => {
    const res = ArchiveProjectSchema.safeParse({ force: true });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['reason']);
  });

  it('rejects force: true with an empty or whitespace-only reason', () => {
    expect(ArchiveProjectSchema.safeParse({ force: true, reason: '' }).success).toBe(false);
    expect(ArchiveProjectSchema.safeParse({ force: true, reason: '   ' }).success).toBe(false);
  });

  it('accepts force: false without reason', () => {
    expect(ArchiveProjectSchema.safeParse({ force: false }).success).toBe(true);
  });

  it('caps reason at 500 characters', () => {
    expect(ArchiveProjectSchema.safeParse({ reason: 'x'.repeat(500) }).success).toBe(true);
    expect(ArchiveProjectSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects a non-boolean force', () => {
    expect(ArchiveProjectSchema.safeParse({ force: 'yes', reason: 'r' }).success).toBe(false);
  });
});

describe('project.schema — ArchivedFilterSchema', () => {
  it('accepts exclude, include and only', () => {
    for (const value of ['exclude', 'include', 'only']) {
      expect(ArchivedFilterSchema.parse(value)).toBe(value);
    }
  });

  it('defaults to exclude when absent', () => {
    expect(ArchivedFilterSchema.parse(undefined)).toBe('exclude');
  });

  it('rejects any other value', () => {
    for (const bad of ['all', 'true', '', true, null]) {
      expect(ArchivedFilterSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is re-exported from the task.schema barrel (same object)', () => {
    expect(taskSchemaBarrel.ArchivedFilterSchema).toBe(ArchivedFilterSchema);
    expect(taskSchemaBarrel.ArchiveProjectSchema).toBe(ArchiveProjectSchema);
  });
});

describe('task.schema — archived filter', () => {
  it.each([
    ['TaskFiltersSchema', TaskFiltersSchema],
    ['ListTasksMcpSchema', ListTasksMcpSchema],
  ])('%s accepts each archived value and keeps it', (_name, schema) => {
    for (const value of ['exclude', 'include', 'only'] as const) {
      expect(schema.parse({ archived: value }).archived).toBe(value);
    }
  });

  it.each([
    ['TaskFiltersSchema', TaskFiltersSchema],
    ['ListTasksMcpSchema', ListTasksMcpSchema],
  ])(
    '%s leaves archived undefined when absent (the repository applies the default)',
    (_name, schema) => {
      const parsed = schema.parse({});
      expect(parsed.archived).toBeUndefined();
      expect('archived' in parsed).toBe(false);
    },
  );

  it.each([
    ['TaskFiltersSchema', TaskFiltersSchema],
    ['ListTasksMcpSchema', ListTasksMcpSchema],
  ])('%s rejects an unknown archived value', (_name, schema) => {
    expect(schema.safeParse({ archived: 'all' }).success).toBe(false);
  });
});

describe('ProjectResponseSchema — archived fields', () => {
  const base = {
    id: 1,
    name: 'p',
    description: null,
    created_at: '2026-11-23 12:00:00',
    updated_at: '2026-11-23 12:00:00',
  };

  it('keeps the four archived fields instead of stripping them', () => {
    const archived = {
      archived: true,
      archived_at: '2026-11-23T12:00:00.000Z',
      archived_by: 'alice',
      archive_reason: 'shipped',
    };
    expect(ProjectResponseSchema.parse({ ...base, ...archived })).toEqual({ ...base, ...archived });
  });

  it('keeps null archive columns on an unarchived project', () => {
    const active = { archived: false, archived_at: null, archived_by: null, archive_reason: null };
    expect(ProjectResponseSchema.parse({ ...base, ...active })).toEqual({ ...base, ...active });
  });

  it('still parses a response without the fields (old server)', () => {
    expect(ProjectResponseSchema.parse(base)).toEqual(base);
  });
});
