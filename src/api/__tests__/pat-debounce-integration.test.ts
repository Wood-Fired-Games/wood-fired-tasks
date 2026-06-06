import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { createServer } from '../server.js';
import { generateToken } from '../../services/pat-hash.js';
import {
  resetDebounceCacheForTests,
  _setLastWriteForTests,
  TTL_MS,
} from '../../services/pat-touch-debounce.js';

/**
 * Phase 28 Plan 06 — chain-plugin integration tests for the PAT-03 debounce.
 *
 * Full-stack `createServer({ dbPath: ':memory:' })`, mints a PAT row inline
 * (no /me/tokens dependency), and spies on
 * `server.apiTokenRepository.touchLastUsed` to count actual SQL writes.
 *
 * Async note: the chain plugin schedules the write via `setImmediate(...)`,
 * so every assertion is preceded by `await new Promise(r => setImmediate(r))`
 * to let the scheduled task run before the spy is read.
 *
 * Each case resets the debounce cache so cases are independent.
 */

function mintPatRow(
  db: Database.Database,
  opts: { userId: number; name?: string },
): { token: string; tokenId: number } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL)`,
    )
    .run(opts.userId, opts.name ?? 'debounce-test-token', prefix, suffix, hash);
  return { token, tokenId: Number(info.lastInsertRowid) };
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('PAT chain plugin — last_used_at debounce (PAT-03)', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let legacyUserId: number;
  let touchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
    await server.ready();

    // The legacy seed creates user with display_name='key_test-key' for the
    // bare 'test-key' entry — reuse it as the owner for our PAT rows.
    const row = db
      .prepare("SELECT id FROM users WHERE display_name = 'key_test-key' LIMIT 1")
      .get() as { id: number } | undefined;
    if (!row) throw new Error('test setup: legacy user not seeded');
    legacyUserId = row.id;

    // Decorated repo instance survives across requests; spy on its prototype-
    // bound method.
    touchSpy = vi.spyOn(
      (server as unknown as { apiTokenRepository: { touchLastUsed: (id: number) => void } })
        .apiTokenRepository,
      'touchLastUsed',
    );
  });

  afterAll(async () => {
    touchSpy.mockRestore();
    await server.close();
    db.close();
  });

  beforeEach(() => {
    resetDebounceCacheForTests();
    touchSpy.mockClear();
  });

  it('case 1: first request with a PAT schedules exactly ONE touchLastUsed call', async () => {
    const { token, tokenId } = mintPatRow(db, { userId: legacyUserId });

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).toHaveBeenCalledWith(tokenId);
  });

  it('case 2: second request with the SAME PAT within TTL → still only ONE call (debounce skipped)', async () => {
    const { token } = mintPatRow(db, { userId: legacyUserId });

    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    await nextTick();

    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    await nextTick();

    expect(touchSpy).toHaveBeenCalledTimes(1);
  });

  it('case 3: after simulated TTL expiry, third request schedules a SECOND call (total 2)', async () => {
    const { token, tokenId } = mintPatRow(db, { userId: legacyUserId });

    // First request: 1 call
    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(1);

    // Second request inside window: still 1 (debounced)
    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(1);

    // Simulate TTL expiry by rewinding the cached timestamp for this token.
    _setLastWriteForTests(tokenId, Date.now() - TTL_MS - 1_000);

    // Third request: gate opens → 2 total
    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(2);
    expect(touchSpy).toHaveBeenLastCalledWith(tokenId);
  });

  it('case 4: different PAT (different tokenId) is independent of first PAT debounce', async () => {
    const first = mintPatRow(db, { userId: legacyUserId, name: 'first' });
    const second = mintPatRow(db, { userId: legacyUserId, name: 'second' });

    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${first.token}` },
    });
    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).toHaveBeenCalledWith(first.tokenId);

    // First PAT is now inside its 10-min window; a request with the SECOND
    // PAT must still schedule a call because the gate keys per-token id.
    await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${second.token}` },
    });
    await nextTick();
    expect(touchSpy).toHaveBeenCalledTimes(2);
    expect(touchSpy).toHaveBeenLastCalledWith(second.tokenId);
  });
});
