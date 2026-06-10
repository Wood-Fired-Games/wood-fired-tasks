import { describe, it, expect } from 'vitest';
import {
  ModelRefSchema,
  PowerCategorySchema,
  POWER_CATEGORIES,
  RolePolicySchema,
  ModelPolicySchema,
  ModelPolicyNullableSchema,
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
    expect(POWER_CATEGORIES).toEqual([
      'minimal',
      'light',
      'moderate',
      'strong',
      'heavy',
      'maximum',
    ]);
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

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => ModelPolicySchema.parse({ orchestrator: { constant: 'x' } })).toThrow();
  });

  it('rejects unknown per-role keys (strict)', () => {
    expect(() => RolePolicySchema.parse({ byFib: {} })).toThrow();
    expect(() => ModelPolicySchema.parse({ execution: { byFib: {} } })).toThrow();
  });

  it('round-trips null via the nullable variant', () => {
    expect(ModelPolicyNullableSchema.parse(null)).toBeNull();
  });
});
