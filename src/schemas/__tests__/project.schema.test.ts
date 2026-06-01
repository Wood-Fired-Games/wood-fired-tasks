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
