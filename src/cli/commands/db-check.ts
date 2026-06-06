import { Command } from 'commander';
import Database from '../../db/driver.js';
import { colorSuccess, colorError } from '../output/formatters.js';
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

export const dbCheckCommand = new Command('db-check')
  .description('Run SQLite PRAGMA integrity_check and report database size')
  .action(() => {
    const dbPath = process.env['DATABASE_PATH'] || './data/tasks.db';

    const program = dbCheckCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.['json'] || false;

    const db = new Database(dbPath, { readonly: true });

    try {
      // Run integrity check
      const integrityResults = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const [firstResult] = integrityResults;
      const passed = integrityResults.length === 1 && firstResult?.integrity_check === 'ok';

      // Get DB size info
      const pageCount = db.pragma('page_count', { simple: true }) as number;
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      const sizeBytes = pageCount * pageSize;

      if (isJsonMode) {
        jsonOutput({
          passed,
          message: passed ? 'ok' : integrityResults.map((r) => r.integrity_check).join('; '),
          dbPath,
          sizeBytes,
          pageCount,
          pageSize,
        });
        if (!passed) {
          process.exitCode = 1;
        }
        return;
      }

      // --- Normal text output ---
      if (passed) {
        console.log(`Integrity:  ${colorSuccess('PASSED')}`);
      } else {
        console.log(`Integrity:  ${colorError('FAILED')}`);
        console.log('Issues:');
        for (const row of integrityResults) {
          console.log(`  - ${row.integrity_check}`);
        }
        process.exitCode = 1;
      }

      console.log(`Database:   ${dbPath}`);
      console.log(`Size:       ${formatSize(sizeBytes)} (${pageCount} pages x ${pageSize} bytes)`);
    } finally {
      db.close();
    }
  });
