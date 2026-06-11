import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { createSettingsRepository } from '../../repositories/settings.repository.js';
import { createSettingsService } from '../settings.service.js';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';
import type Database from '../../db/driver.js';

describe('settings service — model policy default', () => {
  describe('with an in-memory store (pure deps)', () => {
    const makeService = (store: { v: string | null }) =>
      createSettingsService({
        readModelPolicyDefault: () => store.v,
        writeModelPolicyDefault: (json) => {
          store.v = json;
        },
      });

    it('returns null before any default is set', () => {
      const svc = makeService({ v: null });
      expect(svc.getModelPolicyDefault()).toBeNull();
    });

    it('validates against ModelPolicySchema on write and round-trips', () => {
      const store: { v: string | null } = { v: null };
      const svc = makeService(store);
      const policy: ModelPolicy = { planning: { constant: 'auto' } };

      svc.setModelPolicyDefault(policy);

      expect(store.v).toBe(JSON.stringify(policy));
      expect(svc.getModelPolicyDefault()).toEqual(policy);
    });

    it('round-trips a richer category-routed policy', () => {
      const store: { v: string | null } = { v: null };
      const svc = makeService(store);
      const policy: ModelPolicy = {
        execution: { byCategory: { moderate: 'claude-sonnet-4-6', maximum: 'auto' } },
        validation: { constant: 'claude-haiku-4-5' },
        planning: { default: 'auto' },
      };

      svc.setModelPolicyDefault(policy);

      expect(svc.getModelPolicyDefault()).toEqual(policy);
    });

    it('rejects an invalid policy on write (ModelPolicySchema rejects it)', () => {
      const store: { v: string | null } = { v: null };
      const svc = makeService(store);

      // `byFib` is not a RolePolicy key — `.strict()` rejects it.
      expect(() => svc.setModelPolicyDefault({ execution: { byFib: {} } } as never)).toThrow();
      // Nothing persisted: validation happens BEFORE the write.
      expect(store.v).toBeNull();
      expect(svc.getModelPolicyDefault()).toBeNull();
    });

    it('rejects an unknown role key', () => {
      const svc = makeService({ v: null });
      expect(() =>
        svc.setModelPolicyDefault({ orchestrator: { constant: 'auto' } } as never),
      ).toThrow();
    });

    it('memoizes the parsed default and invalidates on set (task #931)', () => {
      let reads = 0;
      const store: { v: string | null } = { v: JSON.stringify({ planning: { constant: 'auto' } }) };
      const svc = createSettingsService({
        readModelPolicyDefault: () => {
          reads += 1;
          return store.v;
        },
        writeModelPolicyDefault: (json) => {
          store.v = json;
        },
      });

      expect(svc.getModelPolicyDefault()).toEqual({ planning: { constant: 'auto' } });
      expect(svc.getModelPolicyDefault()).toEqual({ planning: { constant: 'auto' } });
      // The second read is served from the memo — no raw re-read / re-parse.
      expect(reads).toBe(1);

      // A rewrite invalidates: the next read re-reads and returns the NEW policy.
      svc.setModelPolicyDefault({ planning: { constant: 'claude-opus-4-8' } });
      expect(svc.getModelPolicyDefault()).toEqual({ planning: { constant: 'claude-opus-4-8' } });
      expect(reads).toBe(2);

      // A REJECTED write changes nothing, so the memo survives intact.
      expect(() => svc.setModelPolicyDefault({ execution: { byFib: {} } } as never)).toThrow();
      expect(svc.getModelPolicyDefault()).toEqual({ planning: { constant: 'claude-opus-4-8' } });
      expect(reads).toBe(2);

      // Clearing invalidates too: the next read sees the NULL column.
      svc.setModelPolicyDefault(null);
      expect(svc.getModelPolicyDefault()).toBeNull();
      expect(reads).toBe(3);
    });

    it('clears the default when passed null (writes NULL)', () => {
      const store: { v: string | null } = { v: JSON.stringify({ planning: { constant: 'auto' } }) };
      const svc = makeService(store);

      svc.setModelPolicyDefault(null);

      expect(store.v).toBeNull();
      expect(svc.getModelPolicyDefault()).toBeNull();
    });
  });

  describe('over the real repository + migrated in-memory DB', () => {
    let db: Database.Database;
    let svc: ReturnType<typeof createSettingsService>;

    beforeEach(async () => {
      db = initDatabase(':memory:');
      await runMigrations(db);
      const repo = createSettingsRepository(db);
      svc = createSettingsService({
        readModelPolicyDefault: () => repo.readModelPolicyDefault(),
        writeModelPolicyDefault: (json) => repo.writeModelPolicyDefault(json),
      });
    });

    it('returns null on the freshly migrated (seeded NULL) singleton row', () => {
      expect(svc.getModelPolicyDefault()).toBeNull();
    });

    it('persists and round-trips a policy through the app_settings row', () => {
      const policy: ModelPolicy = {
        execution: { byCategory: { strong: 'claude-opus-4-8' } },
        planning: { constant: 'auto' },
      };

      svc.setModelPolicyDefault(policy);

      expect(svc.getModelPolicyDefault()).toEqual(policy);
      // Verify it actually landed in the singleton row as JSON TEXT.
      const raw = (
        db.prepare('SELECT model_policy_default FROM app_settings WHERE id = 1').get() as {
          model_policy_default: string | null;
        }
      ).model_policy_default;
      expect(raw).toBe(JSON.stringify(policy));
    });

    it('clears a previously set default back to NULL', () => {
      svc.setModelPolicyDefault({ planning: { constant: 'auto' } });
      expect(svc.getModelPolicyDefault()).not.toBeNull();

      svc.setModelPolicyDefault(null);

      expect(svc.getModelPolicyDefault()).toBeNull();
      const raw = (
        db.prepare('SELECT model_policy_default FROM app_settings WHERE id = 1').get() as {
          model_policy_default: string | null;
        }
      ).model_policy_default;
      expect(raw).toBeNull();
    });

    it('does not persist an invalid policy', () => {
      expect(() => svc.setModelPolicyDefault({ execution: { byFib: {} } } as never)).toThrow();
      expect(svc.getModelPolicyDefault()).toBeNull();
    });
  });
});
