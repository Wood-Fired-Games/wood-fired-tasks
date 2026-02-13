import { Command } from 'commander';
import { listTasks } from '../api/client.js';
import { formatTaskTable } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import chalk from 'chalk';
import type { TaskFilters } from '../api/types.js';

const VALID_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'];

export const listCommand = new Command('list')
  .description('List tasks with optional filters')
  .option('-p, --project <id>', 'Filter by project ID', parseInt)
  .option('-s, --status <status>', 'Filter by status')
  .option('-a, --assignee <name>', 'Filter by assignee')
  .option('--search <query>', 'Search tasks by title/description')
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--due-before <date>', 'Tasks due before date (ISO8601)')
  .option('--due-after <date>', 'Tasks due after date (ISO8601)')
  .action(async (options) => {
    try {
      // Validate status if provided
      if (options.status && !VALID_STATUSES.includes(options.status)) {
        console.error(
          chalk.red(
            `Invalid status: ${options.status}. Valid options: ${VALID_STATUSES.join(', ')}`
          )
        );
        process.exitCode = 1;
        return;
      }

      // Validate project ID if provided
      if (options.project !== undefined && isNaN(options.project)) {
        console.error(chalk.red('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Build filters object - only include properties that were actually provided
      const filters: TaskFilters = {};

      if (options.project !== undefined) {
        filters.project_id = options.project;
      }
      if (options.status) {
        filters.status = options.status;
      }
      if (options.assignee) {
        filters.assignee = options.assignee;
      }
      if (options.search) {
        filters.search = options.search;
      }
      if (options.tags) {
        // API expects tags as comma-separated string in query param
        filters.tags = options.tags;
      }
      if (options.dueBefore) {
        filters.due_before = options.dueBefore;
      }
      if (options.dueAfter) {
        filters.due_after = options.dueAfter;
      }

      // Call API
      const tasks = await listTasks(Object.keys(filters).length > 0 ? filters : undefined);

      // Display results
      if (tasks.length === 0) {
        console.log(chalk.yellow('No tasks found'));
        return;
      }

      console.log(formatTaskTable(tasks));
      console.log(chalk.gray(`\n${tasks.length} task(s) found`));
    } catch (error) {
      handleError(error);
    }
  });
