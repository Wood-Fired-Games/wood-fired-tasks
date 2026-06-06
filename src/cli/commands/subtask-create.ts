import { Command } from 'commander';
import { createSubtask, getTask } from '../api/client.js';
import { formatTaskDetail, colorError, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { promptForMissing } from '../prompts/interactive.js';
import type { CreateTaskInput } from '../api/types.js';

const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const subtaskCreateCommand = new Command('subtask-create')
  .description('Create a subtask under a parent task')
  .argument('<parent-id>', 'Parent task ID')
  .option('-t, --title <title>', 'Subtask title')
  .option('-d, --description <text>', 'Subtask description')
  .option('-c, --created-by <name>', 'Creator name')
  .option('-a, --assignee <name>', 'Assignee name')
  .option('--priority <level>', 'Priority: low, medium, high, urgent', 'medium')
  .option('-s, --status <status>', 'Status', 'open')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--due <date>', 'Due date (ISO8601 format)')
  .action(async (parentIdStr, options) => {
    try {
      // Parse and validate parent task ID
      const parentId = parseInt(parentIdStr, 10);
      if (isNaN(parentId)) {
        console.error(colorError('Invalid parent task ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = subtaskCreateCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Fetch parent task to inherit project_id
      const parentTask = await getTask(parentId);

      // Prompt for missing required fields
      const title = await promptForMissing('title', options.title);
      const createdBy = await promptForMissing('created-by', options.createdBy);

      // Validate priority
      if (!VALID_PRIORITIES.includes(options.priority)) {
        if (isJsonMode) {
          process.stderr.write(
            `Invalid priority: ${options.priority}. Valid options: ${VALID_PRIORITIES.join(', ')}\n`,
          );
        } else {
          console.error(
            colorError(
              `Invalid priority: ${options.priority}. Valid options: ${VALID_PRIORITIES.join(', ')}`,
            ),
          );
        }
        process.exitCode = 1;
        return;
      }

      // Build input object (inherit project_id from parent)
      const input: CreateTaskInput = {
        title: title as string,
        project_id: parentTask.project_id,
        created_by: createdBy as string,
      };

      if (options.description) {
        input.description = options.description;
      }
      if (options.priority) {
        input.priority = options.priority;
      }
      if (options.assignee) {
        input.assignee = options.assignee;
      }
      if (options.due) {
        input.due_date = options.due;
      }
      if (options.tags) {
        input.tags = options.tags.split(',').map((tag: string) => tag.trim());
      }

      // Create subtask via API
      const task = await createSubtask(parentId, input);

      // Display success
      if (isJsonMode) {
        jsonOutput({ task }, { id: task.id, parent_task_id: parentId });
      } else {
        console.log(colorSuccess(`Subtask created under task #${parentId}`));
        console.log('');
        console.log(formatTaskDetail(task));
      }
    } catch (error) {
      handleError(error);
    }
  });
