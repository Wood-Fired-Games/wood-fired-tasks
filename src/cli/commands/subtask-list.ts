import { Command } from 'commander';
import { getSubtasks } from '../api/client.js';
import { formatTaskTable, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

const MAX_LIMIT = 500;

export const subtaskListCommand = new Command('subtask-list')
  .description('List subtasks (children) of a parent task')
  .argument('<parent-id>', 'Parent task ID')
  .option('--limit <n>', `Max rows to return (default 50, max ${MAX_LIMIT})`, (v) =>
    parseInt(v, 10),
  )
  .option('--offset <n>', 'Zero-based offset for pagination (default 0)', (v) => parseInt(v, 10))
  .action(async (parentIdStr, options) => {
    try {
      // Parse and validate parent task ID
      const parentId = parseInt(parentIdStr, 10);
      if (isNaN(parentId)) {
        console.error(colorError('Invalid parent task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

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

      // Check if JSON mode (global flag from program)
      const program = subtaskListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Get subtasks via API
      const subtasks = await getSubtasks(parentId, {
        limit: options.limit,
        offset: options.offset,
      });

      // Display results
      if (isJsonMode) {
        jsonOutput(subtasks, { count: subtasks.length, parent_task_id: parentId });
      } else {
        if (subtasks.length === 0) {
          console.log(colorWarn('No subtasks'));
          return;
        }

        console.log(formatTaskTable(subtasks));
        console.log(colorInfo(`\n${subtasks.length} subtask(s) found`));
      }
    } catch (error) {
      handleError(error);
    }
  });
