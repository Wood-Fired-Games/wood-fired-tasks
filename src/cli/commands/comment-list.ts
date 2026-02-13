import { Command } from 'commander';
import { getComments } from '../api/client.js';
import { formatCommentList } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import chalk from 'chalk';

export const commentListCommand = new Command('comment-list')
  .description('List comments for a task')
  .argument('<id>', 'Task ID')
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
      const program = commentListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Get comments via API
      const comments = await getComments(id);

      // Display results
      if (isJsonMode) {
        jsonOutput(comments);
      } else {
        console.log(formatCommentList(comments));
      }
    } catch (error) {
      handleError(error);
    }
  });
