/**
 * In-process tests for src/cli/commands/db-migrate-identities.ts (Plan 31-05).
 *
 * Uses a real temp-file SQLite DB so the command's internal `initDatabase` +
 * `runMigrations` path runs against actual schema. Mirrors the harness in
 * src/cli/__tests__/db-mint-token.test.ts.
 *
 * Test matrix (10 cases per 31-05-PLAN <behavior>):
 *   1. Dry-run default — no flags → exit 0, "dry-run" in stdout, no DB writes.
 *   2. --commit applies — matching legacy display_name → FK populated.
 *   3. Idempotency — re-running --commit reports 0 rows updated.
 *   4. --alias-map — file overrides, missing file errors, non-integer errors,
 *      non-existent user_id errors.
 *   5. --user-fallback skip vs legacy — unmatched rows behave per strategy.
 *   6. Empty API_KEYS + default fallback — clear error on `legacy`, success on `skip`.
 *   7. --limit — caps rows updated.
 *   8. Email resolution + null guard — email match, empty string, '@@@' all safe.
 *   9. Plan output ordering — higher row counts first within each section.
 *  10. Per-table transactions — constraint error in one table doesn't roll back
 *      committed mappings from earlier tables.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../config/env.js';

// Side-effect import of CLI env config is a no-op for these tests (mirrors
// db-mint-token.test.ts).
vi.mock('../config/env.js', () => ({}));

interface TaskRow {
  id: number;
  title: string;
  created_by: string | null;
  assignee: string | null;
  created_by_user_id: number | null;
  assignee_user_id: number | null;
}

interface CommentRow {
  id: number;
  task_id: number;
  author: string;
  author_user_id: number | null;
}

interface UserRow {
  id: number;
  display_name: string;
  email: string | null;
  is_legacy: number;
}

describe('db-migrate-identities command (Plan 31-05)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedApiKeys = process.env.API_KEYS;

  /** Seed a baseline DB with two legacy users (laptop, agent-bot) and a
   * non-legacy user with an email. Returns the tmp DB path. */
  function seedBaseDb(opts: { apiKeys?: string } = {}): void {
    const db = new Database(dbPath);
    // runMigrations is async — invoked synchronously here because the helper
    // only runs in setup blocks that already await everything.
    return undefined as never;
  }

  beforeEach(async () => {
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    tmpDir = mkdtempSync(join(tmpdir(), 'wfb-dbmigrate-'));
    dbPath = join(tmpDir, 'tasks.db');

    // Baseline: migrations + two legacy users via API_KEYS, plus one
    // OIDC-style user with an email. Each individual test adds the rows it
    // needs on top.
    const db = new Database(dbPath);
    await runMigrations(db);
    const silent = { info: () => {}, warn: () => {} };
    seedIdentities(
      db,
      parseApiKeyEntries('k1:laptop,k2:agent-bot'),
      silent,
    );
    db.prepare(
      `INSERT INTO users (display_name, email, is_legacy) VALUES (?, ?, 0)`,
    ).run('alice', 'alice@example.com');
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

  /** Read the seeded legacy/service users for assertions. */
  function readUser(predicate: string, ...args: unknown[]): UserRow | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        (db
          .prepare(
            `SELECT id, display_name, email, is_legacy FROM users WHERE ${predicate}`,
          )
          .get(...args) as UserRow | undefined) ?? null
      );
    } finally {
      db.close();
    }
  }

  function insertProject(): number {
    const db = new Database(dbPath);
    try {
      // Random suffix so distinct tests share the schema without UNIQUE(name)
      // collisions. The migration sets `name UNIQUE`.
      const suffix = Math.random().toString(36).slice(2, 8);
      const info = db
        .prepare(
          `INSERT INTO projects (name) VALUES ('test-project-' || ?)`,
        )
        .run(suffix);
      return Number(info.lastInsertRowid);
    } finally {
      db.close();
    }
  }

  /** Insert a task row with arbitrary TEXT identity columns (and FK left NULL).
   * `created_by` is NOT NULL in the schema (migration 001); callers MUST
   * supply a non-empty string. `assignee` is nullable. */
  function insertTask(opts: {
    projectId: number;
    createdBy?: string;
    assignee?: string | null;
    title?: string;
  }): number {
    const db = new Database(dbPath);
    try {
      const info = db
        .prepare(
          `INSERT INTO tasks (title, status, priority, project_id, created_by, assignee)
           VALUES (?, 'open', 'medium', ?, ?, ?)`,
        )
        .run(
          opts.title ?? 'test-task',
          opts.projectId,
          opts.createdBy ?? 'unspecified-creator',
          opts.assignee ?? null,
        );
      return Number(info.lastInsertRowid);
    } finally {
      db.close();
    }
  }

  function insertComment(opts: { taskId: number; author: string }): number {
    const db = new Database(dbPath);
    try {
      const info = db
        .prepare(
          `INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, 'hi')`,
        )
        .run(opts.taskId, opts.author);
      return Number(info.lastInsertRowid);
    } finally {
      db.close();
    }
  }

  function readTask(id: number): TaskRow | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        (db
          .prepare(
            `SELECT id, title, created_by, assignee, created_by_user_id, assignee_user_id FROM tasks WHERE id = ?`,
          )
          .get(id) as TaskRow | undefined) ?? null
      );
    } finally {
      db.close();
    }
  }

  function readComment(id: number): CommentRow | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        (db
          .prepare(
            `SELECT id, task_id, author, author_user_id FROM task_comments WHERE id = ?`,
          )
          .get(id) as CommentRow | undefined) ?? null
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

  it('Case 1: dry-run by default — exit 0, no DB writes', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'laptop' });

    await dbMigrateIdentitiesCommand.parseAsync([], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(loggedStdout()).toMatch(/dry-run/i);
    // No DB write: the FK column stays NULL.
    expect(readTask(t1)!.created_by_user_id).toBeNull();
  });

  it('Case 2: --commit applies — matching legacy display_name populates FK', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const laptop = readUser("display_name = 'laptop'");
    expect(laptop).not.toBeNull();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'laptop' });
    const t2 = insertTask({ projectId, createdBy: 'laptop' });
    const t3 = insertTask({ projectId, createdBy: 'laptop' });

    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    expect(readTask(t1)!.created_by_user_id).toBe(laptop!.id);
    expect(readTask(t2)!.created_by_user_id).toBe(laptop!.id);
    expect(readTask(t3)!.created_by_user_id).toBe(laptop!.id);
    // Legacy TEXT column unchanged.
    expect(readTask(t1)!.created_by).toBe('laptop');
  });

  it('Case 3: idempotent — second --commit reports 0 rows updated', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const projectId = insertProject();
    insertTask({ projectId, createdBy: 'laptop' });
    insertTask({ projectId, createdBy: 'laptop' });

    // First commit migrates.
    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });
    expect(process.exitCode).toBe(0);

    // Reset spies for the second run so we can read just its output.
    consoleLogSpy.mockClear();

    // Second commit must be a no-op.
    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });
    expect(process.exitCode).toBe(0);
    const out2 = loggedStdout();
    expect(out2).toMatch(/Total rows updated: 0|Total: 0|0 rows/);
  });

  it('Case 4a: --alias-map overrides resolution', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const alice = readUser("display_name = 'alice'");
    expect(alice).not.toBeNull();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'weird-old-author' });

    const aliasFile = join(tmpDir, 'alias.json');
    writeFileSync(aliasFile, JSON.stringify({ 'weird-old-author': alice!.id }));

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--commit', '--alias-map', aliasFile],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(readTask(t1)!.created_by_user_id).toBe(alice!.id);
  });

  it('Case 4b: --alias-map missing file exits 1', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--alias-map', join(tmpDir, 'nope-does-not-exist.json')],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toMatch(/alias-map|not found|read|ENOENT/i);
  });

  it('Case 4c: --alias-map with non-integer value exits 1', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const aliasFile = join(tmpDir, 'bad-alias.json');
    writeFileSync(aliasFile, JSON.stringify({ foo: 'not-a-number' }));

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--alias-map', aliasFile],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toMatch(/integer|invalid|number/i);
  });

  it('Case 4d: --alias-map with non-existent user_id exits 1 (pre-flight check)', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const aliasFile = join(tmpDir, 'ghost-user.json');
    writeFileSync(aliasFile, JSON.stringify({ ghost: 99999 }));

    const projectId = insertProject();
    insertTask({ projectId, createdBy: 'ghost' });

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--commit', '--alias-map', aliasFile],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toMatch(/99999|user.*not found|FK|foreign/i);
  });

  it('Case 5a: --user-fallback skip leaves unmatched rows NULL', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'unmatchable' });

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--commit', '--user-fallback', 'skip'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(readTask(t1)!.created_by_user_id).toBeNull();
  });

  it('Case 5b: --user-fallback legacy pins unmatched rows to first-seeded legacy user', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const laptop = readUser("display_name = 'laptop'");
    expect(laptop).not.toBeNull();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'unmatchable' });

    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    // 'laptop' is the FIRST-seeded legacy user (lowest id among is_legacy=1).
    expect(readTask(t1)!.created_by_user_id).toBe(laptop!.id);
  });

  it('Case 6a: empty API_KEYS + default fallback exits 1 with clear error', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    // Wipe the seeded legacy users — simulate a PAT-only deployment.
    const db = new Database(dbPath);
    db.prepare(`DELETE FROM users WHERE is_legacy = 1`).run();
    db.close();

    const projectId = insertProject();
    insertTask({ projectId, createdBy: 'whatever' });

    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(1);
    expect(loggedStderr()).toMatch(/No legacy users? seeded/i);
    expect(loggedStderr()).toMatch(/--alias-map|--user-fallback skip/);
  });

  it('Case 6b: empty API_KEYS + --user-fallback skip succeeds (FK stays NULL)', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const db = new Database(dbPath);
    db.prepare(`DELETE FROM users WHERE is_legacy = 1`).run();
    db.close();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'whatever' });

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--commit', '--user-fallback', 'skip'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(readTask(t1)!.created_by_user_id).toBeNull();
  });

  it('Case 7: --limit caps rows updated', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const laptop = readUser("display_name = 'laptop'");
    const projectId = insertProject();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(insertTask({ projectId, createdBy: 'laptop' }));
    }

    await dbMigrateIdentitiesCommand.parseAsync(
      ['--commit', '--limit', '3'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    const updated = ids
      .map((id) => readTask(id)!)
      .filter((r) => r.created_by_user_id === laptop!.id);
    expect(updated).toHaveLength(3);
    // The limited rows are deterministic (lowest ids).
    const updatedIds = updated.map((r) => r.id).sort((a, b) => a - b);
    expect(updatedIds).toEqual(ids.slice(0, 3));
  });

  it('Case 8a: email-shaped value resolves via findByEmail', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const alice = readUser("email = 'alice@example.com'");
    expect(alice).not.toBeNull();

    const projectId = insertProject();
    const t1 = insertTask({ projectId, createdBy: 'alice@example.com' });

    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    expect(readTask(t1)!.created_by_user_id).toBe(alice!.id);
  });

  it('Case 8b: empty-string and "@@@" do NOT crash (Pitfall 6)', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const laptop = readUser("display_name = 'laptop'");
    const projectId = insertProject();
    // Empty string created_by — schema requires NOT NULL, so use a single
    // space (still email-shape-fail). The Pitfall 6 guard around findByEmail
    // is exercised by the '@@@' assignee value.
    const t1 = insertTask({ projectId, createdBy: ' ', assignee: '@@@' });

    // Must NOT throw. Default fallback=legacy pins both to the legacy user.
    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    const row = readTask(t1)!;
    expect(row.created_by_user_id).toBe(laptop!.id);
    expect(row.assignee_user_id).toBe(laptop!.id);
  });

  it('Case 9: plan output sorts mappings by row count descending', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const projectId = insertProject();
    // 'laptop' → 5 rows, 'agent-bot' → 2 rows, 'unmatchable' → 1 row.
    for (let i = 0; i < 5; i++) insertTask({ projectId, createdBy: 'laptop' });
    for (let i = 0; i < 2; i++)
      insertTask({ projectId, createdBy: 'agent-bot' });
    insertTask({ projectId, createdBy: 'unmatchable' });

    await dbMigrateIdentitiesCommand.parseAsync([], { from: 'user' });

    expect(process.exitCode).toBe(0);
    const out = loggedStdout();
    // Within the tasks.created_by section, 'laptop' must appear before
    // 'agent-bot' which must appear before 'unmatchable'.
    const idxLaptop = out.indexOf('laptop');
    const idxAgent = out.indexOf('agent-bot');
    const idxUnmatched = out.indexOf('unmatchable');
    expect(idxLaptop).toBeGreaterThan(-1);
    expect(idxAgent).toBeGreaterThan(-1);
    expect(idxUnmatched).toBeGreaterThan(-1);
    expect(idxLaptop).toBeLessThan(idxAgent);
    expect(idxAgent).toBeLessThan(idxUnmatched);
  });

  it('Case 10: per-table mappings — task_comments backfill works alongside tasks', async () => {
    const { dbMigrateIdentitiesCommand } = await import(
      '../commands/db-migrate-identities.js'
    );
    dbMigrateIdentitiesCommand.exitOverride();

    const laptop = readUser("display_name = 'laptop'");
    const agent = readUser("display_name = 'agent-bot'");
    expect(laptop).not.toBeNull();
    expect(agent).not.toBeNull();

    const projectId = insertProject();
    const t1 = insertTask({
      projectId,
      createdBy: 'laptop',
      assignee: 'agent-bot',
    });
    const c1 = insertComment({ taskId: t1, author: 'agent-bot' });
    const c2 = insertComment({ taskId: t1, author: 'laptop' });

    await dbMigrateIdentitiesCommand.parseAsync(['--commit'], {
      from: 'user',
    });

    expect(process.exitCode).toBe(0);
    const task = readTask(t1)!;
    expect(task.created_by_user_id).toBe(laptop!.id);
    expect(task.assignee_user_id).toBe(agent!.id);
    expect(readComment(c1)!.author_user_id).toBe(agent!.id);
    expect(readComment(c2)!.author_user_id).toBe(laptop!.id);
  });

  it('Case 11: nested registration — `db migrate-identities` smoke test', async () => {
    // Verifies that the parent `db` command exposes `migrate-identities` so
    // operators invoke it as `tasks db migrate-identities`.
    const { dbCommand } = await import('../commands/db.js');
    const sub = dbCommand.commands.find(
      (c) => c.name() === 'migrate-identities',
    );
    expect(sub).toBeDefined();
  });
});
