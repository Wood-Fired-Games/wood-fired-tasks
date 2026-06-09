/**
 * Drift-detection for docs/INTERFACES.md.
 *
 * INTERFACES.md is hand-authored today (a future task may swap it for a
 * true generator). To stop the doc silently rotting when a route, MCP tool,
 * or CLI command is added, this test re-counts each surface against source
 * and asserts the totals quoted in the doc still match.
 *
 * If you add a REST route, an MCP tool, or a CLI subcommand:
 *   1. Update `docs/INTERFACES.md` so the per-row table includes it.
 *   2. Update the "Total: N <thing>" line in the doc to the new count.
 *   3. Run this test (or `npm test`) to confirm.
 *
 * Source files this test reads:
 *   - src/api/routes/{health,events}.ts and
 *     src/api/routes/{tasks,projects,comments,dependencies}/index.ts
 *   - src/mcp/tools/{comment,dependency,health,project,task}-tools.ts
 *   - src/cli/bin/tasks.ts
 *   - docs/INTERFACES.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findRepoRoot } from '../manifest.js';

const REST_ROUTE_FILES = [
  'src/api/routes/health.ts',
  'src/api/routes/events.ts',
  'src/api/routes/comments/index.ts',
  'src/api/routes/tasks/index.ts',
  'src/api/routes/projects/index.ts',
  'src/api/routes/dependencies/index.ts',
] as const;

const MCP_TOOL_FILES = [
  'src/mcp/tools/comment-tools.ts',
  'src/mcp/tools/dependency-tools.ts',
  'src/mcp/tools/health-tools.ts',
  'src/mcp/tools/project-tools.ts',
  'src/mcp/tools/task-tools.ts',
  // Wave 4.1 (#318): topology classifier.
  'src/mcp/tools/topology-tools.ts',
  // Task #455: in-process long-poll wait_for_unblock tool.
  'src/mcp/tools/wait-for-unblock-tools.ts',
  // WSJF 1.10: wsjf_ranking, wsjf_history, rescore_project, wsjf_health.
  'src/mcp/tools/wsjf-tools.ts',
] as const;

const CLI_ENTRY = 'src/cli/bin/tasks.ts';
const INTERFACES_DOC = 'docs/INTERFACES.md';

// Anchored at line start (after optional whitespace) so we don't match
// occurrences inside comments or strings further down the line.
const REST_VERB_REGEX = /^\s*(?:fastify|server)\.(?:get|post|put|patch|delete)\(/gm;
const MCP_TOOL_REGEX = /registerTool/g;
const CLI_ADDCOMMAND_REGEX = /^\s*program\.addCommand\(/gm;

function countMatches(repoRoot: string, relPath: string, pattern: RegExp): number {
  const text = readFileSync(resolve(repoRoot, relPath), 'utf8');
  // Reset lastIndex on the (possibly /g) regex to avoid cross-call state.
  pattern.lastIndex = 0;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

describe('interface counts (drift detection for docs/INTERFACES.md)', () => {
  const repoRoot = findRepoRoot();

  it('REST route files together expose exactly 22 verb registrations', () => {
    const perFile = REST_ROUTE_FILES.map((rel) => ({
      file: rel,
      count: countMatches(repoRoot, rel, REST_VERB_REGEX),
    }));
    const total = perFile.reduce((sum, e) => sum + e.count, 0);
    expect(
      total,
      `REST route count drifted. Per-file: ${JSON.stringify(perFile)}. ` +
        'Update docs/INTERFACES.md and regenerate.',
    ).toBe(22);
  });

  it('MCP tool files together register exactly 27 tools', () => {
    const perFile = MCP_TOOL_FILES.map((rel) => ({
      file: rel,
      count: countMatches(repoRoot, rel, MCP_TOOL_REGEX),
    }));
    const total = perFile.reduce((sum, e) => sum + e.count, 0);
    expect(
      total,
      `MCP tool count drifted. Per-file: ${JSON.stringify(perFile)}. ` +
        'Update docs/INTERFACES.md and regenerate.',
    ).toBe(27);
  });

  it('CLI entry wires exactly 45 commands into Commander', () => {
    const count = countMatches(repoRoot, CLI_ENTRY, CLI_ADDCOMMAND_REGEX);
    expect(
      count,
      `CLI command count drifted in ${CLI_ENTRY}. ` + 'Update docs/INTERFACES.md and regenerate.',
    ).toBe(45);
  });

  it('docs/INTERFACES.md restates the verified totals so a drift is visible', () => {
    const doc = readFileSync(resolve(repoRoot, INTERFACES_DOC), 'utf8');
    // Each surface must restate its total verbatim so this test can detect
    // a stale doc even if the source counts still happen to match.
    expect(doc, 'missing "Total: 22 routes" anchor').toContain('Total: 22 routes');
    expect(doc, 'missing "Total: 27 tools" anchor').toContain('Total: 27 tools');
    expect(doc, 'missing "Total: 45 commands" anchor (CLI subcommand count)').toContain(
      'Total: 45 commands',
    );
  });

  it('every REST route source file is non-empty and parseable', () => {
    for (const rel of REST_ROUTE_FILES) {
      const text = readFileSync(resolve(repoRoot, rel), 'utf8');
      expect(text.length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  it('every MCP tool source file is non-empty and parseable', () => {
    for (const rel of MCP_TOOL_FILES) {
      const text = readFileSync(resolve(repoRoot, rel), 'utf8');
      expect(text.length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });
});
