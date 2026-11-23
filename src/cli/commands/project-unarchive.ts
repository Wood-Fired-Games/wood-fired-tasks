import { Command } from 'commander';
import { unarchiveProject } from '../api/client.js';
import { formatProjectDetail, colorError, colorSuccess } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput } from '../output/json-output.js';
import { parseProjectId } from './project-archive.js';

/**
 * `tasks project-unarchive <id>` (WFT #2477). A project that is not archived
 * comes back unchanged.
 */
export const projectUnarchiveCommand = new Command('project-unarchive')
  .description('Unarchive a project: return it to default listings and allow changes again')
  .argument('<id>', 'Project ID to unarchive')
  .action(async (idStr: string) => {
    try {
      const id = parseProjectId(idStr);
      if (id === null) {
        console.error(colorError('Invalid project ID: must be a positive whole number'));
        process.exitCode = 1;
        return;
      }

      const project = await unarchiveProject(id);

      const globalOpts = projectUnarchiveCommand.parent?.optsWithGlobals() || {};
      if (globalOpts['json']) {
        jsonOutput({ project });
      } else {
        console.log(colorSuccess(`Project #${id} unarchived`));
        console.log(formatProjectDetail(project));
      }
    } catch (error) {
      handleError(error);
    }
  });
