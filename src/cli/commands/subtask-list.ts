import { Command } from 'commander';
import { getSubtasks } from '../api/client.js';
import { formatTaskTable, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

export const subtaskListCommand = new Command('subtask-list')
  .description('List subtasks (children) of a parent task')
  .argument('<parent-id>', 'Parent task ID')
  .action(async (parentIdStr) => {
    try {
      // Parse and validate parent task ID
      const parentId = parseInt(parentIdStr, 10);
      if (isNaN(parentId)) {
        console.error(colorError('Invalid parent task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = subtaskListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Get subtasks via API
      const subtasks = await getSubtasks(parentId);

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
