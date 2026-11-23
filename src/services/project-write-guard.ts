import type { IProjectRepository } from '../repositories/interfaces.js';
import { projectArchivedError } from './errors.js';

/**
 * Archived project state: the single write guard every mutating service path
 * calls before it changes anything inside a project
 * (docs/design/project-archived-state.md §2.3).
 *
 * Throws the `project_archived` BusinessError (HTTP 422) when the project is
 * archived. Because the freeze is enforced here, at the service layer, an
 * agent that reaches an archived task through a stale id or an old client
 * cannot change it, whatever the listing defaults are.
 *
 * A project that does not exist is NOT this guard's concern — it returns
 * silently so the caller's own not-found handling stays in charge.
 */
export function assertProjectWritable(
  projectRepo: Pick<IProjectRepository, 'findById'>,
  projectId: number,
): void {
  if (isProjectArchived(projectRepo, projectId)) {
    throw projectArchivedError(projectId);
  }
}

/**
 * The non-throwing form of the same test, for internal callers that must
 * decide up front NOT to attempt a write (the workflow cascade) instead of
 * attempting it and handling the refusal. A project that does not exist is
 * not archived.
 */
export function isProjectArchived(
  projectRepo: Pick<IProjectRepository, 'findById'>,
  projectId: number,
): boolean {
  return projectRepo.findById(projectId)?.archived === true;
}
