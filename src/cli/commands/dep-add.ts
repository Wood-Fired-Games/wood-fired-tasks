import { Command } from 'commander';
import { addDependency } from '../api/client.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import chalk from 'chalk';

export const depAddCommand = new Command('dep-add')
  .description('Add dependency (task <id> blocks task <blocks-id>)')
  .argument('<id>', 'Task ID')
  .argument('<blocks-id>', 'Task ID that this task blocks')
  .action(async (idStr, blocksIdStr) => {
    try {
      // Parse and validate task IDs
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(chalk.red('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      const blocksId = parseInt(blocksIdStr, 10);
      if (isNaN(blocksId)) {
        console.error(chalk.red('Invalid blocks-id: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = depAddCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Add dependency via API
      const dependency = await addDependency(id, { blocks_task_id: blocksId });

      // Display success
      if (isJsonMode) {
        jsonOutput({ dependency });
      } else {
        console.log(chalk.green(`Dependency added: Task ${id} blocks Task ${blocksId}`));
      }
    } catch (error) {
      handleError(error);
    }
  });
