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
 *     src/api/routes/{tasks,projects,comments,dependencies}/index.ts (core
 *     CRUD subtotal — still a fixed list because it is a deliberately
 *     narrower subset than the full surface, see EXPECTED_REST_ROUTE_TOTAL)
 *   - every *.ts file recursively under src/api/routes/ (excluding
 *     __tests__ directories), discovered via a recursive readdirSync walk —
 *     a new route file (task #1601: routes/tasks/wsjf.ts, routes/projects/
 *     wsjf.ts, routes/models/, routes/settings/, routes/auth/, etc. all used
 *     to dodge this gate) is picked up automatically and cannot dodge the
 *     full-surface total below
 *   - src/mcp/tools/*-tools.ts (discovered via readdirSync — a new tool file
 *     is picked up automatically and cannot dodge this gate)
 *   - src/mcp/remote/register-tools.ts (harvested at runtime by stubbing
 *     McpServer.registerTool, the same approach
 *     src/mcp/__tests__/stdio-remote-parity.test.ts uses to harvest the
 *     remote tool surface) for the remote-tool-count anchor
 *   - src/cli/bin/tasks.ts
 *   - docs/INTERFACES.md
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findRepoRoot } from '../manifest.js';
import { registerRemoteTools } from '../../../src/mcp/remote/register-tools.js';
import type { RestClient } from '../../../src/mcp/remote/rest-client.js';

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
const EXPECTED_REST_ROUTE_FULL_TOTAL = 59;
const EXPECTED_MCP_TOOL_TOTAL = 31;
const EXPECTED_CLI_COMMAND_TOTAL = 46;

const MCP_TOOLS_DIR = 'src/mcp/tools';
const REST_ROUTES_DIR = 'src/api/routes';

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

/**
 * Recursively discover every REST route source file under src/api/routes/
 * (task #1601: replaces the hard-coded 6-file REST_ROUTE_FILES list for the
 * full-surface total, so routes/tasks/wsjf.ts, routes/projects/wsjf.ts,
 * routes/models/, routes/settings/, routes/auth/, routes/me/, routes/web/
 * — and any future route file — are counted automatically). `__tests__`
 * directories are excluded; every other *.ts file is included, mirroring
 * the "excluding __tests__" scope docs/INTERFACES.md's full-surface line
 * already claims.
 */
function discoverRouteFiles(repoRoot: string): string[] {
  const results: string[] = [];
  function walk(relDir: string): void {
    const absDir = resolve(repoRoot, relDir);
    for (const entry of readdirSync(absDir)) {
      if (entry === '__tests__') continue;
      const relPath = `${relDir}/${entry}`;
      const absPath = resolve(repoRoot, relPath);
      if (statSync(absPath).isDirectory()) {
        walk(relPath);
      } else if (entry.endsWith('.ts')) {
        results.push(relPath);
      }
    }
  }
  walk(REST_ROUTES_DIR);
  return results.sort();
}

/**
 * Harvest the remote MCP tool surface the same way
 * src/mcp/__tests__/stdio-remote-parity.test.ts does: stub
 * `McpServer.registerTool` (here via a minimal object stub, since
 * registerRemoteTools only calls `.registerTool(name, ...)`) and boot the
 * real `registerRemoteTools(...)` registrar so a new/removed remote tool
 * cannot dodge the count.
 */
function harvestRemoteToolNames(): string[] {
  const names: string[] = [];
  const stub = {
    registerTool: (name: string) => {
      names.push(name);
      return { name };
    },
  };
  const mockRestClient = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('remote tool handlers are never invoked during count harvesting');
      },
    },
  );
  registerRemoteTools(
    stub as unknown as Parameters<typeof registerRemoteTools>[0],
    mockRestClient as unknown as RestClient,
  );
  return names;
}

const CLI_ENTRY = 'src/cli/bin/tasks.ts';
const INTERFACES_DOC = 'docs/INTERFACES.md';

// Anchored at line start (after optional whitespace) so we don't match
// occurrences inside comments or strings further down the line.
const REST_VERB_REGEX = /^\s*(?:fastify|server)\.(?:get|post|put|patch|delete)\(/gm;
const MCP_TOOL_REGEX = /registerTool/g;
const CLI_ADDCOMMAND_REGEX = /^\s*program\.addCommand\(/gm;
const REST_BACKED_TOOLS_REGEX = /(\d+)\s+REST-backed tools/g;

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
  const routeFiles = discoverRouteFiles(repoRoot);

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

  it(`REST route files (discovered recursively under ${REST_ROUTES_DIR}/, excluding __tests__) together expose exactly ${EXPECTED_REST_ROUTE_FULL_TOTAL} verb registrations`, () => {
    // task #1601: this is the full-surface guard — routes/tasks/wsjf.ts,
    // routes/projects/wsjf.ts, routes/models/, routes/settings/,
    // routes/auth/, routes/me/, routes/web/, and any future route file are
    // all in scope because discoverRouteFiles walks the tree instead of
    // reading a hard-coded list.
    const perFile = routeFiles
      .map((rel) => ({ file: rel, count: countMatches(repoRoot, rel, REST_VERB_REGEX) }))
      .filter((e) => e.count > 0);
    const total = perFile.reduce((sum, e) => sum + e.count, 0);
    expect(
      total,
      `Full-surface REST route count drifted. Per-file: ${JSON.stringify(perFile)}. ` +
        'Update docs/INTERFACES.md ("Full surface — Total: N route handlers") and ' +
        'EXPECTED_REST_ROUTE_FULL_TOTAL in this test.',
    ).toBe(EXPECTED_REST_ROUTE_FULL_TOTAL);
  });

  it('REST route file discovery finds at least the known route files', () => {
    // Guard the walk itself: if src/api/routes/ moved or emptied out,
    // discovery would silently return [] and the full-surface count test
    // above would "pass" vacuously at 0 — make that failure loud here.
    expect(
      routeFiles.length,
      `Expected ${REST_ROUTES_DIR}/ to contain route source files (recursively); ` +
        `found: ${JSON.stringify(routeFiles)}`,
    ).toBeGreaterThanOrEqual(REST_ROUTE_FILES.length);
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

  it(`remote MCP server (src/mcp/remote/register-tools.ts) registers exactly ${EXPECTED_MCP_TOOL_TOTAL} REST-backed tools`, () => {
    // task #1601: remote-tool-count anchor. Harvested at runtime (not a
    // static grep) the same way stdio-remote-parity.test.ts's
    // harvestRemoteToolNames() does, so a tool added to/removed from the
    // remote registrar without a matching stdio tool (or vice versa) is
    // caught here as a count drift even if the parity test's set-membership
    // check would otherwise stay green.
    const remoteToolNames = harvestRemoteToolNames();
    expect(
      remoteToolNames.length,
      `Remote MCP tool count drifted. Harvested: ${JSON.stringify(remoteToolNames)}. ` +
        'Update docs/INTERFACES.md ("N REST-backed tools", both mentions) and ' +
        'EXPECTED_MCP_TOOL_TOTAL in this test.',
    ).toBe(EXPECTED_MCP_TOOL_TOTAL);
  });

  it('docs/INTERFACES.md restates the verified totals so a drift is visible', () => {
    const doc = readFileSync(resolve(repoRoot, INTERFACES_DOC), 'utf8');
    // Each surface must restate its total verbatim so this test can detect
    // a stale doc even if the source counts still happen to match.
    expect(doc, `missing "Total: ${EXPECTED_REST_ROUTE_TOTAL} routes" anchor`).toContain(
      `Total: ${EXPECTED_REST_ROUTE_TOTAL} routes`,
    );
    expect(
      doc,
      `missing "Total: ${EXPECTED_REST_ROUTE_FULL_TOTAL} route handlers" anchor`,
    ).toContain(`Total: ${EXPECTED_REST_ROUTE_FULL_TOTAL} route handlers`);
    expect(doc, `missing "Total: ${EXPECTED_MCP_TOOL_TOTAL} tools" anchor`).toContain(
      `Total: ${EXPECTED_MCP_TOOL_TOTAL} tools`,
    );
    expect(
      doc,
      `missing "Total: ${EXPECTED_CLI_COMMAND_TOTAL} commands" anchor (CLI subcommand count)`,
    ).toContain(`Total: ${EXPECTED_CLI_COMMAND_TOTAL} commands`);
  });

  it(`every "N REST-backed tools" mention in docs/INTERFACES.md agrees with the harvested remote tool count (${EXPECTED_MCP_TOOL_TOTAL})`, () => {
    // task #1601: docs/INTERFACES.md:359 used to say "27 REST-backed tools"
    // while :170 said "31 REST-backed tools" — no test asserted the two
    // mentions agreed with each other or with source. Extract every
    // occurrence and require every one to match the harvested count.
    const doc = readFileSync(resolve(repoRoot, INTERFACES_DOC), 'utf8');
    const matches = [...doc.matchAll(REST_BACKED_TOOLS_REGEX)].map((m) => Number(m[1]));
    expect(
      matches.length,
      `Expected at least one "N REST-backed tools" mention in ${INTERFACES_DOC}; found none.`,
    ).toBeGreaterThanOrEqual(1);
    for (const claimed of matches) {
      expect(
        claimed,
        `${INTERFACES_DOC} claims "${claimed} REST-backed tools" but the harvested remote ` +
          `tool count is ${EXPECTED_MCP_TOOL_TOTAL}.`,
      ).toBe(EXPECTED_MCP_TOOL_TOTAL);
    }
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
