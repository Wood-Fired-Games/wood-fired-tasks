import { Command } from 'commander';
import Database from '../../db/driver.js';
import { resolveDbPath } from '../../config/db-path.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { TopologyService } from '../../services/topology.service.js';
import { colorError } from '../output/formatters.js';
import '../config/env.js';

/**
 * Wave 4.1 (task #318) — `tasks topology --project <id>` CLI command.
 *
 * Outputs a TopologyReport as JSON on stdout (always JSON — this is a
 * machine-readable advisory output, not a human dashboard). Exits 0 on every
 * successful classification, including DAG_CYCLIC (the classifier itself did
 * not fail — it just reported a hostile topology). Exits 1 only on
 * argument-parse failures or service-layer exceptions.
 *
 * The command opens a read-only handle on the configured DATABASE_PATH and
 * runs the classifier in-process — mirrors the `db-check` / `stats` pattern
 * (no HTTP round-trip needed for a pure read-side classifier).
 */
export const topologyCommand = new Command('topology')
  .description('Classify a project as FLAT/DAG/DAG_CYCLIC and emit an execution advisory')
  .requiredOption('--project <id>', 'Project ID (positive integer)')
  .action((opts: { project: string }) => {
    const projectId = parseInt(opts.project, 10);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      console.error(colorError('Invalid --project: must be a positive integer'));
      process.exitCode = 1;
      return;
    }

    const dbPath = resolveDbPath();
    const db = new Database(dbPath, { readonly: true });
    try {
      const taskRepo = new TaskRepository(db);
      const dependencyRepo = new DependencyRepository(db);
      const service = new TopologyService(taskRepo, dependencyRepo);
      const report = service.classify(projectId);
      // Bare JSON to stdout — no `{success, data}` envelope, since the AC
      // specifies the literal TopologyReport shape as the wire output (so
      // downstream `jq .topology` etc. work without an extra `.data` hop).
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(colorError(`topology failed: ${msg}`));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });
