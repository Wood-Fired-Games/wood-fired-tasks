import { Command } from 'commander';
import { unarchiveProject } from '../api/client.js';
import { formatProjectDetail, colorError, colorSuccess, colorWarn } from '../output/formatters.js';
import { formatReevaluationFailures } from '../../mcp/lib/project-tool-definitions.js';
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
        // `project.reevaluation_failed_task_ids` carries any failures (WFT #2542).
        jsonOutput({ project });
      } else {
        console.log(colorSuccess(`Project #${id} unarchived`));
        console.log(formatProjectDetail(project));
        // The unarchive succeeded, so the exit status stays 0; the tasks that
        // kept their old state are named on stderr (WFT #2542).
        const warning = formatReevaluationFailures(id, project.reevaluation_failed_task_ids);
        if (warning) {
          console.error(colorWarn(warning));
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
