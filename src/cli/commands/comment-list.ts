import { Command } from 'commander';
import { getComments } from '../api/client.js';
import { formatCommentList, colorError } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

const MAX_LIMIT = 500;

export const commentListCommand = new Command('comment-list')
  .description('List comments for a task')
  .argument('<id>', 'Task ID')
  .option('--limit <n>', `Max rows to return (default 50, max ${MAX_LIMIT})`, (v) => parseInt(v, 10))
  .option('--offset <n>', 'Zero-based offset for pagination (default 0)', (v) => parseInt(v, 10))
  .action(async (idStr, options) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > MAX_LIMIT) {
          console.error(
            colorError(`Invalid --limit: must be an integer between 1 and ${MAX_LIMIT}`)
          );
          process.exitCode = 1;
          return;
        }
      }
      if (options.offset !== undefined) {
        if (!Number.isInteger(options.offset) || options.offset < 0) {
          console.error(colorError('Invalid --offset: must be a non-negative integer'));
          process.exitCode = 1;
          return;
        }
      }

      // Check if JSON mode (global flag from program)
      const program = commentListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Get comments via API
      const comments = await getComments(id, {
        limit: options.limit,
        offset: options.offset,
      });

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
