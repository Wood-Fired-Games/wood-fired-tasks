import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdempotencyService } from '../idempotency.service.js';
import { initTestDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import type Database from '../../db/driver.js';

describe('IdempotencyService', () => {
  let db: Database.Database;
  let service: IdempotencyService;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
    service = new IdempotencyService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('get', () => {
    it('returns null for unknown key', () => {
      const result = service.get('nonexistent-key');
      expect(result).toBeNull();
    });

    it('returns cached response after set', () => {
      const response = { id: 1, title: 'Test Task', status: 'in_progress' };
      service.set('key-123', response);

      const cached = service.get('key-123');
      expect(cached).toEqual(response);
    });

    it('returns null for expired keys (older than 24 hours)', () => {
      // Insert with old timestamp directly
      db.prepare(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES (?, ?, datetime('now', '-25 hours'))`
      ).run('old-key', JSON.stringify({ id: 1 }));

      const result = service.get('old-key');
      expect(result).toBeNull();
    });

    it('returns response for non-expired keys', () => {
      // Insert with recent timestamp
      db.prepare(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES (?, ?, datetime('now', '-23 hours'))`
      ).run('recent-key', JSON.stringify({ id: 2 }));

      const result = service.get('recent-key');
      expect(result).toEqual({ id: 2 });
    });
  });

  describe('set', () => {
    it('stores response that can be retrieved', () => {
      const response = { claimed: true, assignee: 'agent-1' };
      service.set('claim-key', response);

      const cached = service.get('claim-key');
      expect(cached).toEqual(response);
    });

    it('overwrites existing key with new response', () => {
      service.set('dup-key', { version: 1 });
      service.set('dup-key', { version: 2 });

      const cached = service.get('dup-key');
      expect(cached).toEqual({ version: 2 });
    });
  });

  describe('cleanup', () => {
    it('removes expired keys and returns count', () => {
      // Insert expired keys
      db.prepare(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES (?, ?, datetime('now', '-25 hours'))`
      ).run('expired-1', JSON.stringify({}));
      db.prepare(
        `INSERT INTO idempotency_keys (key, response, created_at)
         VALUES (?, ?, datetime('now', '-48 hours'))`
      ).run('expired-2', JSON.stringify({}));

      // Insert non-expired key
      service.set('fresh-key', { active: true });

      const removed = service.cleanup();
      expect(removed).toBe(2);

      // Fresh key should still exist
      expect(service.get('fresh-key')).toEqual({ active: true });
      // Expired keys should be gone
      expect(service.get('expired-1')).toBeNull();
      expect(service.get('expired-2')).toBeNull();
    });

    it('returns 0 when no expired keys exist', () => {
      service.set('fresh', { ok: true });
      const removed = service.cleanup();
      expect(removed).toBe(0);
    });
  });
});
