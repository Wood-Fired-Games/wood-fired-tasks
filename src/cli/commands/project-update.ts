import { Command } from 'commander';
import { updateProject } from '../api/client.js';
import { formatProjectDetail } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import chalk from 'chalk';
import type { UpdateProjectInput } from '../api/types.js';

export const projectUpdateCommand = new Command('project-update')
  .description('Update a project by ID')
  .argument('<id>', 'Project ID to update')
  .option('-n, --name <name>', 'New project name')
  .option('-d, --description <text>', 'New project description')
  .action(async (idStr, options) => {
    try {
      // Parse and validate project ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(chalk.red('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Build updates object - only include properties that were actually provided
      const updates: UpdateProjectInput = {};

      if (options.name !== undefined) {
        updates.name = options.name;
      }
      if (options.description !== undefined) {
        updates.description = options.description;
      }

      // Check if any updates were specified
      if (Object.keys(updates).length === 0) {
        console.log(chalk.yellow('No updates specified. Use --help to see available options.'));
        process.exitCode = 1;
        return;
      }

      // Call API
      const project = await updateProject(id, updates);

      // Check if JSON mode (global flag from program)
      const program = projectUpdateCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ project }, { id: project.id });
      } else {
        // Terminal mode: formatted output
        console.log(chalk.green(`Project #${project.id} updated successfully`));
        console.log('');
        console.log(formatProjectDetail(project));
      }
    } catch (error) {
      handleError(error);
    }
  });
