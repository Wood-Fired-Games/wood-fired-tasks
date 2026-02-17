import { Command } from 'commander';
import Database from 'better-sqlite3';
import { statfs } from 'fs';
import { promisify } from 'util';
import { dirname } from 'path';
import chalk from 'chalk';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';
import { configSchema } from '../../config/env.js';

const statfsAsync = promisify(statfs);

/**
 * Format bytes as human-readable GB or MB string.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const doctorCommand = new Command('doctor')
  .description('Run diagnostics: DB connectivity, disk space, and config validity')
  .action(async () => {
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';

    const program = doctorCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.json || false;

    // --- Check 1: Database connectivity ---
    let dbStatus: 'PASS' | 'FAIL' = 'FAIL';
    let dbMessage = '';

    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        db.prepare('SELECT 1').get();
        // Check WAL mode
        const journalMode = db.pragma('journal_mode', { simple: true }) as string;
        dbStatus = 'PASS';
        dbMessage = journalMode === 'wal' ? 'Connected (SQLite WAL mode)' : `Connected (${journalMode} mode)`;
      } finally {
        db.close();
      }
    } catch (error) {
      dbStatus = 'FAIL';
      if (error instanceof Error) {
        dbMessage = error.message.includes('ENOENT')
          ? `Database not found at ${dbPath}`
          : `Connection failed: ${error.message}`;
      } else {
        dbMessage = `Connection failed: unknown error`;
      }
    }

    // --- Check 2: Disk space ---
    let diskStatus: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
    let diskMessage = '';
    let diskFree = 0;
    let diskTotal = 0;
    let diskFreePercent = '0.0';

    try {
      const stats = await statfsAsync(dirname(dbPath));
      diskFree = stats.bavail * stats.bsize;
      diskTotal = stats.blocks * stats.bsize;
      diskFreePercent = (diskFree / diskTotal * 100).toFixed(1);
      const freeNum = parseFloat(diskFreePercent);

      if (freeNum < 5) {
        diskStatus = 'FAIL';
      } else if (freeNum < 10) {
        diskStatus = 'WARN';
      } else {
        diskStatus = 'PASS';
      }
      diskMessage = `${diskFreePercent}% free (${formatBytes(diskFree)} / ${formatBytes(diskTotal)})`;
    } catch (error) {
      diskStatus = 'FAIL';
      diskMessage = error instanceof Error ? `Disk check failed: ${error.message}` : 'Disk check failed';
    }

    // --- Check 3: Config validity ---
    let configStatus: 'PASS' | 'FAIL' = 'PASS';
    let configMessage = '';
    let configErrors: Array<{ path: string; message: string }> = [];

    const result = configSchema.safeParse(process.env);
    if (result.success) {
      configStatus = 'PASS';
      configMessage = 'All required variables present';
    } else {
      configStatus = 'FAIL';
      configErrors = result.error.issues.map((issue) => ({
        path: issue.path.join('.') || String(issue.path[0] ?? 'unknown'),
        message: issue.message,
      }));
      configMessage = `${configErrors.length} issue(s)`;
    }

    // --- Set exit code if any check fails ---
    if (dbStatus === 'FAIL' || diskStatus === 'FAIL' || configStatus === 'FAIL') {
      process.exitCode = 1;
    }

    // --- Output ---
    if (isJsonMode) {
      jsonOutput({
        database: { status: dbStatus, message: dbMessage },
        disk: {
          status: diskStatus,
          free: diskFree,
          total: diskTotal,
          freePercent: diskFreePercent,
        },
        config: { status: configStatus, errors: configErrors },
      });
    } else {
      const dbLabel = dbStatus === 'PASS'
        ? chalk.green('[PASS]')
        : chalk.red('[FAIL]');

      const diskLabel = diskStatus === 'PASS'
        ? chalk.green('[PASS]')
        : diskStatus === 'WARN'
          ? chalk.yellow('[WARN]')
          : chalk.red('[FAIL]');

      const configLabel = configStatus === 'PASS'
        ? chalk.green('[PASS]')
        : chalk.red('[FAIL]');

      console.log(`Database:  ${dbLabel} ${dbMessage}`);

      console.log(`Disk:      ${diskLabel} ${diskMessage}`);

      if (configStatus === 'PASS') {
        console.log(`Config:    ${configLabel} ${configMessage}`);
      } else {
        console.log(`Config:    ${configLabel} ${configMessage}:`);
        for (const err of configErrors) {
          console.log(`           - ${err.path}: ${err.message}`);
        }
      }
    }
  });
