import { describe, it, expect } from 'vitest';
import {
  FibSchema,
  ValueThemeSchema,
  ValueCharterSchema,
  ValueCharterNullableSchema,
} from '../project.schema.js';

describe('project.schema — ValueCharter', () => {
  const validCharter = {
    mission: 'win the checkout wedge',
    value_themes: [
      { name: 'checkout reliability', weight: 8, description: 'no dropped carts' },
    ],
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
      value_themes: [
        { name: 'theme', weight: 4, description: 'd' },
      ],
    };
    const res = ValueCharterSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it('rejects a theme weight of 7 via ValueThemeSchema directly', () => {
    expect(
      ValueThemeSchema.safeParse({ name: 't', weight: 7, description: 'd' })
        .success
    ).toBe(false);
  });

  it('allows null via the nullable charter schema', () => {
    expect(ValueCharterNullableSchema.safeParse(null).success).toBe(true);
    expect(ValueCharterNullableSchema.safeParse(validCharter).success).toBe(
      true
    );
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
    value_themes: [
      { name: 'reliability', weight: 8, description: 'no dropped carts' },
    ],
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
    const { CreateProjectSchema, UpdateProjectSchema } = await import(
      '../task.schema.js'
    );
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
    expect(
      UpdateProjectSchema.safeParse({ value_charter: null }).success
    ).toBe(true);
    expect(
      CreateProjectSchema.safeParse({
        name: 'p',
        value_charter: { ...validCharter, value_themes: [{ name: 't', weight: 7, description: 'd' }] },
      }).success
    ).toBe(false);
  });
});
