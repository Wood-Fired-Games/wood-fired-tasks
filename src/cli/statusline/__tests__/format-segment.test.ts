/**
 * Pure-function unit tests for src/cli/statusline/format-segment.ts (task #596).
 *
 * Mirrors the env-gating discipline of formatters.test.ts: each test snapshots
 * and restores NO_COLOR / COLUMNS / argv so color and width decisions are
 * deterministic regardless of the surrounding shell.
 *
 * Covers the six render cases from AC#5:
 *   1. colored (both segments)
 *   2. no-color (NO_COLOR set)
 *   3. COLUMNS-constrained
 *   4. counts-only (unlinked hint, up-to-date)
 *   5. hint-only (unlinked project, update available)
 *   6. both-segments (linked + update available)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { formatStatuslineSegment, type ProjectCounts } from '../format-segment.js';

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
const ORIGINAL_COLUMNS = process.env.COLUMNS;
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_CHALK_LEVEL = chalk.level;

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');
const visibleLen = (s: string): number => stripAnsi(s).length;

const COUNTS: ProjectCounts = { projectName: 'myproj', open: 3, doneClosed: 7 };

describe('formatStatuslineSegment', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.COLUMNS;
    process.argv = ['node', 'test'];
    // Force chalk to believe colors are supported so shouldUseColor()'s
    // policy (not chalk's terminal sniff) drives the colored-output test.
    chalk.level = 1;
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    if (ORIGINAL_COLUMNS === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = ORIGINAL_COLUMNS;
    process.argv = [...ORIGINAL_ARGV];
    chalk.level = ORIGINAL_CHALK_LEVEL;
  });

  // ── Case 1: colored (both segments) ──────────────────────────────────────
  it('emits ANSI codes when color is active (colored render)', () => {
    const out = formatStatuslineSegment({ counts: COUNTS, updateAvailable: true });
    // Contains an ANSI escape sequence.
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\[/);
    // Visible text still present after stripping color.
    const plain = stripAnsi(out);
    expect(plain).toContain('myproj');
    expect(plain).toContain('3 open');
    expect(plain).toContain('7 done');
    expect(plain).toContain('⬆ /tasks:update');
  });

  // ── Case 2: no-color (NO_COLOR set) ──────────────────────────────────────
  it('emits no ANSI codes when NO_COLOR is set (no-color render)', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({ counts: COUNTS, updateAvailable: true });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
    expect(out).toContain('myproj 3 open · 7 done');
    expect(out).toContain('⬆ /tasks:update');
  });

  it('emits no ANSI codes when color: false is passed (--no-color render)', () => {
    const out = formatStatuslineSegment({
      counts: COUNTS,
      updateAvailable: true,
      color: false,
    });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });

  // ── Case 3: COLUMNS-constrained ──────────────────────────────────────────
  it('keeps rendered width within COLUMNS (env-driven)', () => {
    process.env.NO_COLOR = '1';
    process.env.COLUMNS = '25';
    const out = formatStatuslineSegment({ counts: COUNTS, updateAvailable: true });
    expect(visibleLen(out)).toBeLessThanOrEqual(25);
    // The high-signal hint segment survives truncation.
    expect(out).toContain('⬆ /tasks:update');
  });

  it('keeps rendered width within COLUMNS (explicit option, with color)', () => {
    const out = formatStatuslineSegment({
      counts: COUNTS,
      updateAvailable: true,
      columns: 20,
    });
    expect(visibleLen(out)).toBeLessThanOrEqual(20);
  });

  it('truncates a single overflowing segment with an ellipsis', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({
      counts: { projectName: 'a-very-long-project-name', open: 12, doneClosed: 34 },
      columns: 10,
    });
    expect(visibleLen(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  // ── Case 4: counts-only (no hint) ────────────────────────────────────────
  it('renders counts only when no update is available (counts-only)', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({ counts: COUNTS, updateAvailable: false });
    expect(out).toBe('myproj 3 open · 7 done');
    expect(out).not.toContain('/tasks:update');
  });

  it('omits the hint when updateAvailable is undefined (counts-only)', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({ counts: COUNTS });
    expect(out).toBe('myproj 3 open · 7 done');
  });

  // ── Case 5: hint-only (unlinked) ─────────────────────────────────────────
  it('renders the hint only when unlinked but update available (hint-only)', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({ updateAvailable: true });
    expect(out).toBe('⬆ /tasks:update');
    expect(out).not.toContain('open');
  });

  it('returns empty string when both segments are omitted', () => {
    process.env.NO_COLOR = '1';
    expect(formatStatuslineSegment({})).toBe('');
    expect(formatStatuslineSegment({ updateAvailable: false })).toBe('');
  });

  // ── Case 6: both-segments (linked + update available) ────────────────────
  it('composes a single line with both segments (both-segments)', () => {
    process.env.NO_COLOR = '1';
    const out = formatStatuslineSegment({ counts: COUNTS, updateAvailable: true });
    expect(out).toBe('myproj 3 open · 7 done  ⬆ /tasks:update');
    // Single line — no embedded newline.
    expect(out).not.toContain('\n');
  });
});
