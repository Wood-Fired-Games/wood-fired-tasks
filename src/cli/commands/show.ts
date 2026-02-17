import { Command } from 'commander';
import { getTask, withApiSpinner } from '../api/client.js';
import { formatTaskDetail, colorError } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

export const showCommand = new Command('show')
  .description('Show task details by ID')
  .argument('<id>', 'Task ID to show')
  .action(async (idStr) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Fetch task details
      const task = await withApiSpinner('Fetching task...', () => getTask(id));

      // Check if JSON mode (global flag from program)
      const program = showCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Display task
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ task });
      } else {
        // Terminal mode: formatted output
        console.log(formatTaskDetail(task));
      }
    } catch (error) {
      handleError(error);
    }
  });
