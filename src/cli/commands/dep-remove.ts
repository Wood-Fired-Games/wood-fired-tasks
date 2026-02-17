import { Command } from 'commander';
import { removeDependency } from '../api/client.js';
import { colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { confirmAction } from '../prompts/interactive.js';

export const depRemoveCommand = new Command('dep-remove')
  .description('Remove dependency (task <id> no longer blocks task <blocks-id>)')
  .argument('<id>', 'Task ID')
  .argument('<blocks-id>', 'Task ID that this task blocks')
  .action(async (idStr, blocksIdStr) => {
    try {
      // Parse and validate task IDs
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      const blocksId = parseInt(blocksIdStr, 10);
      if (isNaN(blocksId)) {
        console.error(colorError('Invalid blocks-id: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = depRemoveCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Confirm removal (unless --force)
      const confirmed = await confirmAction(
        `Remove dependency: Task ${id} blocks Task ${blocksId}?`,
        false
      );

      if (!confirmed) {
        if (isJsonMode) {
          jsonOutput({}, { message: 'Removal cancelled' });
        } else {
          console.log(colorWarn('Removal cancelled'));
        }
        return;
      }

      // Remove dependency via API
      await removeDependency(id, blocksId);

      // Display success
      if (isJsonMode) {
        jsonOutput({}, { message: `Dependency removed: Task ${id} no longer blocks Task ${blocksId}` });
      } else {
        console.log(colorSuccess(`Dependency removed: Task ${id} no longer blocks Task ${blocksId}`));
      }
    } catch (error) {
      handleError(error);
    }
  });
