import { Command } from 'commander';
import { getProject } from '../api/client.js';
import { formatProjectDetail, colorError } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';

export const projectShowCommand = new Command('project-show')
  .description('Show project details by ID')
  .argument('<id>', 'Project ID to show')
  .action(async (idStr) => {
    try {
      // Parse and validate project ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Fetch project details
      const project = await getProject(id);

      // Check if JSON mode (global flag from program)
      const program = projectShowCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Display project
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({ project });
      } else {
        // Terminal mode: formatted output
        console.log(formatProjectDetail(project));
      }
    } catch (error) {
      handleError(error);
    }
  });
