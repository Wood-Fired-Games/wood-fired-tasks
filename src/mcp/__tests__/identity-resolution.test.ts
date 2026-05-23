/**
 * Tests for the MCP boot-time actor identity resolver (Phase 31 Plan 03,
 * Task 1).
 *
 * The resolver is the bridge between `process.env.WFB_API_KEY` and the
 * `actorUserId: number` that downstream MCP tool handlers inject into every
 * service write. Three input shapes are valid:
 *
 *   1. `WFB_API_KEY=wfb_pat_<…>`     → resolve via apiTokenRepository.findByHash
 *   2. `WFB_API_KEY=<legacy-key>`    → match against parsed API_KEYS entries
 *                                       (hash compare) and look up the legacy
 *                                       user by label
 *   3. `WFB_API_KEY` absent / unresolved → fall back to the seeded `mcp-bot`
 *                                          service-account row
 *
 * Every miss / revoked / unknown branch falls back to mcp-bot. If mcp-bot
 * itself is not seeded (which should never happen post-Plan-31-01 seeder),
 * the resolver throws with a clear message — the MCP boot path treats this
 * as fatal.
 *
 * Tests use a real in-memory SQLite DB (better-sqlite3) so the apiTokenRepo
 * / userRepo prepared statements and the PAT hashing / legacy hashing code
 * paths run end-to-end. Pattern mirrors `src/cli/__tests__/db-mint-token.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../config/env.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../repositories/api-token.repository.js';
import { generateToken, hashToken } from '../../services/pat-hash.js';
import { resolveActorUserId } from '../identity-resolution.js';

describe('resolveActorUserId', () => {
  let db: Database.Database;
  let userRepo: UserRepository;
  let apiTokenRepo: ApiTokenRepository;
  // Concrete labels used across tests so the parsed API_KEYS entries and the
  // resolution helpers are exercised with the same identifiers the seeder
  // wrote.
  const API_KEYS = 'topsecret-key-1:laptop,another-key-2:agent-bot';

  beforeEach(async () => {
    db = new Database(':memory:');
    await runMigrations(db);
    const silentLogger = { info: () => {}, warn: () => {} };
    seedIdentities(db, parseApiKeyEntries(API_KEYS), silentLogger);
    userRepo = new UserRepository(db);
    apiTokenRepo = new ApiTokenRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function getMcpBotId(): number {
    const bot = userRepo.findServiceAccountByName('mcp-bot');
    if (!bot) {
      throw new Error('test setup: mcp-bot not seeded');
    }
    return bot.id;
  }

  function insertPat(opts: {
    userId: number;
    revokedAt?: string | null;
  }): { token: string } {
    const { token, prefix, suffix, hash } = generateToken();
    db.prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at)
       VALUES (?, 'test', ?, ?, ?, '[]', NULL)`,
    ).run(opts.userId, prefix, suffix, hash);
    if (opts.revokedAt) {
      db.prepare(
        `UPDATE api_tokens SET revoked_at = ? WHERE hash = ?`,
      ).run(opts.revokedAt, hash);
    }
    return { token };
  }

  it('PAT path: returns token.user_id when WFB_API_KEY is a valid non-revoked PAT', () => {
    // Insert a real users row that the PAT will resolve to.
    const insertUser = db
      .prepare(
        `INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`,
      )
      .get('alice', 'alice@example.com') as { id: number };
    const { token } = insertPat({ userId: insertUser.id });

    const actor = resolveActorUserId({
      apiKey: token,
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(insertUser.id);
  });

  it('PAT path: falls back to mcp-bot when the PAT row exists but is revoked', () => {
    const insertUser = db
      .prepare(
        `INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`,
      )
      .get('alice', 'alice@example.com') as { id: number };
    const { token } = insertPat({
      userId: insertUser.id,
      revokedAt: '2026-01-01T00:00:00Z',
    });

    const actor = resolveActorUserId({
      apiKey: token,
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(getMcpBotId());
  });

  it('PAT path: falls back to mcp-bot when the PAT has the prefix but no matching row', () => {
    // A correctly-prefixed but never-inserted PAT.
    const unknownPat = 'wfb_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const actor = resolveActorUserId({
      apiKey: unknownPat,
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(getMcpBotId());
    // Sanity: hashToken of the unknown PAT does not collide with anything.
    expect(apiTokenRepo.findByHash(hashToken(unknownPat))).toBeNull();
  });

  it('legacy path: returns the legacy user.id when WFB_API_KEY matches an API_KEYS entry', () => {
    const actor = resolveActorUserId({
      apiKey: 'topsecret-key-1', // matches label 'laptop' from API_KEYS
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    const laptop = userRepo.findLegacyByDisplayName('laptop');
    expect(laptop).not.toBeNull();
    expect(actor).toBe(laptop!.id);
  });

  it('legacy path: falls back to mcp-bot when WFB_API_KEY matches NO API_KEYS entry', () => {
    const actor = resolveActorUserId({
      apiKey: 'not-a-configured-key',
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(getMcpBotId());
  });

  it('absent path: falls back to mcp-bot when WFB_API_KEY is undefined', () => {
    const actor = resolveActorUserId({
      apiKey: undefined,
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(getMcpBotId());
  });

  it('absent path: falls back to mcp-bot when WFB_API_KEY is empty string', () => {
    const actor = resolveActorUserId({
      apiKey: '',
      apiTokenRepo,
      userRepo,
      apiKeyEntries: parseApiKeyEntries(API_KEYS),
    });

    expect(actor).toBe(getMcpBotId());
  });

  it('throws a clear error when mcp-bot is not seeded and fallback would be needed', () => {
    // Delete the seeded mcp-bot row so the fallback path has nothing to
    // resolve. This should never happen in production (the seeder runs in
    // createApp before resolveActorUserId is called) but it's the documented
    // failure surface called out in Plan 31-03's <action> step.
    db.prepare(
      `DELETE FROM users WHERE is_service_account = 1 AND display_name = 'mcp-bot'`,
    ).run();

    expect(() =>
      resolveActorUserId({
        apiKey: undefined,
        apiTokenRepo,
        userRepo,
        apiKeyEntries: parseApiKeyEntries(API_KEYS),
      }),
    ).toThrow(/mcp-bot/);
  });

  it('emits no stdout output during resolution (Pitfall 5: stdio-compliance)', () => {
    // Capture stdout writes during a resolution call. The resolver must
    // never use console.log or process.stdout.write — any such call would
    // corrupt the JSON-RPC stream when MCP is running over stdio. console.error
    // (stderr) is allowed.
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk as string, ...(rest as []));
    }) as typeof process.stdout.write;

    try {
      resolveActorUserId({
        apiKey: undefined,
        apiTokenRepo,
        userRepo,
        apiKeyEntries: parseApiKeyEntries(API_KEYS),
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes).toEqual([]);
  });
});

describe('createMcpServer ctx arg', () => {
  // Smoke-level: just import and assert the factory tolerates the new
  // trailing `ctx: { actorUserId }` argument. End-to-end "DTO carries
  // created_by_user_id" assertions live in src/mcp/__tests__/task-tools.test.ts
  // (Task 2).
  it('accepts a trailing ctx arg without throwing', async () => {
    const { createTestApp } = await import('../../index.js');
    const { createMcpServer } = await import('../server.js');
    const app = await createTestApp();
    try {
      const server = createMcpServer(
        app.taskService,
        app.projectService,
        app.dependencyService,
        app.commentService,
        app.db,
        { actorUserId: 1 },
      );
      expect(server).toBeDefined();
    } finally {
      app.dispose();
    }
  });
});

