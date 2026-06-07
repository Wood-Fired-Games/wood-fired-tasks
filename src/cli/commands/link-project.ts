/**
 * Phase 4 (status-line), project 29, task #595 — `tasks link-project` command.
 *
 * Writes the repo-local `.wft/project` marker that the #593 resolver
 * (src/cli/statusline/resolve-project.ts) reads on its `wft_marker` rung. The
 * marker payload is the FIRST non-empty, non-comment line — a bare numeric
 * project id (→ `projectId`) or a project name (→ `repoName`). We mirror that
 * exact format so the resolver round-trips what we write.
 *
 * Resolution of the identifier to persist:
 *   1. An explicit `<project>` arg, when given. A bare integer is written as a
 *      numeric id; anything else is written verbatim as a name.
 *   2. Otherwise, fall back to {@link resolveProjectFromCwd}. If it resolves to
 *      a project (any rung), we persist the numeric id when known, else the
 *      repo-name candidate. If it cannot resolve, the command errors (the user
 *      must pass an explicit id/name).
 *
 * Write durability mirrors src/cli/auth/credentials.ts and the #592 cache
 * module: `mkdir -p` the `.wft/` dir, write a `.tmp.<pid>.<ts>` sibling, then
 * `renameSync` onto the final path. POSIX rename(2) is atomic within a single
 * filesystem, so a concurrent reader never observes a partial marker. Re-running
 * simply renames a fresh tmp over the existing marker — idempotent, no error.
 *
 * `--json` (global flag) emits a single envelope describing the written marker.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { resolveProjectFromCwd } from '../statusline/resolve-project.js';

/** Shape of the value persisted to `.wft/project`. */
interface MarkerValue {
  /** Numeric project id, when the identifier is (or resolved to) an integer. */
  projectId?: number;
  /** Project / repo name, when the identifier is non-numeric. */
  repoName?: string;
}

/** Emit one newline-terminated JSON envelope on stdout (used in --json mode). */
function emitJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Coerce an explicit identifier string into a {@link MarkerValue}. A string
 * that is purely a positive integer becomes a `projectId`; anything else is a
 * `repoName`. Mirrors the resolver's `coerceProjectId` acceptance so the marker
 * we write parses back to the same shape.
 */
function classifyIdentifier(identifier: string): MarkerValue {
  const trimmed = identifier.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) return { projectId: n };
  }
  return { repoName: trimmed };
}

/** The single payload line written to the marker (id wins over name). */
function markerLine(value: MarkerValue): string {
  if (value.projectId !== undefined) return String(value.projectId);
  return value.repoName ?? '';
}

/**
 * Atomically write the `.wft/project` marker under `cwd`. Returns the absolute
 * path written. `mkdir -p`'s `.wft/` first; writes a tmp sibling then renames.
 */
function writeMarker(cwd: string, value: MarkerValue): string {
  const wftDir = path.join(cwd, '.wft');
  mkdirSync(wftDir, { recursive: true });

  const markerPath = path.join(wftDir, 'project');
  const body =
    '# Wood Fired Tasks linked-project marker. Written by `tasks link-project`.\n' +
    `${markerLine(value)}\n`;

  const tmp = `${markerPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  // Atomic on POSIX (single-fs rename(2)); MoveFileEx on Windows gives similar
  // semantics. If rename throws (cross-fs), the tmp sibling is left behind —
  // acceptable; the final path never sees partial state.
  renameSync(tmp, markerPath);

  return markerPath;
}

export const linkProjectCommand = new Command('link-project')
  .description('Link the current directory to a Wood Fired Tasks project (writes .wft/project)')
  .argument(
    '[project]',
    'Project id or name to link. Omit to auto-resolve from the working directory.',
  )
  .action(async (project: string | undefined) => {
    const globalOpts = linkProjectCommand.parent?.optsWithGlobals() ?? {};
    const isJson: boolean = globalOpts['json'] === true;

    const cwd = process.cwd();

    // Resolve the identifier to persist.
    let value: MarkerValue;
    if (project !== undefined && project.trim().length > 0) {
      value = classifyIdentifier(project);
    } else {
      const resolution = await resolveProjectFromCwd(cwd);
      if (!resolution.resolved) {
        if (isJson) {
          emitJsonEvent({
            event: 'error',
            message:
              'Could not resolve a project from the working directory. ' +
              'Pass an explicit id or name: tasks link-project <project>',
          });
        } else {
          process.stderr.write(
            'Could not resolve a project from the working directory.\n' +
              'Pass an explicit id or name: tasks link-project <project>\n',
          );
        }
        process.exitCode = 1;
        return;
      }
      value = {};
      if (resolution.projectId !== undefined) value.projectId = resolution.projectId;
      if (resolution.repoName !== undefined && resolution.projectId === undefined) {
        value.repoName = resolution.repoName;
      }
    }

    const markerPath = writeMarker(cwd, value);
    const identifier = markerLine(value);

    if (isJson) {
      const envelope: Record<string, unknown> = {
        event: 'linked',
        marker: markerPath,
        identifier,
      };
      if (value.projectId !== undefined) envelope['projectId'] = value.projectId;
      if (value.repoName !== undefined) envelope['repoName'] = value.repoName;
      emitJsonEvent(envelope);
      return;
    }

    process.stdout.write(`Linked this directory to project ${identifier} (${markerPath})\n`);
  });
