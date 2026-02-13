import { Command } from 'commander';
import { createTask } from '../api/client.js';
import { formatTaskDetail } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import chalk from 'chalk';
import type { CreateTaskInput } from '../api/types.js';

const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const createCommand = new Command('create')
  .description('Create a new task')
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-p, --project <id>', 'Project ID', parseInt)
  .requiredOption('-c, --created-by <name>', 'Creator name')
  .option('-d, --description <text>', 'Task description')
  .option('--priority <level>', 'Priority: low, medium, high, urgent', 'medium')
  .option('-a, --assignee <name>', 'Assignee name')
  .option('--due <date>', 'Due date (ISO8601 format, e.g. 2025-12-31T00:00:00Z)')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (options) => {
    try {
      // Validate priority
      if (!VALID_PRIORITIES.includes(options.priority)) {
        console.error(
          chalk.red(
            `Invalid priority: ${options.priority}. Valid options: ${VALID_PRIORITIES.join(', ')}`
          )
        );
        process.exitCode = 1;
        return;
      }

      // Validate project ID
      if (isNaN(options.project)) {
        console.error(chalk.red('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Build input object
      const input: CreateTaskInput = {
        title: options.title,
        project_id: options.project,
        created_by: options.createdBy,
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

      // Create task via API
      const task = await createTask(input);

      // Display success
      console.log(chalk.green('Task created successfully'));
      console.log('');
      console.log(formatTaskDetail(task));
    } catch (error) {
      handleError(error);
    }
  });
