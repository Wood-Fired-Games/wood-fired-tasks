import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestApp, type App } from '../../index.js';
import { createMcpServer } from '../server.js';
import { createModelPolicyService } from '../../services/model-policy.service.js';
import { SCM_VERBS } from '../../scm/types.js';

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
const SCM_DIR = join(REPO_ROOT, 'src/scm');
const SCM_CLI_DISPATCHER = join(REPO_ROOT, 'src/cli/commands/scm.ts');
const SCM_DOC = join(REPO_ROOT, 'docs/SCM.md');

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

/**
 * Extract the number of data rows in docs/SCM.md's "Adapter verbs" table
 * (§ `## Adapter verbs — \`tasks scm <verb>\``). Header and separator rows
 * are excluded; a data row is any table row whose first cell is a
 * backtick-quoted verb, e.g. "| `detect` | ... |".
 */
function extractScmVerbTableRowCount(content: string): number {
  const lines = content.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+Adapter verbs/.test(l));
  if (headingIdx === -1) {
    throw new Error('docs/SCM.md is missing the "## Adapter verbs" heading.');
  }
  let sawHeader = false;
  let count = 0;
  for (let i = headingIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!sawHeader) {
      if (/^\|\s*Verb\s*\|/.test(line)) sawHeader = true;
      continue;
    }
    if (/^\|\s*-+\s*\|/.test(line)) continue; // markdown separator row
    if (/^\|\s*`[^`]+`\s*\|/.test(line)) {
      count++;
      continue;
    }
    if (count > 0) break; // table ended
  }
  return count;
}

/** Relative-import module basenames (`./foo.js` -> `foo`) referenced by a src/scm/*.ts file. */
function localScmImports(filePath: string): string[] {
  const src = readFileSync(filePath, 'utf-8');
  const names: string[] = [];
  for (const m of src.matchAll(/from\s+'\.\/([a-zA-Z0-9_-]+)\.js'/g)) {
    names.push(m[1]);
  }
  return names;
}

/** src/scm module basenames imported (via `../../scm/foo.js`) by the CLI dispatcher. */
function dispatcherScmImports(): string[] {
  const src = readFileSync(SCM_CLI_DISPATCHER, 'utf-8');
  const names: string[] = [];
  for (const m of src.matchAll(/from\s+'\.\.\/\.\.\/scm\/([a-zA-Z0-9_-]+)\.js'/g)) {
    names.push(m[1]);
  }
  return names;
}

/**
 * BFS the import graph starting at src/cli/commands/scm.ts, following
 * relative imports within src/scm/*.ts, and return the reached module
 * basenames. A module on disk that is never reached (new file forgotten
 * during wiring, or dead code) fails the completeness assert below.
 */
function reachableScmModulesFromDispatcher(): Set<string> {
  const reached = new Set<string>();
  const queue = [...dispatcherScmImports()];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    const modPath = join(SCM_DIR, `${name}.ts`);
    if (!existsSync(modPath)) continue;
    queue.push(...localScmImports(modPath));
  }
  return reached;
}

describe('SCM surface drift guard (task #1568)', () => {
  it('docs/SCM.md "Adapter verbs" table row count matches SCM_VERBS.length', () => {
    const content = readFileSync(SCM_DOC, 'utf-8');
    const rowCount = extractScmVerbTableRowCount(content);
    expect(
      rowCount,
      `docs/SCM.md's "Adapter verbs" table has ${rowCount} data rows but ` +
        `SCM_VERBS (src/scm/types.ts) has ${SCM_VERBS.length} entries: ` +
        `[${SCM_VERBS.join(', ')}]. Keep the table and SCM_VERBS in lockstep.`,
    ).toBe(SCM_VERBS.length);
  });

  it('every src/scm/*.ts module (excluding __tests__) is reachable from the CLI dispatcher import graph', () => {
    // Dynamic directory scan (not a hard-coded file list) so a new module
    // that isn't wired into the dispatcher's import graph cannot dodge this
    // guard — the drift class documented in PR #55 / task #1568.
    const filesOnDisk = readdirSync(SCM_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    const reached = Array.from(reachableScmModulesFromDispatcher()).sort();
    expect(
      reached,
      `src/scm/*.ts on disk: [${filesOnDisk.join(', ')}]\n` +
        `reachable from src/cli/commands/scm.ts's import graph: [${reached.join(', ')}]\n` +
        'A module exists on disk but is not imported (directly or transitively) by the ' +
        'CLI dispatcher — either wire it in or update this test if it is intentionally unused.',
    ).toEqual(filesOnDisk);
  });
});

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
      getProject: () => ({ model_policy: null }),
      getGlobalPolicy: () => null,
      getTask: () => null,
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

  it('DOMAIN_TO_FILE covers every src/mcp/tools/*-tools.ts file (completeness)', () => {
    // DOMAIN_TO_FILE must stay a map (the doc-heading domain names cannot be
    // derived from filenames), so guard it with a completeness assert instead:
    // a NEW *-tools.ts registration file that is not added to the map — and
    // therefore not cross-checked against a docs/MCP.md heading — fails here.
    const filesOnDisk = readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('-tools.ts'))
      .sort();
    const filesInMap = Object.values(DOMAIN_TO_FILE).sort();
    expect(
      filesInMap,
      'DOMAIN_TO_FILE is out of sync with src/mcp/tools/*-tools.ts. ' +
        'Add the new registration file (with its docs/MCP.md domain heading) to ' +
        'DOMAIN_TO_FILE in tool-count-drift.test.ts, or remove the stale entry.',
    ).toEqual(filesOnDisk);
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
