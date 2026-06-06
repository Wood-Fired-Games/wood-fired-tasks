import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock better-sqlite3 Database constructor
const mockDbBackup = vi.fn();
const mockDbClose = vi.fn();
const MockDatabase = vi.fn(function MockDatabase(this: Record<string, unknown>) {
  this.backup = mockDbBackup;
  this.close = mockDbClose;
});

vi.mock('../../db/driver.js', () => {
  return { default: MockDatabase };
});

// Mock fs functions
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    statSync: mockStatSync,
  };
});

// Mock the env module (side-effect only — just needs to load without error)
vi.mock('../config/env.js', () => ({}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
}));

describe('backup command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    // Default mock behaviors
    mockDbBackup.mockResolvedValue({ totalPages: 10, remainingPages: 0 });
    mockDbClose.mockReturnValue(undefined);
    // By default, source DB exists and output directory also exists
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined);
    mockStatSync.mockReturnValue({ size: 4096 });

    // Save env vars
    savedEnv.DATABASE_PATH = process.env.DATABASE_PATH;

    // Set up fresh program for each test
    const { backupCommand } = await import('../commands/backup.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(backupCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();

    // Restore env vars
    if (savedEnv.DATABASE_PATH === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedEnv.DATABASE_PATH;
    }
  });

  it('creates backup with default output path', async () => {
    delete process.env.DATABASE_PATH;

    await program.parseAsync(['node', 'test', 'backup']);

    const Database = (await import('../../db/driver.js')).default;
    expect(Database).toHaveBeenCalledWith('./data/tasks.db', { readonly: true });
    expect(mockDbBackup).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Backup created successfully')
    );
  });

  it('creates backup with custom output path', async () => {
    await program.parseAsync(['node', 'test', 'backup', '-o', '/tmp/my-backup.db']);

    expect(mockDbBackup).toHaveBeenCalledWith('/tmp/my-backup.db');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Backup created successfully')
    );
  });

  it('uses DATABASE_PATH from environment', async () => {
    process.env.DATABASE_PATH = '/custom/path/tasks.db';

    await program.parseAsync(['node', 'test', 'backup']);

    const Database = (await import('../../db/driver.js')).default;
    expect(Database).toHaveBeenCalledWith('/custom/path/tasks.db', { readonly: true });
  });

  it('falls back to default DATABASE_PATH when env var not set', async () => {
    delete process.env.DATABASE_PATH;

    await program.parseAsync(['node', 'test', 'backup']);

    const Database = (await import('../../db/driver.js')).default;
    expect(Database).toHaveBeenCalledWith('./data/tasks.db', { readonly: true });
  });

  it('creates output directory if it does not exist', async () => {
    // Source DB exists but destination directory doesn't
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('tasks.db') || p === './data/tasks.db') return true;
      return false;
    });

    await program.parseAsync(['node', 'test', 'backup', '-o', '/some/new/dir/backup.db']);

    expect(mockMkdirSync).toHaveBeenCalledWith('/some/new/dir', { recursive: true });
  });

  it('outputs JSON in --json mode', async () => {
    const destPath = '/tmp/json-backup.db';

    await program.parseAsync(['node', 'test', '--json', 'backup', '-o', destPath]);

    const { jsonOutput } = await import('../output/json-output.js');
    expect(jsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        path: destPath,
        size: expect.any(Number),
        source: expect.any(String),
      })
    );
    // Should not log terminal success message
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Backup created successfully')
    );
  });

  it('handles database not found error', async () => {
    // Source database does not exist
    mockExistsSync.mockReturnValue(false);
    delete process.env.DATABASE_PATH;

    await program.parseAsync(['node', 'test', 'backup']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Database not found at')
    );
    expect(process.exitCode).toBe(1);
    // Should NOT attempt to open the DB
    const Database = (await import('../../db/driver.js')).default;
    expect(Database).not.toHaveBeenCalled();
  });

  it('closes database connection on error', async () => {
    // db.backup() rejects
    mockDbBackup.mockRejectedValue(new Error('Backup failed: disk full'));

    await program.parseAsync(['node', 'test', 'backup']);

    // db.close() must have been called in the finally block
    expect(mockDbClose).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('disk full')
    );
  });
});
