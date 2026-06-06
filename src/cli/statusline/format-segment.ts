/**
 * Status-line segment formatter (project 29, task #596).
 *
 * A PURE function that composes the one-line status-line segment Claude Code
 * renders below the prompt. It assembles up to TWO independently-omittable
 * pieces:
 *
 *   1. A linked-project counts segment — the linked project's name plus its
 *      open and done/closed task counts (e.g. `myproj 3 open · 7 done`).
 *   2. An update-available hint segment — a short nudge to run the updater
 *      (e.g. `⬆ /tasks:update`).
 *
 * Each piece is omitted independently:
 *   - No counts segment when the workspace is unlinked (no `counts` input).
 *   - No hint segment when up-to-date or the hint is disabled
 *     (`updateAvailable` falsy).
 *
 * This module performs NO I/O. It does not read the update-check cache, does
 * not call the network, and does not resolve the linked project — those are
 * the jobs of #795 / #597 / the count-fetcher. Every input arrives as a
 * parameter so the function stays deterministic and trivially testable.
 *
 * Color is gated through {@link shouldUseColor} / {@link colorBold} from the
 * shared formatters module, so `NO_COLOR` and `--json`/`--no-color` are honored
 * without this module re-implementing the policy. Width is bounded by
 * `process.env.COLUMNS` (or an explicit `columns` option) measured against the
 * *visible* (ANSI-stripped) length, so colored and plain renders truncate
 * identically.
 */

import { shouldUseColor, colorBold } from '../output/formatters.js';

/** The linked-project counts the status line displays. */
export interface ProjectCounts {
  /** Display name of the linked project. */
  projectName: string;
  /** Number of tasks still in `open` status. */
  open: number;
  /** Number of finished tasks (`done` + `closed`, already summed). */
  doneClosed: number;
}

/** Inputs to {@link formatStatuslineSegment}. All are plain data — no I/O. */
export interface FormatStatuslineSegmentOptions {
  /**
   * Linked-project counts. Omit (or pass `undefined`) when the workspace is
   * unlinked — the counts segment is then skipped entirely.
   */
  counts?: ProjectCounts | undefined;

  /**
   * Whether a newer release is available. When falsy (up-to-date or the hint
   * is disabled) the update hint segment is skipped entirely.
   */
  updateAvailable?: boolean | undefined;

  /**
   * Color override. When omitted, color is decided by {@link shouldUseColor}
   * (which honors `NO_COLOR` and `--json`). Pass `false` to force plain output
   * (e.g. a `--no-color` flag) regardless of environment.
   */
  color?: boolean | undefined;

  /**
   * Hard width ceiling for the rendered (visible) line. When omitted, falls
   * back to `process.env.COLUMNS`. When neither is set/valid, width is
   * unbounded.
   */
  columns?: number | undefined;
}

/** The separator placed between the counts segment and the hint segment. */
const SEGMENT_SEPARATOR = '  ';

/** The update-available hint text (without color). */
const UPDATE_HINT = '⬆ /tasks:update';

/** Ellipsis used when a segment is truncated to fit COLUMNS. */
const ELLIPSIS = '…';

/**
 * Match ANSI SGR escape sequences (color/style codes) so we can measure the
 * *visible* width of a string. Kept local — there is no `strip-ansi` dep.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI color codes. */
function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

/** Strip ANSI color codes from a string. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Resolve the effective COLUMNS limit. Explicit `columns` wins; otherwise
 * read `process.env.COLUMNS`. Returns `undefined` when there is no positive
 * integer limit (i.e. width is unbounded).
 */
function resolveColumns(explicit: number | undefined): number | undefined {
  if (explicit !== undefined) {
    return explicit > 0 && Number.isFinite(explicit) ? Math.floor(explicit) : undefined;
  }
  const raw = process.env['COLUMNS'];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Truncate a (possibly colored) segment so its *visible* width is at most
 * `max`, appending an ellipsis when characters are dropped. Because color
 * codes have zero visible width, we strip them before truncating and re-emit
 * plain text — a truncated segment is rare and not worth re-applying SGR to.
 */
function truncateVisible(segment: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (visibleLength(segment) <= max) {
    return segment;
  }
  const plain = stripAnsi(segment);
  if (max <= ELLIPSIS.length) {
    return ELLIPSIS.slice(0, max);
  }
  return plain.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Compose the status-line segment.
 *
 * @returns A single line (no trailing newline). Empty string when both the
 *          counts and hint segments are omitted.
 */
export function formatStatuslineSegment(opts: FormatStatuslineSegmentOptions = {}): string {
  const useColor = opts.color ?? shouldUseColor();
  const bold = (text: string): string => (useColor ? colorBold(text) : text);

  // ── Build the counts segment (omitted when unlinked). ────────────────────
  let countsSegment = '';
  if (opts.counts) {
    const { projectName, open, doneClosed } = opts.counts;
    countsSegment = `${bold(projectName)} ${open} open · ${doneClosed} done`;
  }

  // ── Build the hint segment (omitted when up-to-date/disabled). ───────────
  let hintSegment = '';
  if (opts.updateAvailable) {
    hintSegment = useColor ? colorBold(UPDATE_HINT) : UPDATE_HINT;
  }

  // Nothing to render.
  if (countsSegment === '' && hintSegment === '') {
    return '';
  }

  // ── Compose, then bound to COLUMNS by visible width. ─────────────────────
  const limit = resolveColumns(opts.columns);

  // Single-segment cases: just truncate the one present segment.
  if (countsSegment === '' || hintSegment === '') {
    const only = countsSegment !== '' ? countsSegment : hintSegment;
    return limit === undefined ? only : truncateVisible(only, limit);
  }

  // Both present. Without a limit, join directly.
  const separatorWidth = SEGMENT_SEPARATOR.length;
  if (limit === undefined) {
    return countsSegment + SEGMENT_SEPARATOR + hintSegment;
  }

  const countsWidth = visibleLength(countsSegment);
  const hintWidth = visibleLength(hintSegment);
  const fullWidth = countsWidth + separatorWidth + hintWidth;

  // Everything fits.
  if (fullWidth <= limit) {
    return countsSegment + SEGMENT_SEPARATOR + hintSegment;
  }

  // Doesn't fit. The hint is the higher-signal, lower-cost segment — keep it
  // intact and shrink the counts segment to whatever room remains (including
  // the separator). If even that can't fit, drop the counts entirely; if the
  // hint alone overflows, truncate it.
  const roomForCounts = limit - hintWidth - separatorWidth;
  if (roomForCounts > 0) {
    return truncateVisible(countsSegment, roomForCounts) + SEGMENT_SEPARATOR + hintSegment;
  }
  if (hintWidth <= limit) {
    return hintSegment;
  }
  return truncateVisible(hintSegment, limit);
}
