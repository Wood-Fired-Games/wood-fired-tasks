import { Command } from 'commander';
import { addComment } from '../api/client.js';
import { colorError, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { promptForMissing } from '../prompts/interactive.js';

export const commentAddCommand = new Command('comment-add')
  .description('Add a comment to a task')
  .argument('<id>', 'Task ID')
  .option('-a, --author <author>', 'Comment author name')
  .option('-c, --content <content>', 'Comment text')
  .action(async (idStr, options) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = commentAddCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Prompt for missing required fields
      const author = await promptForMissing('author', options.author);
      const content = await promptForMissing('content', options.content);

      // Add comment via API
      const comment = await addComment(id, {
        author: author as string,
        content: content as string,
      });

      // Display success
      if (isJsonMode) {
        jsonOutput({ comment });
      } else {
        console.log(colorSuccess(`Comment added to task ${id}`));
      }
    } catch (error) {
      handleError(error);
    }
  });
