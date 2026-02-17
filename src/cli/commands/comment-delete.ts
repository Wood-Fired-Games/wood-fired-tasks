import { Command } from 'commander';
import { deleteComment } from '../api/client.js';
import { colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { confirmAction } from '../prompts/interactive.js';

export const commentDeleteCommand = new Command('comment-delete')
  .description('Delete a comment by ID')
  .argument('<task-id>', 'Task ID the comment belongs to')
  .argument('<comment-id>', 'Comment ID to delete')
  .action(async (taskIdStr, commentIdStr) => {
    try {
      // Parse and validate task ID
      const taskId = parseInt(taskIdStr, 10);
      if (isNaN(taskId)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Parse and validate comment ID
      const commentId = parseInt(commentIdStr, 10);
      if (isNaN(commentId)) {
        console.error(colorError('Invalid comment ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = commentDeleteCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Confirm deletion (unless --force)
      const confirmed = await confirmAction(
        `Delete comment ${commentId}?`,
        false
      );

      if (!confirmed) {
        if (isJsonMode) {
          jsonOutput({}, { message: 'Deletion cancelled' });
        } else {
          console.log(colorWarn('Deletion cancelled'));
        }
        return;
      }

      // Delete comment via API
      await deleteComment(taskId, commentId);

      // Display success
      if (isJsonMode) {
        jsonOutput({}, { message: `Comment ${commentId} deleted` });
      } else {
        console.log(colorSuccess(`Comment ${commentId} deleted successfully`));
      }
    } catch (error) {
      handleError(error);
    }
  });
