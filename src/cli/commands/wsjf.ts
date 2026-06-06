import { Command } from 'commander';
import Database from '../../db/driver.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { ProjectCharterHistoryRepository } from '../../repositories/project-charter-history.repository.js';
import { TaskService } from '../../services/task.service.js';
import { colorError } from '../output/formatters.js';
import { FIB } from '../../types/task.js';
import type { Fib, WsjfWriteDTO } from '../../types/task.js';
import type { WsjfComponentKey, WsjfLocks } from '../../types/wsjf.js';
import '../config/env.js';

/**
 * WSJF 4.5 (task #645) — CLI surface for a task's WSJF score history,
 * component set/lock, and a project's charter history.
 *
 * Commands (all emit bare JSON to stdout — machine-readable, like `topology`):
 *
 *   wsjf-history <id>           → the task's append-only score-history timeline,
 *                                 oldest-first (chronological).
 *   wsjf-set <id> [flags]       → set / lock the task's four WSJF components.
 *                                 Runs the SAME manual gate (`validateManualScore`:
 *                                 enum + cross-component contradiction) the
 *                                 REST / MCP / service write paths use, via
 *                                 `TaskService.updateTask({ wsjf:{...,manual:true} })`,
 *                                 so the component write + its history row commit
 *                                 atomically.
 *   charter-history <id>        → the project's value-charter history, oldest-first.
 *
 * The read commands open a read-only handle; `wsjf-set` opens a read/write handle
 * and runs the service in-process (audit-enabled — db + history repo wired), so
 * the gate runs exactly as it does over REST. This mirrors the `topology` /
 * `db-check` in-process pattern (no HTTP round-trip for a DB-local operation).
 */

const COMPONENT_KEYS: readonly WsjfComponentKey[] = [
  'value',
  'timeCriticality',
  'riskOpportunity',
  'jobSize',
];

/** Parse a `--value`-style component flag into a validated Fibonacci tier. */
function parseFib(raw: string | undefined, label: string): Fib | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || !(FIB as readonly number[]).includes(n)) {
    throw new Error(
      `Invalid --${label}: must be a Fibonacci tier (${FIB.join(', ')})`,
    );
  }
  return n as Fib;
}

export const wsjfHistoryCommand = new Command('wsjf-history')
  .description("Show a task's append-only WSJF score history (oldest-first)")
  .argument('<id>', 'Task ID (positive integer)')
  .action((idStr: string) => {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(colorError('Invalid task id: must be a positive integer'));
      process.exitCode = 1;
      return;
    }
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
    const db = new Database(dbPath, { readonly: true });
    try {
      const history = new WsjfHistoryRepository(db).findByTaskId(id);
      process.stdout.write(
        `${JSON.stringify({ task_id: id, total: history.length, history }, null, 2)}\n`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(colorError(`wsjf-history failed: ${msg}`));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

export const wsjfSetCommand = new Command('wsjf-set')
  .description(
    "Set / lock a task's WSJF components (manual override — runs the same " +
      'enum + contradiction gate as REST / MCP)',
  )
  .argument('<id>', 'Task ID (positive integer)')
  .requiredOption('--value <fib>', 'Business value tier (1,2,3,5,8,13)')
  .requiredOption(
    '--time-criticality <fib>',
    'Time-criticality tier (1,2,3,5,8,13)',
  )
  .requiredOption(
    '--risk-opportunity <fib>',
    'Risk/opportunity tier (1,2,3,5,8,13)',
  )
  .requiredOption('--job-size <fib>', 'Job-size tier (1,2,3,5,8,13)')
  .option(
    '--lock <keys>',
    'Comma-separated components to lock against rescore ' +
      '(value,timeCriticality,riskOpportunity,jobSize)',
  )
  .action(
    (
      idStr: string,
      opts: {
        value: string;
        timeCriticality: string;
        riskOpportunity: string;
        jobSize: string;
        lock?: string;
      },
    ) => {
      const id = parseInt(idStr, 10);
      if (!Number.isInteger(id) || id <= 0) {
        console.error(colorError('Invalid task id: must be a positive integer'));
        process.exitCode = 1;
        return;
      }

      let components: { value: Fib; timeCriticality: Fib; riskOpportunity: Fib; jobSize: Fib };
      let locked: WsjfLocks | undefined;
      try {
        components = {
          value: parseFib(opts.value, 'value')!,
          timeCriticality: parseFib(opts.timeCriticality, 'time-criticality')!,
          riskOpportunity: parseFib(opts.riskOpportunity, 'risk-opportunity')!,
          jobSize: parseFib(opts.jobSize, 'job-size')!,
        };
        if (opts.lock !== undefined) {
          const requested = opts.lock
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const unknown = requested.filter(
            (k) => !COMPONENT_KEYS.includes(k as WsjfComponentKey),
          );
          if (unknown.length > 0) {
            throw new Error(
              `Invalid --lock key(s): ${unknown.join(', ')}. ` +
                `Valid: ${COMPONENT_KEYS.join(', ')}`,
            );
          }
          locked = {
            value: requested.includes('value'),
            timeCriticality: requested.includes('timeCriticality'),
            riskOpportunity: requested.includes('riskOpportunity'),
            jobSize: requested.includes('jobSize'),
          };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(colorError(msg));
        process.exitCode = 1;
        return;
      }

      const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
      const db = new Database(dbPath);
      try {
        const taskRepo = new TaskRepository(db);
        const projectRepo = new ProjectRepository(db);
        const historyRepo = new WsjfHistoryRepository(db);
        // Audit-enabled construction (db + history repo) so the component write
        // and its append-only history row commit in one transaction.
        const service = new TaskService(taskRepo, projectRepo, db, historyRepo);
        const wsjf: WsjfWriteDTO = {
          ...components,
          locked: locked ?? null,
          // Manual override → runs validateManualScore (enum + contradiction)
          // and stamps the history row trigger='manual'.
          manual: true,
        };
        const updated = service.updateTask(id, { wsjf });
        const scored =
          updated.wsjf_value !== null &&
          updated.wsjf_time_criticality !== null &&
          updated.wsjf_risk_opportunity !== null &&
          updated.wsjf_job_size !== null;
        process.stdout.write(
          `${JSON.stringify(
            {
              task_id: updated.id,
              scored,
              components: {
                value: updated.wsjf_value,
                timeCriticality: updated.wsjf_time_criticality,
                riskOpportunity: updated.wsjf_risk_opportunity,
                jobSize: updated.wsjf_job_size,
              },
              locked: updated.wsjf_locked,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(colorError(`wsjf-set failed: ${msg}`));
        process.exitCode = 1;
      } finally {
        db.close();
      }
    },
  );

export const charterHistoryCommand = new Command('charter-history')
  .description("Show a project's value-charter history (oldest-first)")
  .argument('<id>', 'Project ID (positive integer)')
  .action((idStr: string) => {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(
        colorError('Invalid project id: must be a positive integer'),
      );
      process.exitCode = 1;
      return;
    }
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
    const db = new Database(dbPath, { readonly: true });
    try {
      const history = new ProjectCharterHistoryRepository(db).findByProjectId(id);
      process.stdout.write(
        `${JSON.stringify(
          { project_id: id, total: history.length, history },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(colorError(`charter-history failed: ${msg}`));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });
