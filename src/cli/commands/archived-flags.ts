import type { ArchivedFilter } from '../../types/task.js';

/**
 * `--include-archived` / `--archived-only` (WFT #2478, design §2.5), shared
 * by `tasks project-list` and `tasks list`: the REST `archived` value for the
 * two flags: `include`, `only`, or
 * `undefined` (send nothing, so the server's default `exclude` applies).
 * `null` means both flags were given, which is a usage error.
 */
export function archivedFilterFromFlags(options: {
  includeArchived?: boolean;
  archivedOnly?: boolean;
}): ArchivedFilter | undefined | null {
  if (options.includeArchived && options.archivedOnly) {
    return null;
  }
  if (options.archivedOnly) {
    return 'only';
  }
  if (options.includeArchived) {
    return 'include';
  }
  return undefined;
}

/** The usage error for both flags at once. */
export const ARCHIVED_FLAGS_CONFLICT = 'Use --include-archived or --archived-only, not both';
