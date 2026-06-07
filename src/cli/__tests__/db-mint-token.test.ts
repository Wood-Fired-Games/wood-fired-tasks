/**
 * In-process tests for src/cli/commands/db-mint-token.ts (28-07).
 *
 * Uses a real temp-file SQLite DB so the command's internal `initDatabase` +
 * `runMigrations` path runs against actual schema. Asserts:
 *   - --user resolution via findById (numeric), findByEmail, findLegacyByDisplayName
 *   - happy-path stdout shape
 *   - the printed token's SHA-256 matches the row's hash
 *   - --scopes serialization
 *   - --expires-at strict ISO validation
 *   - failure modes do NOT insert any api_tokens row
 *
 * Coexists with src/cli/__tests__/db-check.test.ts (existing flat command);
 * a parser-integration smoke test for `tasks db mint-token` is added in Task 2.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from '../../db/driver.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../config/env.js';

// Side-effect import of env config is a no-op for these tests.
vi.mock('../config/env.js', () => ({}));

interface ApiTokenRow {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  suffix: string;
  hash: string;
  scopes: string;
  expires_at: string | null;
}

interface UserRow {
  id: number;
  display_name: string;
  email: string | null;
}

describe('db-mint-token command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedApiKeys = process.env.API_KEYS;

  beforeEach(async () => {
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    tmpDir = mkdtempSync(join(tmpdir(), 'wft-dbmint-'));
    dbPath = join(tmpDir, 'tasks.db');

    // Seed: migrations + a legacy user (display_name=legacy-key, is_legacy=1).
    // Then insert a non-legacy user with email='alice@example.com' for the
    // email-resolution path.
    const db = new Database(dbPath);
    await runMigrations(db);

    // Use a silent logger so seeder noise doesn't pollute test output.
    const silentLogger = { info: () => {}, warn: () => {} };
    seedIdentities(db, parseApiKeyEntries('test-key:legacy-key'), silentLogger);

    // v2.0 cutover (#801): the seeder no longer creates is_legacy credential
    // rows from API_KEYS, so seed the legacy 'legacy-key' user directly. The
    // db-mint-token command still resolves --user against is_legacy rows via
    // findLegacyByDisplayName, so this row exercises that path unchanged.
    db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('legacy-key');

    db.prepare(`INSERT INTO users (display_name, email, is_legacy) VALUES (?, ?, 0)`).run(
      'alice',
      'alice@example.com',
    );

    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    if (savedApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = savedApiKeys;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  function readTokens(): ApiTokenRow[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT * FROM api_tokens ORDER BY id ASC').all() as ApiTokenRow[];
    } finally {
      db.close();
    }
  }

  function readUser(predicate: string, ...args: unknown[]): UserRow | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        (db.prepare(`SELECT id, display_name, email FROM users WHERE ${predicate}`).get(...args) as
          | UserRow
          | undefined) ?? null
      );
    } finally {
      db.close();
    }
  }

  function loggedStdout(): string {
    return consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  function loggedStderr(): string {
    return consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('Case 1: happy path with numeric --user', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const legacy = readUser("display_name = 'legacy-key'");
    expect(legacy).not.toBeNull();

    await dbMintTokenCommand.parseAsync(['--user', String(legacy!.id), '--name', 'laptop'], {
      from: 'user',
    });

    const stdout = loggedStdout();
    expect(process.exitCode).toBe(0);
    expect(stdout).toMatch(/Token: wft_pat_[A-Z2-7]{32}/);
    expect(stdout).toContain('Id:');
    expect(stdout).toContain(`User: ${legacy!.id} (legacy-key)`);

    const rows = readTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(legacy!.id);
    expect(rows[0].name).toBe('laptop');
    expect(rows[0].prefix).toBe('wft_pat_');

    // Round-trip: extract token from stdout, hash it, verify match.
    const match = stdout.match(/Token: (wft_pat_[A-Z2-7]{32})/);
    expect(match).not.toBeNull();
    const printedToken = match![1];
    const expectedHash = createHash('sha256').update(printedToken).digest('hex');
    expect(rows[0].hash).toBe(expectedHash);
    expect(printedToken.endsWith(rows[0].suffix)).toBe(true);
  });

  it('Case 2: --user resolves by email (case-insensitive)', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const alice = readUser("email = 'alice@example.com'");
    expect(alice).not.toBeNull();

    await dbMintTokenCommand.parseAsync(['--user', 'ALICE@example.com', '--name', 'api-bot'], {
      from: 'user',
    });

    const stdout = loggedStdout();
    expect(process.exitCode).toBe(0);
    expect(stdout).toContain(`User: ${alice!.id} (alice)`);

    const rows = readTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(alice!.id);
    expect(rows[0].name).toBe('api-bot');
  });

  it('Case 3: --user resolves by legacy display_name', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const legacy = readUser("display_name = 'legacy-key'");
    expect(legacy).not.toBeNull();

    await dbMintTokenCommand.parseAsync(['--user', 'legacy-key', '--name', 'foo'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    expect(loggedStdout()).toContain(`User: ${legacy!.id} (legacy-key)`);
    expect(readTokens()).toHaveLength(1);
  });

  it('Case 3b: --user resolves by service-account display_name (v2.0 #801 bootstrap)', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    // `mcp-bot` is seeded as is_service_account=1 by seedIdentities in beforeEach.
    // After the v2.0 cutover this is the documented no-OIDC bootstrap target.
    const svc = readUser("display_name = 'mcp-bot' AND is_service_account = 1");
    expect(svc).not.toBeNull();

    await dbMintTokenCommand.parseAsync(['--user', 'mcp-bot', '--name', 'bootstrap'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    expect(loggedStdout()).toContain(`User: ${svc!.id} (mcp-bot)`);
    const rows = readTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(svc!.id);
  });

  it('Case 4: unknown numeric --user prints "User \'99999\' not found." and exits 1', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    await dbMintTokenCommand.parseAsync(['--user', '99999', '--name', 'foo'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toContain("User '99999' not found.");
    expect(readTokens()).toHaveLength(0);
  });

  it('Case 5: unknown string --user prints "User \'nobody\' not found." and exits 1', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    await dbMintTokenCommand.parseAsync(['--user', 'nobody', '--name', 'foo'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toContain("User 'nobody' not found.");
    expect(readTokens()).toHaveLength(0);
  });

  it('Case 6: --scopes serializes csv to JSON array on the row', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const legacy = readUser("display_name = 'legacy-key'");
    await dbMintTokenCommand.parseAsync(
      ['--user', String(legacy!.id), '--name', 'foo', '--scopes', 'admin,reader'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(loggedStdout()).toContain('Scopes: [admin, reader]');

    const rows = readTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].scopes).toBe('["admin","reader"]');
  });

  it('Case 7: --expires-at valid ISO is stored and printed', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const legacy = readUser("display_name = 'legacy-key'");
    await dbMintTokenCommand.parseAsync(
      ['--user', String(legacy!.id), '--name', 'foo', '--expires-at', '2027-05-22T00:00:00Z'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(loggedStdout()).toContain('Expires: 2027-05-22T00:00:00Z');

    const rows = readTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBe('2027-05-22T00:00:00Z');
  });

  it('Case 8: --expires-at invalid format exits 1 with clear error, no row inserted', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    const legacy = readUser("display_name = 'legacy-key'");
    await dbMintTokenCommand.parseAsync(
      ['--user', String(legacy!.id), '--name', 'foo', '--expires-at', 'not-a-date'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toMatch(/expires-at/);
    expect(readTokens()).toHaveLength(0);
  });

  it('Case 9: missing --name surfaces commander error', async () => {
    const { dbMintTokenCommand } = await import('../commands/db-mint-token.js');
    dbMintTokenCommand.exitOverride();

    // commander throws CommanderError on missing requiredOption when
    // exitOverride() is set. Capture and assert exitCode === 1.
    let caught: unknown;
    try {
      await dbMintTokenCommand.parseAsync(['--user', '1'], { from: 'user' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { exitCode?: number; code?: string }).exitCode).toBe(1);
    // No token row created.
    expect(readTokens()).toHaveLength(0);
  });

  describe('parser integration (Task 2)', () => {
    it("routes ['db', 'mint-token', ...] through the program registry", async () => {
      const { program } = await import('../bin/tasks.js');
      program.exitOverride();

      const legacy = readUser("display_name = 'legacy-key'");
      expect(legacy).not.toBeNull();

      await program.parseAsync([
        'node',
        'tasks',
        'db',
        'mint-token',
        '--user',
        String(legacy!.id),
        '--name',
        'integration',
      ]);

      expect(process.exitCode).toBe(0);
      const stdout = loggedStdout();
      expect(stdout).toMatch(/Token: wft_pat_[A-Z2-7]{32}/);
      expect(stdout).toContain(`User: ${legacy!.id} (legacy-key)`);

      const rows = readTokens();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('integration');
    });

    it("keeps flat 'db-check' subcommand registered (backward compat)", async () => {
      const { program } = await import('../bin/tasks.js');
      // db-check is registered as a top-level Command on the program — assert
      // by name lookup, not by re-parsing (db-check writes to stdout via
      // chalk-coloured output and exercises a real DB path covered elsewhere).
      const names = program.commands.map((c) => c.name());
      expect(names).toContain('db-check');
      expect(names).toContain('db');
    });
  });
});
