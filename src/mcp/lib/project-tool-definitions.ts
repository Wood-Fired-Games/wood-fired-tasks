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
  'project that is not archived returns it unchanged.';

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

export function formatUnarchiveResult(project: NamedProject): string {
  return `Project ${project.id} unarchived: ${project.name}`;
}
