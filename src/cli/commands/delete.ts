import { Command } from 'commander';
import { deleteTask, getTask } from '../api/client.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { confirmAction } from '../prompts/interactive.js';
import chalk from 'chalk';

export const deleteCommand = new Command('delete')
  .description('Delete a task by ID')
  .argument('<id>', 'Task ID to delete')
  .action(async (idStr) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(chalk.red('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = deleteCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Fetch task details to show what's being deleted
      const task = await getTask(id);

      // Confirm deletion (unless --force)
      const confirmed = await confirmAction(
        `Delete task '${task.title}'?`,
        false
      );

      if (!confirmed) {
        if (isJsonMode) {
          // JSON mode: output cancellation envelope
          jsonOutput({}, { message: 'Deletion cancelled' });
        } else {
          // Terminal mode: info message
          console.log(chalk.yellow('Deletion cancelled'));
        }
        return;
      }

      // Delete task via API
      await deleteTask(id);

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({}, { message: `Task ${id} deleted` });
      } else {
        // Terminal mode: success message
        console.log(chalk.green(`Task #${id} deleted successfully`));
      }
    } catch (error) {
      handleError(error);
    }
  });
