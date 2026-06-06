import { Command } from 'commander';
import { updateTask, withApiSpinner } from '../api/client.js';
import { formatTaskDetail, colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import type { UpdateTaskInput } from '../api/types.js';

const VALID_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const updateCommand = new Command('update')
  .description('Update a task by ID')
  .argument('<id>', 'Task ID to update')
  .option('-t, --title <title>', 'New title')
  .option('-d, --description <text>', 'New description')
  .option('-s, --status <status>', 'New status')
  .option('--priority <level>', 'New priority')
  .option('-a, --assignee <name>', 'New assignee')
  .option('--due <date>', 'New due date (ISO8601)')
  .option('--tags <tags>', 'New tags (comma-separated, replaces existing)')
  .action(async (idStr, options) => {
    try {
      // Parse and validate task ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Validate status if provided
      if (options.status && !VALID_STATUSES.includes(options.status)) {
        console.error(
          colorError(
            `Invalid status: ${options.status}. Valid options: ${VALID_STATUSES.join(', ')}`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Validate priority if provided
      if (options.priority && !VALID_PRIORITIES.includes(options.priority)) {
        console.error(
          colorError(
            `Invalid priority: ${options.priority}. Valid options: ${VALID_PRIORITIES.join(', ')}`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Build updates object - only include properties that were actually provided
      const updates: UpdateTaskInput = {};

      if (options.title !== undefined) {
        updates.title = options.title;
      }
      if (options.description !== undefined) {
        updates.description = options.description;
      }
      if (options.status !== undefined) {
        updates.status = options.status;
      }
      if (options.priority !== undefined) {
        updates.priority = options.priority;
      }
      if (options.assignee !== undefined) {
        updates.assignee = options.assignee;
      }
      if (options.due !== undefined) {
        updates.due_date = options.due;
      }
      if (options.tags !== undefined) {
        updates.tags = options.tags.split(',').map((tag: string) => tag.trim());
      }

      // Check if any updates were specified
      if (Object.keys(updates).length === 0) {
        console.log(colorWarn('No updates specified. Use --help to see available options.'));
        process.exitCode = 1;
        return;
      }

      // Call API
      const task = await withApiSpinner('Updating task...', () => updateTask(id, updates));

      // Check if JSON mode (global flag from program)
      const program = updateCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ task }, { id: task.id });
      } else {
        // Terminal mode: formatted output
        console.log(colorSuccess(`Task #${task.id} updated successfully`));
        console.log('');
        console.log(formatTaskDetail(task));
      }
    } catch (error) {
      handleError(error);
    }
  });
