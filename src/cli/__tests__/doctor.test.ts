/**
 * In-process tests for src/cli/commands/doctor.ts (task #249).
 *
 * Drives database / disk / config checks across PASS, WARN, FAIL branches,
 * plus the --json output path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from '../../db/driver.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../config/env.js', () => ({}));

describe('doctor command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedApiKeys = process.env.API_KEYS;
  const savedNodeEnv = process.env.NODE_ENV;

  async function buildProgram() {
    const { doctorCommand } = await import('../commands/doctor.js');
    const p = new Command();
    p.option('--json', 'Output as JSON');
    p.addCommand(doctorCommand);
    return p;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-doctor-'));
    dbPath = join(tmpDir, 'tasks.db');

    // A trivial valid DB.
    const db = new Database(dbPath);
    db.exec('CREATE TABLE thing (id INTEGER)');
    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';
    // Provide all required env so config validation passes.
    process.env.API_KEYS = 'doctor-test-key';
    process.env.NODE_ENV = 'test';

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    process.exitCode = 0;
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
    if (savedApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = savedApiKeys;
    }
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  it('reports all PASS when DB exists and config is valid', async () => {
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Database:\s+\[PASS\]/);
    expect(logged).toMatch(/Disk:\s+\[(PASS|WARN|FAIL)\]/);
    expect(logged).toMatch(/Config:\s+\[PASS\]/);
  });

  it('reports DB FAIL when database file is missing', async () => {
    rmSync(dbPath);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Database:\s+\[FAIL\]/);
    // better-sqlite3 surfaces this either as "ENOENT"-style not-found, or as
    // a generic connection failure (depending on the platform).
    expect(logged).toMatch(/(Database not found at|Connection failed)/);
    expect(process.exitCode).toBe(1);
  });

  it('reports Disk FAIL when DB dir is unreachable', async () => {
    // Point at a path under a non-existent directory so statfs rejects.
    process.env.DATABASE_PATH = '/non/existent/path/tasks.db';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Disk:\s+\[FAIL\]/);
    expect(process.exitCode).toBe(1);
  });

  it('reports Config FAIL when API_KEYS missing', async () => {
    delete process.env.API_KEYS;
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Config:\s+\[FAIL\]/);
    expect(logged).toContain('API_KEYS');
    expect(process.exitCode).toBe(1);
  });

  it('outputs JSON envelope when --json is set', async () => {
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.success).toBe(true);
    expect(env.data.database.status).toBe('PASS');
    expect(env.data.disk.status).toMatch(/^(PASS|WARN|FAIL)$/);
    expect(env.data.config.status).toBe('PASS');
    expect(env.data.config.errors).toEqual([]);
  });

  it('JSON output includes config error array when invalid', async () => {
    delete process.env.API_KEYS;
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.data.config.status).toBe('FAIL');
    expect(Array.isArray(env.data.config.errors)).toBe(true);
    expect(env.data.config.errors.length).toBeGreaterThan(0);
  });
});
