import { Command } from 'commander';
import { listProjects } from '../api/client.js';
import { formatProjectTable, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

const MAX_LIMIT = 500;

export const projectListCommand = new Command('project-list')
  .description('List all projects')
  .option('--limit <n>', `Max rows to return (default 50, max ${MAX_LIMIT})`, (v) =>
    parseInt(v, 10),
  )
  .option('--offset <n>', 'Zero-based offset for pagination (default 0)', (v) => parseInt(v, 10))
  .action(async (options) => {
    try {
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > MAX_LIMIT) {
          console.error(
            colorError(`Invalid --limit: must be an integer between 1 and ${MAX_LIMIT}`),
          );
          process.exitCode = 1;
          return;
        }
      }
      if (options.offset !== undefined) {
        if (!Number.isInteger(options.offset) || options.offset < 0) {
          console.error(colorError('Invalid --offset: must be a non-negative integer'));
          process.exitCode = 1;
          return;
        }
      }

      // Call API
      const projects = await listProjects({
        limit: options.limit,
        offset: options.offset,
      });

      // Check if JSON mode (global flag from program)
      const program = projectListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Display results
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput(projects, { count: projects.length });
      } else {
        // Terminal mode: formatted output
        if (projects.length === 0) {
          console.log(colorWarn('No projects found'));
          return;
        }

        console.log(formatProjectTable(projects));
        console.log(colorInfo(`\n${projects.length} project(s) found`));
      }
    } catch (error) {
      handleError(error);
    }
  });
