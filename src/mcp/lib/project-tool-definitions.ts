import { z } from 'zod';

/**
 * Archived project state (design §3.5): the tool descriptions, input schemas
 * and text lines that the stdio project tools
 * (`src/mcp/tools/project-tools.ts`) and their remote-bridge twins
 * (`src/mcp/remote/register-tools.ts`) must share verbatim, so the two
 * transports cannot drift on a schema, a description or a line of text.
 *
 * Kept free of service and repository imports so the remote bridge can load
 * it without pulling in the server (same reason as
 * `model-tool-definitions.ts`).
 */

export const LIST_PROJECTS_DESCRIPTION =
  'List projects with pagination (limit default 50, max 500; offset default 0). Returns ' +
  '`{ projects, total, limit, offset }`. Archived projects are omitted unless archived is ' +
  '"include" (return them too) or "only" (return nothing else); total counts the filtered set.';

export const ARCHIVE_PROJECT_DESCRIPTION =
  'Archive a project: it leaves default listings and becomes read-only (its tasks stay ' +
  'readable by id; comments are still allowed). Refused with `project_has_unfinished_tasks` ' +
  'while any task is open, in_progress, blocked or backlogged, unless `force: true` with a ' +
  '`reason`. Archiving an already archived project returns it unchanged. Reversible with ' +
  'unarchive_project.';

export const UNARCHIVE_PROJECT_DESCRIPTION =
  'Unarchive a project so it accepts work again and returns to default listings. Blocked ' +
  'tasks whose blockers all finished while it was archived are reopened. Unarchiving a ' +
  'project that is not archived returns it unchanged. The result carries ' +
  '`reevaluation_failed_task_ids`: tasks whose re-evaluation rolled back (empty on a clean ' +
  'pass); call unarchive_project again to retry them.';

/**
 * `archive_project` arguments. `reason` and `force` are validated by the
 * service's `ArchiveProjectSchema` (trim, 500-character cap, `force` needs a
 * `reason`); the tool schema only fixes their types so the two cannot disagree.
 */
export const ArchiveProjectToolSchema = z.object({
  id: z.number().int().positive(),
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export const UnarchiveProjectToolSchema = z.object({
  id: z.number().int().positive(),
});

/**
 * The archive fields as either transport sees them: always present from the
 * in-process service, optional from a REST response (a server that predates
 * the feature sends none, which reads as "not archived").
 */
export interface ArchiveFields {
  archived?: boolean | undefined;
  archived_at?: string | null | undefined;
  archived_by?: string | null | undefined;
  archive_reason?: string | null | undefined;
}

interface NamedProject {
  id: number;
  name: string;
}

/** The `Archived: …` line of a `get_project` summary, or null when not archived. */
export function formatArchivedLine(project: ArchiveFields): string | null {
  if (!project.archived) {
    return null;
  }
  const by = project.archived_by ? ` by ${project.archived_by}` : '';
  const reason = project.archive_reason ? ` (reason: ${project.archive_reason})` : '';
  return `Archived: ${project.archived_at ?? 'unknown'}${by}${reason}`;
}

/** One `list_projects` text line; an archived project is marked. */
export function formatProjectListLine(project: NamedProject & ArchiveFields): string {
  return `- [${project.id}] ${project.name}${project.archived ? ' (archived)' : ''}`;
}

export function formatArchiveResult(project: NamedProject): string {
  return `Project ${project.id} archived: ${project.name}`;
}

/**
 * The warning for tasks whose unarchive re-evaluation rolled back
 * (WFT #2542), or null when none did. Shared by the MCP tools (both
 * transports), the CLI and Slack so every surface says the same thing.
 *
 * `undefined` means the server did not send the field (it is older than
 * #2542). That is not "nothing failed", so a note says the result is unknown
 * (WFT #2552 point 2).
 */
export function formatReevaluationFailures(
  projectId: number,
  failedTaskIds: readonly number[] | undefined,
): string | null {
  if (failedTaskIds === undefined) {
    return (
      'Note: the server did not report which tasks failed re-evaluation (it is older than ' +
      `this client); check the blocked tasks of project ${projectId}.`
    );
  }
  if (failedTaskIds.length === 0) {
    return null;
  }
  const noun = failedTaskIds.length === 1 ? 'task' : 'tasks';
  return (
    `Warning: re-evaluation failed for ${noun} ${failedTaskIds.join(', ')}; ` +
    `they kept their old state. Unarchive again to retry ` +
    `(tasks project-unarchive ${projectId}, or unarchive_project).`
  );
}

/** The unarchive result: the confirmation, then any re-evaluation warning. */
export function formatUnarchiveResult(
  project: NamedProject & { reevaluation_failed_task_ids?: readonly number[] | undefined },
): string {
  const lines = [`Project ${project.id} unarchived: ${project.name}`];
  const warning = formatReevaluationFailures(project.id, project.reevaluation_failed_task_ids);
  if (warning) {
    lines.push(warning);
  }
  return lines.join('\n');
}
