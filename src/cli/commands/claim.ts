import { Command } from 'commander';
import { claimTask } from '../api/client.js';
import { formatTaskDetail } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import chalk from 'chalk';

export const claimCommand = new Command('claim')
  .description('Claim an unassigned task (atomic operation)')
  .argument('<id>', 'Task ID to claim')
  .requiredOption('-a, --assignee <name>', 'Agent/person claiming the task')
  .option('--idempotency-key <key>', 'Idempotency key for retry safety')
  .action(async (idStr, options) => {
    try {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(chalk.red('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      const task = await claimTask(id, options.assignee, options.idempotencyKey);

      // Check if JSON mode
      const program = claimCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      if (isJsonMode) {
        jsonOutput({ task }, { id: task.id, assignee: task.assignee });
      } else {
        console.log(chalk.green(`Task #${task.id} claimed by ${task.assignee}`));
        console.log('');
        console.log(formatTaskDetail(task));
      }
    } catch (error) {
      handleError(error);
    }
  });
