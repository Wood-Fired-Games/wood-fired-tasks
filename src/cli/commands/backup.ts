import { Command } from 'commander';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, statSync } from 'fs';
import { colorError, colorSuccess } from '../output/formatters.js';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';

/**
 * Format file size as human-readable KB or MB string.
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(2)} KB`;
}

export const backupCommand = new Command('backup')
  .description('Create a SQLite backup of the task database')
  .option(
    '-o, --output <path>',
    'Backup destination path',
    `./tasks-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
  )
  .action(async (options) => {
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
    const destPath = resolve(options.output);

    // Verify source database exists before attempting backup
    if (!existsSync(dbPath)) {
      console.error(colorError(`Database not found at ${dbPath}`));
      process.exitCode = 1;
      return;
    }

    // Ensure destination directory exists
    const destDir = dirname(destPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    // Open source database in readonly mode to avoid write lock conflicts
    const db = new Database(dbPath, { readonly: true });

    try {
      await db.backup(destPath);

      const size = statSync(destPath).size;

      // Check JSON mode via global program options
      const program = backupCommand.parent;
      const isJsonMode = program?.optsWithGlobals()?.json || false;

      if (isJsonMode) {
        jsonOutput({ path: destPath, size, source: dbPath });
      } else {
        console.log(
          colorSuccess(`Backup created successfully`) +
          `\n  Path:   ${destPath}` +
          `\n  Size:   ${formatSize(size)}` +
          `\n  Source: ${dbPath}`
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(colorError(`Backup failed: ${error.message}`));
      } else {
        console.error(colorError('Backup failed: unknown error'));
      }
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });
