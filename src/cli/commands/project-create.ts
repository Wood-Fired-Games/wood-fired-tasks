import { Command } from 'commander';
import { createProject } from '../api/client.js';
import { formatProjectDetail } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { promptForMissing } from '../prompts/interactive.js';
import chalk from 'chalk';
import type { CreateProjectInput } from '../api/types.js';

export const projectCreateCommand = new Command('project-create')
  .description('Create a new project')
  .option('-n, --name <name>', 'Project name')
  .option('-d, --description <text>', 'Project description')
  .action(async (options) => {
    try {
      // Check if JSON mode (global flag from program)
      const program = projectCreateCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Prompt for missing required fields (interactive mode only)
      const name = await promptForMissing('name', options.name);

      // Build input object
      const input: CreateProjectInput = {
        name: name as string,
      };

      if (options.description !== undefined) {
        input.description = options.description;
      }

      // Create project via API
      const project = await createProject(input);

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ project }, { id: project.id });
      } else {
        // Terminal mode: formatted output
        console.log(chalk.green('Project created successfully'));
        console.log('');
        console.log(formatProjectDetail(project));
      }
    } catch (error) {
      handleError(error);
    }
  });
