import { Command } from 'commander';
import { listProjects } from '../api/client.js';
import { formatProjectTable } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import chalk from 'chalk';

export const projectListCommand = new Command('project-list')
  .description('List all projects')
  .action(async () => {
    try {
      // Call API
      const projects = await listProjects();

      // Check if JSON mode (global flag from program)
      const program = projectListCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Display results
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput(projects, { count: projects.length });
      } else {
        // Terminal mode: formatted output
        if (projects.length === 0) {
          console.log(chalk.yellow('No projects found'));
          return;
        }

        console.log(formatProjectTable(projects));
        console.log(chalk.gray(`\n${projects.length} project(s) found`));
      }
    } catch (error) {
      handleError(error);
    }
  });
