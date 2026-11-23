import { Command } from 'commander';
import { archiveProject } from '../api/client.js';
import type { ArchiveProjectOptions } from '../api/types.js';
import { formatProjectDetail, colorError, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

/**
 * A strict positive project id. The archive commands change state, so a typo
 * such as `7abc` must not resolve to project 7 the way `parseInt` would.
 */
export function parseProjectId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * `tasks project-archive <id> [--reason <text>] [--with-unfinished]` (WFT #2477).
 *
 * `--with-unfinished` archives although tasks are unfinished (the API's
 * `force: true`) and requires `--reason`; without one it is refused here,
 * before any request. The override has its own name because the program
 * already has a global `--force` ("skip confirmation prompts"), and commander
 * gives that flag to the program wherever it appears on the line. The global
 * `--force` is never read here: it must not turn an ordinary archive (a
 * reason is legitimate on one) into a forced one, nor make a clean archive
 * of a finished project need a reason. A refusal (422) prints the server's
 * message, with the per-status counts, and exits 1.
 */
export const projectArchiveCommand = new Command('project-archive')
  .description('Archive a project: hide it from default listings and make it read-only')
  .argument('<id>', 'Project ID to archive')
  .option('-r, --reason <text>', 'Why the project is archived (required with --with-unfinished)')
  .option('--with-unfinished', 'Archive although tasks are still unfinished (requires --reason)')
  .action(async (idStr: string, options: { reason?: string; withUnfinished?: boolean }) => {
    try {
      const id = parseProjectId(idStr);
      if (id === null) {
        console.error(colorError('Invalid project ID: must be a positive whole number'));
        process.exitCode = 1;
        return;
      }
      if (options.withUnfinished === true && options.reason === undefined) {
        console.error(
          colorError('--with-unfinished requires --reason: say why unfinished work is archived'),
        );
        process.exitCode = 1;
        return;
      }

      const globalOpts = projectArchiveCommand.optsWithGlobals();
      const body: ArchiveProjectOptions = {};
      if (options.reason !== undefined) {
        body.reason = options.reason;
      }
      if (options.withUnfinished === true) {
        body.force = true;
      }

      const project = await archiveProject(id, body);

      if (globalOpts['json']) {
        jsonOutput({ project });
      } else {
        console.log(colorSuccess(`Project #${id} archived`));
        console.log(formatProjectDetail(project));
      }
    } catch (error) {
      handleError(error);
    }
  });
