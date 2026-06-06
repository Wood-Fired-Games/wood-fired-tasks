import { Command } from 'commander';
import { createTask, withApiSpinner } from '../api/client.js';
import { formatTaskDetail, colorSuccess, colorError } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { promptForMissing } from '../prompts/interactive.js';
import type { CreateTaskInput } from '../api/types.js';

const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const createCommand = new Command('create')
  .description('Create a new task')
  .option('-t, --title <title>', 'Task title')
  .option('-p, --project <id>', 'Project ID', parseInt)
  .option('-c, --created-by <name>', 'Creator name')
  .option('-d, --description <text>', 'Task description')
  .option('--priority <level>', 'Priority: low, medium, high, urgent', 'medium')
  .option('-a, --assignee <name>', 'Assignee name')
  .option('--due <date>', 'Due date (ISO8601 format, e.g. 2025-12-31T00:00:00Z)')
  .option('--tags <tags>', 'Comma-separated tags')
  // Wave 1.3 (#311): single-value flag carrying plain-text (markdown) acceptance
  // criteria. Newlines inside the string are preserved by the shell when quoted,
  // so `--acceptance $'line1\nline2'` works without needing a repeatable option
  // collector. (Repeatable collection is a possible v2 enhancement once we see
  // how callers actually want to express multi-clause criteria.)
  .option('--acceptance <text>', 'Acceptance criteria (plain text / markdown)')
  .action(async (options) => {
    try {
      // Check if JSON mode (global flag from program)
      const program = createCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Prompt for missing required fields (interactive mode only)
      const title = await promptForMissing('title', options.title);
      const projectStr = await promptForMissing('project', options.project);
      const createdBy = await promptForMissing('created-by', options.createdBy);

      // Parse and validate project ID
      const project = typeof projectStr === 'number' ? projectStr : parseInt(projectStr, 10);
      if (isNaN(project)) {
        if (isJsonMode) {
          process.stderr.write('Invalid project ID: must be a number\n');
        } else {
          console.error(colorError('Invalid project ID: must be a number'));
        }
        process.exitCode = 1;
        return;
      }

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

      // Build input object
      const input: CreateTaskInput = {
        title: title as string,
        project_id: project,
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
      if (options.acceptance) {
        input.acceptance_criteria = options.acceptance;
      }

      // Create task via API
      const task = await withApiSpinner('Creating task...', () => createTask(input));

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ task }, { id: task.id });
      } else {
        // Terminal mode: formatted output
        console.log(colorSuccess('Task created successfully'));
        console.log('');
        console.log(formatTaskDetail(task));
      }
    } catch (error) {
      handleError(error);
    }
  });
