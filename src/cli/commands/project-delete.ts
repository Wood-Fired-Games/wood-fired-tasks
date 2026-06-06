import { Command } from 'commander';
import { deleteProject, getProject } from '../api/client.js';
import { colorError, colorWarn, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { confirmAction } from '../prompts/interactive.js';

export const projectDeleteCommand = new Command('project-delete')
  .description('Delete a project by ID')
  .argument('<id>', 'Project ID to delete')
  .action(async (idStr) => {
    try {
      // Parse and validate project ID
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error(colorError('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Check if JSON mode (global flag from program)
      const program = projectDeleteCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts.json || false;

      // Fetch project details to show what's being deleted
      const project = await getProject(id);

      // Confirm deletion (unless --force)
      const confirmed = await confirmAction(`Delete project '${project.name}'?`, false);

      if (!confirmed) {
        if (isJsonMode) {
          // JSON mode: output cancellation envelope
          jsonOutput({}, { message: 'Deletion cancelled' });
        } else {
          // Terminal mode: info message
          console.log(colorWarn('Deletion cancelled'));
        }
        return;
      }

      // Delete project via API
      await deleteProject(id);

      // Display success
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput({}, { message: `Project ${id} deleted` });
      } else {
        // Terminal mode: success message
        console.log(colorSuccess(`Project #${id} deleted successfully`));
      }
    } catch (error) {
      handleError(error);
    }
  });
