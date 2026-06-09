import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestApp, type App } from '../../index.js';
import { createMcpServer } from '../server.js';
import { createModelPolicyService } from '../../services/model-policy.service.js';

/**
 * Regression test for task #260: detect drift between the actual MCP tool
 * registrations in `src/mcp/server.ts` (and sibling registration files) and
 * the published tool-count claims in README.md, docs/MCP.md, docs/SETUP.md,
 * and any count comments inside `src/mcp/server.ts` itself.
 *
 * Task #214 fixed a similar drift once (to 21). This test exists so future
 * tool additions/removals are caught the moment one of the docs falls out of
 * sync with the source of truth.
 *
 * Strategy:
 *   - Authoritative count = number of tools returned by the in-memory MCP
 *     server's listTools() response. This catches both registration-call
 *     additions and any SDK-level dedup/filtering that a static count would
 *     miss.
 *   - Cross-check the listTools count against a static count of
 *     `server.registerTool(` call sites under `src/mcp/tools/`.
 *   - For each public doc, extract every count claim of the form
 *     "<N> tools" / "<N> MCP tools" / "<N> tool" and assert N === actual.
 *   - Lines that explicitly describe the *remote* REST-backed subset (which
 *     intentionally exposes a different number of tools) are excluded.
 *   - Per-domain counts in docs/MCP.md (e.g. "### Task Tools (9 tools)") are
 *     additionally validated against per-file registerTool counts.
 */

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '../../../../');
const TOOLS_DIR = join(REPO_ROOT, 'src/mcp/tools');

const PUBLIC_DOCS: ReadonlyArray<string> = [
  'README.md',
  'docs/MCP.md',
  'docs/SETUP.md',
  // Also guard the doc-comment inside server.ts itself.
  'src/mcp/server.ts',
];

// Domain name (as it appears in MCP.md headings) -> registration file basename.
const DOMAIN_TO_FILE: Record<string, string> = {
  Task: 'task-tools.ts',
  Project: 'project-tools.ts',
  Comment: 'comment-tools.ts',
  Dependency: 'dependency-tools.ts',
  Health: 'health-tools.ts',
  Topology: 'topology-tools.ts',
  Wait: 'wait-for-unblock-tools.ts',
  WSJF: 'wsjf-tools.ts',
  Model: 'model-tools.ts',
};

/** Lines that mention the *remote* MCP server's tool count are intentionally
 *  different from the local count and must not trigger this drift test. */
const REMOTE_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [/remote/i, /rest-backed/i, /\bsubset\b/i];

function countRegisterToolCalls(filePath: string): number {
  const src = readFileSync(filePath, 'utf-8');
  return (src.match(/server\.registerTool\(/g) ?? []).length;
}

function staticToolCountFromTree(): number {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
  return files.reduce((acc, f) => acc + countRegisterToolCalls(join(TOOLS_DIR, f)), 0);
}

interface CountClaim {
  file: string;
  line: number;
  text: string;
  claimedCount: number;
  /** A label describing what the claim is about, e.g. "total" or "Task". */
  scope: string;
}

/** Find earliest match index across an array of patterns; Infinity if none. */
function earliestMatchIndex(line: string, patterns: ReadonlyArray<RegExp>): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const p of patterns) {
    const m = line.match(p);
    if (m && typeof m.index === 'number' && m.index < earliest) {
      earliest = m.index;
    }
  }
  return earliest;
}

/** Return every count from "<N> [MCP] tool(s)" occurrences within `text`. */
function findClaimedCounts(text: string): number[] {
  const counts: number[] = [];
  const matches = text.matchAll(/\b(\d+)\s+(?:MCP\s+)?tools?\b/gi);
  for (const m of matches) {
    counts.push(Number(m[1]));
  }
  return counts;
}

/**
 * Extract every count claim of the form "<N> [MCP] tool(s)" from `content`.
 * Lines matching any REMOTE_CONTEXT_PATTERNS are partially skipped (only the
 * prefix before the remote keyword is scanned for total-count claims).
 *
 * For docs/MCP.md, headings like "### Task Tools (9 tools)" are tagged with
 * the matching domain so we can cross-check the per-file count.
 */
function extractCountClaims(relPath: string, content: string): CountClaim[] {
  const claims: CountClaim[] = [];
  const lines = content.split('\n');

  // Domain heading: "### <Name> Tools (<N> tools)" or "(<N> tool)".
  const domainHeadingRe = /^#{1,6}\s+([A-Z][A-Za-z]+)\s+Tools\s+\((\d+)\s+tools?\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const domainMatch = line.match(domainHeadingRe);
    if (domainMatch) {
      claims.push({
        file: relPath,
        line: lineNum,
        text: line.trim(),
        claimedCount: Number(domainMatch[2]),
        scope: domainMatch[1],
      });
      continue;
    }

    const remoteIdx = earliestMatchIndex(line, REMOTE_CONTEXT_PATTERNS);
    const scanText = isFinite(remoteIdx) ? line.slice(0, remoteIdx) : line;

    for (const claimedCount of findClaimedCounts(scanText)) {
      claims.push({
        file: relPath,
        line: lineNum,
        text: line.trim(),
        claimedCount,
        scope: 'total',
      });
    }
  }

  return claims;
}

describe('MCP tool-count drift regression (task #260)', () => {
  let app: App;
  let actualToolCount = 0;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let client: Client;

  beforeAll(async () => {
    app = await createTestApp();
    // Configurable Task Models Task 11 (#920): pass the three model services so
    // the four model tools (list_models, resolve_model, get/set_model_defaults)
    // actually register at runtime — keeping runtime listTools count equal to
    // the static registerTool count. The catalog + settings services come from
    // the app; the resolver is built over a fake-but-typed dep bundle (this test
    // never invokes the tools, only counts them).
    const modelPolicyService = createModelPolicyService({
      getProjectPolicy: () => null,
      getGlobalPolicy: () => null,
      getJobSize: () => null,
    });
    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      undefined,
      app.topologyService,
      app.modelCatalogService,
      modelPolicyService,
      app.settingsService,
    );
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'tool-count-drift-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    actualToolCount = listed.tools.length;
  });

  afterAll(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  it('runtime listTools count matches static registerTool call count', () => {
    const staticCount = staticToolCountFromTree();
    expect(
      actualToolCount,
      `MCP runtime exposed ${actualToolCount} tools but src/mcp/tools/*.ts ` +
        `contains ${staticCount} server.registerTool(...) call sites. ` +
        `One side is out of sync.`,
    ).toBe(staticCount);
  });

  it('every public doc agrees with the source-of-truth tool count', () => {
    const mismatches: string[] = [];

    for (const docRel of PUBLIC_DOCS) {
      const abs = join(REPO_ROOT, docRel);
      const content = readFileSync(abs, 'utf-8');
      const claims = extractCountClaims(docRel, content).filter((c) => c.scope === 'total');

      for (const claim of claims) {
        if (claim.claimedCount !== actualToolCount) {
          mismatches.push(
            `  ${claim.file}:${claim.line} claims "${claim.claimedCount} tools" ` +
              `but source of truth is ${actualToolCount} tools.\n` +
              `    > ${claim.text}`,
          );
        }
      }
    }

    expect(
      mismatches,
      `Public-doc tool-count drift detected (source of truth = ${actualToolCount} tools):\n${mismatches.join('\n')}`,
    ).toEqual([]);
  });

  it('per-domain counts in docs/MCP.md match per-file registerTool counts', () => {
    const mcpDocAbs = join(REPO_ROOT, 'docs/MCP.md');
    const content = readFileSync(mcpDocAbs, 'utf-8');
    const claims = extractCountClaims('docs/MCP.md', content).filter((c) => c.scope !== 'total');

    const mismatches: string[] = [];
    for (const claim of claims) {
      const file = DOMAIN_TO_FILE[claim.scope];
      if (!file) {
        // Unknown domain heading — flag so a new tool category cannot be
        // added without updating the test mapping.
        mismatches.push(
          `  docs/MCP.md:${claim.line} references unknown domain "${claim.scope}". ` +
            `Update DOMAIN_TO_FILE in tool-count-drift.test.ts.`,
        );
        continue;
      }
      const expected = countRegisterToolCalls(join(TOOLS_DIR, file));
      if (claim.claimedCount !== expected) {
        mismatches.push(
          `  docs/MCP.md:${claim.line} claims "${claim.scope} Tools (${claim.claimedCount} tools)" ` +
            `but src/mcp/tools/${file} has ${expected} server.registerTool(...) calls.\n` +
            `    > ${claim.text}`,
        );
      }
    }

    expect(mismatches, `Per-domain tool-count drift detected:\n${mismatches.join('\n')}`).toEqual(
      [],
    );
  });

  it('count-claim extractor ignores false positives like "21 days" / port "3000"', () => {
    // Self-test: the extractor must not flag plain numbers that are not
    // immediately followed by the word "tool".
    const sample = [
      'The server starts on port 3000 within 21 days.',
      'See v2.1 for details.',
      'Exposes 21 tools and 1 resource.', // <- this is the only real claim
      'A subset of 20 tools for remote use.', // <- skipped (remote context)
    ].join('\n');
    const claims = extractCountClaims('synthetic.md', sample);
    const totals = claims.filter((c) => c.scope === 'total');
    expect(totals).toHaveLength(1);
    expect(totals[0].claimedCount).toBe(21);
  });
});
