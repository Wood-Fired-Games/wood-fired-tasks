/**
 * In-process tests for src/cli/commands/db-check.ts (task #249).
 *
 * Creates a real SQLite file in a temp dir so PRAGMA integrity_check and
 * page-count queries run against actual data (not mocks).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Side-effect import of env config not needed.
vi.mock('../config/env.js', () => ({}));

describe('db-check command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let program: Command;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(async () => {
    process.exitCode = 0;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    tmpDir = mkdtempSync(join(tmpdir(), 'wft-dbcheck-'));
    dbPath = join(tmpDir, 'tasks.db');

    const db = new Database(dbPath);
    db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO thing (value) VALUES (?)').run('hello');
    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';

    const { dbCheckCommand } = await import('../commands/db-check.js');
    program = new Command();
    program.option('--json', 'Output as JSON');
    program.addCommand(dbCheckCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  it('prints PASSED for a healthy database', async () => {
    await program.parseAsync(['node', 'tasks', 'db-check']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('PASSED');
    expect(logged).toContain('Database:');
    expect(logged).toMatch(/Size:\s+\d+(\.\d+)?\s+(KB|MB)/);
    expect(process.exitCode).toBe(0);
  });

  it('reports size in KB for small databases', async () => {
    await program.parseAsync(['node', 'tasks', 'db-check']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('KB');
  });

  it('outputs JSON envelope when --json flag is set', async () => {
    await program.parseAsync(['node', 'tasks', '--json', 'db-check']);
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.success).toBe(true);
    expect(env.data.passed).toBe(true);
    expect(env.data.message).toBe('ok');
    expect(env.data.dbPath).toBe(dbPath);
    expect(env.data.sizeBytes).toBeGreaterThan(0);
    expect(env.data.pageCount).toBeGreaterThan(0);
    expect(env.data.pageSize).toBeGreaterThan(0);
  });

  it('formats size in MB for >= 1 MB databases', async () => {
    const db = new Database(dbPath);
    const stmt = db.prepare('INSERT INTO thing (value) VALUES (?)');
    const big = 'x'.repeat(2048);
    // Single transaction: ~600 autocommit fsyncs would intermittently blow the
    // 5s timeout under parallel-suite I/O contention. One commit keeps the
    // >=1MB intent while staying deterministic.
    const insertMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) stmt.run(big);
    });
    insertMany(600);
    db.close();

    await program.parseAsync(['node', 'tasks', 'db-check']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Size:\s+\d+\.\d+\s+MB/);
  });
});
