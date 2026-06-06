import { Command } from 'commander';
import { getDependencies } from '../api/client.js';
import { formatDependencyList, colorError } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

export const depListCommand = new Command('dep-list')
  .description('List dependencies for a task')
  .argument('<id>', 'Task ID')
  .action(async (idStr) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = depListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Get dependencies via API
      const deps = await getDependencies(id);

      // Display dependencies
      if (isJsonMode) {
        jsonOutput(deps);
      } else {
        console.log(formatDependencyList(deps));
      }
    } catch (error) {
      handleError(error);
    }
  });
