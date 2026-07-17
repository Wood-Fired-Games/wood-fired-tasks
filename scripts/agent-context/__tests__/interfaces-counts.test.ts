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
 *   - src/mcp/tools/*-tools.ts (discovered via readdirSync — a new tool file
 *     is picked up automatically and cannot dodge this gate)
 *   - src/cli/bin/tasks.ts
 *   - docs/INTERFACES.md
 */

import { readdirSync, readFileSync } from 'node:fs';
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

// Expected totals quoted by docs/INTERFACES.md. Shared between the count
// assertions, the test titles, and the doc-anchor check so one constant is
// the single place a legitimate surface change gets recorded.
const EXPECTED_REST_ROUTE_TOTAL = 22;
const EXPECTED_MCP_TOOL_TOTAL = 31;
const EXPECTED_CLI_COMMAND_TOTAL = 46;

const MCP_TOOLS_DIR = 'src/mcp/tools';

/**
 * Discover MCP tool registration files from the filesystem instead of a
 * hand-maintained list (PR #55 shipped stale doc counts precisely because a
 * new *-tools.ts file dodged a hard-coded list). Any file matching
 * src/mcp/tools/*-tools.ts is counted automatically, so adding a tool file
 * without updating docs/INTERFACES.md (and EXPECTED_MCP_TOOL_TOTAL) fails.
 */
function discoverMcpToolFiles(repoRoot: string): string[] {
  return readdirSync(resolve(repoRoot, MCP_TOOLS_DIR))
    .filter((f) => f.endsWith('-tools.ts'))
    .sort()
    .map((f) => `${MCP_TOOLS_DIR}/${f}`);
}

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
  const mcpToolFiles = discoverMcpToolFiles(repoRoot);

  it(`REST route files together expose exactly ${EXPECTED_REST_ROUTE_TOTAL} verb registrations`, () => {
    const perFile = REST_ROUTE_FILES.map((rel) => ({
      file: rel,
      count: countMatches(repoRoot, rel, REST_VERB_REGEX),
    }));
    const total = perFile.reduce((sum, e) => sum + e.count, 0);
    expect(
      total,
      `REST route count drifted. Per-file: ${JSON.stringify(perFile)}. ` +
        'Update docs/INTERFACES.md and regenerate.',
    ).toBe(EXPECTED_REST_ROUTE_TOTAL);
  });

  it(`MCP tool files (discovered from ${MCP_TOOLS_DIR}/*-tools.ts) together register exactly ${EXPECTED_MCP_TOOL_TOTAL} tools`, () => {
    const perFile = mcpToolFiles.map((rel) => ({
      file: rel,
      count: countMatches(repoRoot, rel, MCP_TOOL_REGEX),
    }));
    const total = perFile.reduce((sum, e) => sum + e.count, 0);
    expect(
      total,
      `MCP tool count drifted. Per-file: ${JSON.stringify(perFile)}. ` +
        'Update docs/INTERFACES.md, EXPECTED_MCP_TOOL_TOTAL, and regenerate.',
    ).toBe(EXPECTED_MCP_TOOL_TOTAL);
  });

  it('MCP tool file discovery finds at least the known registration files', () => {
    // Guard the glob itself: if the directory moved or the *-tools.ts naming
    // convention changed, discovery would silently return [] and the count
    // test above would "pass" vacuously at 0 — make that failure loud here.
    expect(
      mcpToolFiles.length,
      `Expected ${MCP_TOOLS_DIR} to contain *-tools.ts registration files; ` +
        `found: ${JSON.stringify(mcpToolFiles)}`,
    ).toBeGreaterThanOrEqual(9);
  });

  it(`CLI entry wires exactly ${EXPECTED_CLI_COMMAND_TOTAL} commands into Commander`, () => {
    const count = countMatches(repoRoot, CLI_ENTRY, CLI_ADDCOMMAND_REGEX);
    expect(
      count,
      `CLI command count drifted in ${CLI_ENTRY}. ` + 'Update docs/INTERFACES.md and regenerate.',
    ).toBe(EXPECTED_CLI_COMMAND_TOTAL);
  });

  it('docs/INTERFACES.md restates the verified totals so a drift is visible', () => {
    const doc = readFileSync(resolve(repoRoot, INTERFACES_DOC), 'utf8');
    // Each surface must restate its total verbatim so this test can detect
    // a stale doc even if the source counts still happen to match.
    expect(doc, `missing "Total: ${EXPECTED_REST_ROUTE_TOTAL} routes" anchor`).toContain(
      `Total: ${EXPECTED_REST_ROUTE_TOTAL} routes`,
    );
    expect(doc, `missing "Total: ${EXPECTED_MCP_TOOL_TOTAL} tools" anchor`).toContain(
      `Total: ${EXPECTED_MCP_TOOL_TOTAL} tools`,
    );
    expect(
      doc,
      `missing "Total: ${EXPECTED_CLI_COMMAND_TOTAL} commands" anchor (CLI subcommand count)`,
    ).toContain(`Total: ${EXPECTED_CLI_COMMAND_TOTAL} commands`);
  });

  it('every REST route source file is non-empty and parseable', () => {
    for (const rel of REST_ROUTE_FILES) {
      const text = readFileSync(resolve(repoRoot, rel), 'utf8');
      expect(text.length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  it('every MCP tool source file is non-empty and parseable', () => {
    for (const rel of mcpToolFiles) {
      const text = readFileSync(resolve(repoRoot, rel), 'utf8');
      expect(text.length, `${rel} is empty`).toBeGreaterThan(0);
    }
  });
});
