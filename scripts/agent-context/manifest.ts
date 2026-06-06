/**
 * Authoritative source for the `.agent-context.json` machine manifest.
 *
 * The JSON file at the repo root is GENERATED from this module by
 * `scripts/agent-context/generate.ts`. Humans edit this file, not the JSON.
 *
 * Contract reference: `docs/AGENT_CONTEXT.md` sections 2 (canonical files),
 * 3 (authority taxonomy), 4 (size budgets), 5 (freshness/ownership).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1';
export const GENERATOR_PATH = 'scripts/agent-context/generate.ts';
export const MANIFEST_PATH = '.agent-context.json';

// ~4 chars per token, per the contract.
export const CHARS_PER_TOKEN = 4;
// Average characters per line used to derive an approximate token budget from
// a line budget. 80 is a generous upper bound for prose-heavy markdown.
export const CHARS_PER_LINE = 80;

/**
 * Convert a line count to an approximate token count using the same
 * heuristic used to derive `approx_token_budget` from `line_budget`.
 * Kept in one place so `check.ts` failure messages and the manifest's
 * `approx_token_budget` field stay in lockstep.
 */
export function approxTokensForLines(lineCount: number): number {
  return Math.round((lineCount * CHARS_PER_LINE) / CHARS_PER_TOKEN);
}

// Files which are agent-facing but for historical reasons do not carry an
// `Owner:` line in their first three lines. These are skipped from the
// owner-line check but still subject to the file-exists and budget checks.
//
// The contract (docs/AGENT_CONTEXT.md section 5.1) requires every
// authoritative file to start with an `Owner:` line. The files below are
// grandfathered in until a follow-up tightening pass adds the line to each
// doc; they remain agent-facing and authoritative.
const OWNER_LINE_EXEMPT = new Set<string>([
  // Front-door / policy docs — never carried an Owner: line.
  'README.md',
  'SECURITY.md',
  // Deep docs that pre-date the contract. Adding `Owner:` to these requires
  // touching files outside this task's scope; flagged for a follow-up.
  'docs/API.md',
  'docs/MCP.md',
  'docs/CLI.md',
  'docs/SETUP.md',
  'docs/SLACK.md',
  'docs/RELEASE.md',
  'docs/CODE_QUALITY_ROADMAP.md',
  'CONTRIBUTING.md',
  // Adapter files (authority: 'adapter') intentionally carry no Owner: line.
  // They are thin pointers to the canonical entry (AGENTS.md), not
  // authoritative docs that own a topic; ownership semantics belong to the
  // canonical files they point at. The adapter-link check in check.ts
  // independently enforces that every adapter resolves to AGENTS.md.
  'CLAUDE.md',
  'llms.txt',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Authority = 'authoritative' | 'generated' | 'adapter';
export type FileStatus = 'present' | 'reserved';
export type WhenToRead = 'first' | 'second' | 'on-demand' | 'generated-index' | 'reference';

export interface ManifestSourceEntry {
  path: string;
  role: string;
  purpose: string;
  when_to_read: WhenToRead;
  line_budget: number;
  authority: Authority;
  owner_role: string;
  status: FileStatus;
  notes?: string;
}

export interface ManifestFileEntry extends ManifestSourceEntry {
  approx_token_budget: number;
  actual_lines?: number;
  actual_owner?: string;
  sha256?: string;
}

export interface ManifestGenerated {
  by: string;
  generated_at: string;
  do_not_edit: string;
}

export interface ManifestProject {
  name: string;
  contract: string;
  first_read: string;
}

export interface AgentContextManifest {
  $schema_version: string;
  _generated: ManifestGenerated;
  project: ManifestProject;
  files: ManifestFileEntry[];
  groups: Record<string, string[]>;
  custom_fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Manifest source — authoritative table of canonical files
// ---------------------------------------------------------------------------

export const MANIFEST_SOURCE: readonly ManifestSourceEntry[] = [
  {
    path: 'AGENTS.md',
    role: 'navigation-hub',
    purpose:
      'First-read navigation file. Vendor-neutral entry point that points at every deeper doc.',
    when_to_read: 'first',
    line_budget: 150,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/AGENT_CONTEXT.md',
    role: 'contract',
    purpose:
      'Authoritative contract describing which agent-facing files exist, their budgets, owners, and freshness rules.',
    when_to_read: 'second',
    line_budget: 400,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/REPO_MAP.md',
    role: 'repo-map',
    purpose:
      'Compact tree of `src/`, `docs/`, `scripts/` with one-line ownership per top-level directory.',
    when_to_read: 'second',
    line_budget: 250,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/ARCHITECTURE.md',
    role: 'architecture-one-pager',
    purpose:
      'System one-pager: data flow across API, MCP, CLI, Slack, DB. Boundaries, not internals.',
    when_to_read: 'second',
    // Bumped 300 -> 350 by the milestone-close audit (#286). The doc landed at
    // exactly 300/300, leaving no room for any subsequent edit; 50 lines of
    // headroom lets the freshness rule (#281) stay useful without forcing a
    // split today. Tighten back to 300 once a future task trims the doc.
    line_budget: 350,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/WORKFLOWS.md',
    role: 'workflows',
    purpose: 'Canonical build, test, lint, migrate, run, and smoke command recipes.',
    when_to_read: 'second',
    line_budget: 250,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/INTERFACES.md',
    role: 'interfaces-index',
    purpose:
      'Compact source-verified index of REST routes, MCP tools, and CLI subcommands with file pointers.',
    when_to_read: 'generated-index',
    line_budget: 400,
    authority: 'generated',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes:
      'Hand-authored today; counts drift-checked by scripts/agent-context/__tests__/interfaces-counts.test.ts. A future task may swap to a true generator.',
  },
  {
    path: 'docs/NAVIGATION.md',
    role: 'navigation-index',
    purpose: 'Task-oriented index: "if you want to do X, read these files in this order."',
    when_to_read: 'on-demand',
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/API.md',
    role: 'deep-doc',
    purpose: 'Authoritative REST API reference.',
    when_to_read: 'on-demand',
    line_budget: 1500,
    authority: 'authoritative',
    owner_role: 'API maintainers',
    status: 'present',
    notes: 'Advisory budget — currently exceeds the contract target; tighten in a follow-up.',
  },
  {
    path: 'docs/MCP.md',
    role: 'deep-doc',
    purpose: 'Authoritative MCP tool reference.',
    when_to_read: 'on-demand',
    line_budget: 1500,
    authority: 'authoritative',
    owner_role: 'MCP maintainers',
    status: 'present',
    notes: 'Advisory budget — tighten in a follow-up.',
  },
  {
    path: 'docs/CLI.md',
    role: 'deep-doc',
    purpose: 'Authoritative CLI reference for the `tasks` binary.',
    when_to_read: 'on-demand',
    line_budget: 1500,
    authority: 'authoritative',
    owner_role: 'CLI maintainers',
    status: 'present',
    notes: 'Advisory budget — tighten in a follow-up.',
  },
  {
    path: 'docs/SETUP.md',
    role: 'deep-doc',
    purpose: 'Local setup, install, environment variables.',
    when_to_read: 'on-demand',
    line_budget: 1500,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes: 'Advisory budget — tighten in a follow-up.',
  },
  {
    path: 'docs/SLACK.md',
    role: 'deep-doc',
    purpose: 'Slack surface reference.',
    when_to_read: 'on-demand',
    line_budget: 800,
    authority: 'authoritative',
    owner_role: 'Slack maintainers',
    status: 'present',
  },
  {
    path: 'docs/RELEASE.md',
    role: 'deep-doc',
    purpose: 'Release process and pre-publish checks.',
    when_to_read: 'on-demand',
    line_budget: 600,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/TROUBLESHOOTING.md',
    role: 'runbook',
    purpose:
      'Operator symptom→cause→fix recovery runbook: service boot failures (OIDC / network-online ordering), wrong or stale database via the local MCP variant, and how to identify the live DB and back up / restore safely.',
    when_to_read: 'on-demand',
    line_budget: 250,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/CODE_QUALITY_ROADMAP.md',
    role: 'deep-doc',
    purpose: 'Code quality roadmap and current baseline.',
    when_to_read: 'on-demand',
    line_budget: 1500,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes: 'Advisory budget — tighten in a follow-up.',
  },
  {
    path: 'docs/verifier-contract.md',
    role: 'deep-doc',
    purpose:
      'Wave 2.1 tasks-verifier subagent contract: inputs, outputs, verdict rollup, evidence format, tool allow/denylists, bounds.',
    when_to_read: 'on-demand',
    line_budget: 400,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/RELIABILITY.md',
    role: 'deep-doc',
    purpose:
      'Loop evidence anti-fabrication guardrails (task #608): the motivating 2026-05-31 incident, the three defense-in-depth layers (WFT_STRICT_EVIDENCE server gate, client-side validate-sha hook, loop skill discipline), and an honest statement of what they do and do NOT guarantee.',
    when_to_read: 'on-demand',
    line_budget: 200,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/tasks-decompose-design.md',
    role: 'deep-doc',
    purpose:
      'Wave 5 (#320) /tasks:decompose design spec: contract, 9-step methodology, four guardrails, DECOMPOSITION.md artifact schema, verification-fixture sketches, and cost budget. /tasks:decompose is OPERATIONAL — the runtime ships at skills/tasks/decompose.md; this doc is the design-of-record.',
    when_to_read: 'on-demand',
    line_budget: 500,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes:
      'Design spec — single landing doc for the OPERATIONAL /tasks:decompose pipeline. 500-line budget allows the 9-step + 4-guardrail + schema + 4-fixture-sketch detail with modest headroom; tighten in a follow-up if/when content peels out into adjacent files.',
  },
  {
    path: 'docs/automation-recipes/claude-routines.md',
    role: 'deep-doc',
    purpose:
      'Automation recipe: dispatch a routine on task close via the vendor-neutral agent_session_dispatch + shell_exec core handlers, with a validating sample triggers.yaml and the adapter-contract shape.',
    when_to_read: 'on-demand',
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/automation-recipes/persistent-agent-sessions.md',
    role: 'deep-doc',
    purpose:
      'Automation recipe: drive a long-lived agent session via the vendor-neutral agent_session_dispatch core handler, covering the session-id round-trip, restart semantics, and idempotency-store interactions, with a validating sample triggers.yaml.',
    when_to_read: 'on-demand',
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/ONBOARDING_SMOKE.md',
    role: 'onboarding-smoke',
    purpose:
      'Agent onboarding smoke test: seven probe scenarios that prove a fresh agent can navigate the repo from committed context alone.',
    when_to_read: 'on-demand',
    line_budget: 200,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/README.md',
    role: 'docs-index',
    purpose:
      'Docs directory index grouping the agent, surface, setup, and quality docs by audience.',
    when_to_read: 'on-demand',
    line_budget: 90,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'packages/wft-router/README.md',
    role: 'package-readme',
    purpose:
      'Sub-package README for the wft-router event-router daemon — handlers, run flags, config (triggers.example.yaml), and pointers to recipes/adapters/deploy assets. Points at docs/event-router-design.md as the design-of-record.',
    when_to_read: 'on-demand',
    line_budget: 95,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'CONTRIBUTING.md',
    role: 'human-onboarding',
    purpose: 'Human contributor workflow, commit and PR rules.',
    when_to_read: 'on-demand',
    line_budget: 600,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'README.md',
    role: 'project-front-door',
    purpose: 'Product-level overview, install, quickstart.',
    when_to_read: 'reference',
    line_budget: 850,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes: 'Owner line check exempt — front-door doc, not agent-facing primary.',
  },
  {
    path: 'SECURITY.md',
    role: 'security-policy',
    purpose: 'Security policy and vulnerability reporting.',
    when_to_read: 'reference',
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes: 'Owner line check exempt — policy doc, not agent-facing primary.',
  },
  {
    path: 'llms.txt',
    role: 'llms-txt-adapter',
    purpose:
      'Community llms.txt site-map convention — flat, link-rich pointer to the canonical agent docs. Adapter only; no unique facts.',
    when_to_read: 'on-demand',
    line_budget: 60,
    authority: 'adapter',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes:
      'Adapter file. Owner line check exempt. Must link to AGENTS.md — enforced by check.ts adapter-link check.',
  },
  {
    path: 'CLAUDE.md',
    role: 'claude-adapter',
    purpose:
      "Thin pointer for Claude Code's automatic root-file pickup. Routes Claude users to AGENTS.md. Adapter only; no unique facts.",
    when_to_read: 'on-demand',
    line_budget: 30,
    authority: 'adapter',
    owner_role: 'Repository maintainers',
    status: 'present',
    notes:
      'Adapter file. Owner line check exempt. Must link to AGENTS.md — enforced by check.ts adapter-link check.',
  },
];

// ---------------------------------------------------------------------------
// Task-oriented groups
// ---------------------------------------------------------------------------

export const MANIFEST_GROUPS: Record<string, readonly string[]> = {
  'api-change': [
    'AGENTS.md',
    'docs/AGENT_CONTEXT.md',
    'docs/API.md',
    'docs/REPO_MAP.md',
    'docs/INTERFACES.md',
  ],
  'mcp-tool-change': ['AGENTS.md', 'docs/MCP.md', 'docs/REPO_MAP.md', 'docs/INTERFACES.md'],
  'cli-change': ['AGENTS.md', 'docs/CLI.md', 'docs/REPO_MAP.md', 'docs/INTERFACES.md'],
  'db-migration': ['AGENTS.md', 'docs/REPO_MAP.md', 'docs/SETUP.md', 'docs/ARCHITECTURE.md'],
  'schema-change': ['AGENTS.md', 'docs/REPO_MAP.md', 'docs/API.md', 'docs/INTERFACES.md'],
  'slack-change': ['AGENTS.md', 'docs/SLACK.md', 'docs/REPO_MAP.md'],
  'docs-only': ['AGENTS.md', 'docs/AGENT_CONTEXT.md', 'CONTRIBUTING.md'],
  release: ['AGENTS.md', 'docs/RELEASE.md', 'CONTRIBUTING.md'],
  'test-fix': ['AGENTS.md', 'docs/REPO_MAP.md', 'CONTRIBUTING.md'],
  'security-sensitive': ['AGENTS.md', 'SECURITY.md', 'docs/SETUP.md', 'docs/REPO_MAP.md'],
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(cur, 'package.json'))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(`findRepoRoot: could not locate package.json starting from ${here}`);
}

interface ReadFileFacts {
  lineCount: number;
  ownerLine?: string;
  sha256: string;
}

function readFileFacts(absPath: string): ReadFileFacts {
  const bytes = readFileSync(absPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8');
  let lineCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++;
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) {
    lineCount++;
  }
  const firstLines = text.split('\n', 5);
  let ownerLine: string | undefined;
  for (let i = 0; i < Math.min(firstLines.length, 3); i++) {
    const m = /^Owner:\s*(.+?)\s*$/.exec(firstLines[i] ?? '');
    if (m) {
      ownerLine = m[1];
      break;
    }
  }
  return { lineCount, ownerLine, sha256 };
}

export function buildManifest(
  options: { generatedAt?: string; repoRoot?: string } = {},
): AgentContextManifest {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const files: ManifestFileEntry[] = MANIFEST_SOURCE.map((entry) => {
    const approxTokenBudget = approxTokensForLines(entry.line_budget);
    const out: ManifestFileEntry = {
      ...entry,
      approx_token_budget: approxTokenBudget,
    };
    if (entry.status === 'present') {
      const abs = resolve(repoRoot, entry.path);
      if (!existsSync(abs)) {
        return out;
      }
      const facts = readFileFacts(abs);
      out.actual_lines = facts.lineCount;
      out.sha256 = facts.sha256;
      if (facts.ownerLine !== undefined) {
        out.actual_owner = facts.ownerLine;
      }
    }
    return out;
  });

  const groups: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(MANIFEST_GROUPS)) {
    groups[key] = [...value];
  }

  return {
    $schema_version: SCHEMA_VERSION,
    _generated: {
      by: GENERATOR_PATH,
      generated_at: generatedAt,
      do_not_edit:
        'Regenerate with `npm run agent-context:gen` after changing scripts/agent-context/manifest.ts.',
    },
    project: {
      name: 'wood-fired-tasks',
      contract: 'docs/AGENT_CONTEXT.md',
      first_read: 'AGENTS.md',
    },
    files,
    groups,
    custom_fields: {
      status:
        "Either 'present' (file exists on disk) or 'reserved' (canonical slot defined by the contract but not yet committed).",
      owner_role:
        'Short role string responsible for keeping the file fresh (e.g. `Repository maintainers`, `API maintainers`).',
      approx_token_budget:
        'Estimated upper bound on tokens at ~80 chars per line and ~4 chars per token; derived from `line_budget`.',
      role: 'Short label for the file kind (e.g. `navigation-hub`, `deep-doc`, `contract`).',
      when_to_read:
        "Read-order hint: 'first', 'second', 'on-demand', 'generated-index', or 'reference'.",
      notes:
        'Optional human-facing annotation; e.g. flags advisory budgets that exceed contract targets.',
    },
  };
}

export { OWNER_LINE_EXEMPT };

// ---------------------------------------------------------------------------
// Internal-link validation
// ---------------------------------------------------------------------------

/**
 * Match the `](target)` tail of a markdown link on a single line. Link text
 * may wrap across lines, but the closing `](target)` is always on one line
 * in practice (CommonMark allows multi-line targets only in reference-style
 * links, which we treat as out of scope — see limitations below).
 *
 * Group 1 captures the target. We deliberately exclude whitespace and `)`
 * from the target match. Empty parens are skipped by the caller.
 *
 * Limitations (documented; out of scope for v1):
 *   - Reference-style links (`[text][label]` + `[label]: target`) are not
 *     resolved. None of the current agent-facing docs use them.
 *   - Image links (`![alt](path)`) ARE matched the same way as regular
 *     links; broken image paths surface as errors, which is the desired
 *     behavior for agent-facing docs.
 *   - Targets containing literal `)` (rare for filesystem paths) are
 *     truncated at the first `)`. Document paths in this repo do not
 *     contain `)`.
 *   - Inside fenced code blocks we still scan; this is a known minor
 *     limitation. Any fenced literal that happens to look like
 *     `](rel/path)` will be checked, but for agent-facing docs this is
 *     not currently a source of false positives. If it becomes one, add
 *     a fenced-block tracker here.
 */
const LINK_TAIL_RE = /\]\(([^)\s]+)\)/g;

export interface LinkValidationError {
  file: string;
  line: number;
  target: string;
  resolved: string;
  message: string;
}

/**
 * Validate internal markdown links in every "present" `.md` entry in
 * MANIFEST_SOURCE. Returns a flat list of errors; empty list means all
 * relative links resolve to files on disk.
 *
 * Skipped (out of scope) targets:
 *   - http://, https://, mailto:, ftp://, file:// schemes
 *   - Bare anchor fragments (`#section`) that refer to the same file
 *   - Empty targets
 *   - Absolute filesystem paths (`/foo`) — out of scope; agent-facing
 *     docs never use absolute paths.
 *
 * In-scope targets:
 *   - `./file.md`, `file.md`, `../AGENTS.md`, `docs/REPO_MAP.md`
 *   - Targets with `#fragment` (the fragment is stripped before resolving)
 *
 * The validator reads ONLY the markdown files listed in MANIFEST_SOURCE.
 * It never opens `data/*.db`, `.env`, `~/.claude.json`, or any HTTP
 * endpoint. Network access is intrinsically impossible because no
 * outbound IO primitives are imported.
 */
export function validateInternalLinks(repoRoot: string): LinkValidationError[] {
  const errors: LinkValidationError[] = [];

  for (const entry of MANIFEST_SOURCE) {
    if (entry.status !== 'present') continue;
    if (!entry.path.endsWith('.md')) continue;

    const abs = resolve(repoRoot, entry.path);
    if (!existsSync(abs)) continue; // file-exists is checked elsewhere

    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const sourceDir = dirname(abs);

    let inFencedBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? '';
      // Track fenced code blocks (``` or ~~~). Anything inside is treated
      // as literal text — links inside fences must not be checked because
      // they are often illustrative examples of content destined for
      // another file.
      if (/^\s*(```|~~~)/.test(rawLine)) {
        inFencedBlock = !inFencedBlock;
        continue;
      }
      if (inFencedBlock) continue;

      // Strip inline backtick code spans before link scanning. A code span
      // `...` (or ``...``) is literal text in CommonMark — any link inside
      // it is not a real link. This avoids false positives on documented
      // examples like `> See [AGENTS.md](AGENTS.md).` shown as an inline
      // illustration of what another file (e.g. CLAUDE.md at repo root)
      // should contain.
      const line = stripInlineCode(rawLine);

      LINK_TAIL_RE.lastIndex = 0;
      let match: RegExpExecArray | null = LINK_TAIL_RE.exec(line);
      while (match !== null) {
        const raw = match[1] ?? '';
        if (raw.length > 0 && !isOutOfScopeTarget(raw)) {
          const targetNoFragment = stripFragment(raw);
          if (targetNoFragment.length > 0) {
            const resolvedAbs = resolve(sourceDir, targetNoFragment);
            if (!existsSync(resolvedAbs)) {
              errors.push({
                file: entry.path,
                line: i + 1,
                target: raw,
                resolved: resolvedAbs,
                message: `${entry.path}:${
                  i + 1
                }: broken link to "${raw}" (resolved to "${resolvedAbs}")`,
              });
            }
          }
        }
        match = LINK_TAIL_RE.exec(line);
      }
    }
  }

  return errors;
}

function isOutOfScopeTarget(target: string): boolean {
  // External schemes — never resolved against the filesystem.
  if (/^(https?|mailto|ftp|file|tel):/i.test(target)) return true;
  // Bare anchor fragment on the same file.
  if (target.startsWith('#')) return true;
  // Absolute filesystem path — agent-facing docs never use these; treat
  // as out of scope to avoid false positives on `/api/v1/...` style
  // documentation references that look path-like but aren't filesystem
  // targets.
  if (isAbsolute(target)) return true;
  return false;
}

function stripFragment(target: string): string {
  const hash = target.indexOf('#');
  return hash === -1 ? target : target.slice(0, hash);
}

/**
 * Remove inline backtick code spans from a line so link scanning skips
 * them. Handles single-backtick spans (` ... `) and the common
 * double-backtick form (`` ... ``). This is a pragmatic approximation of
 * CommonMark inline code parsing — sufficient for agent-facing docs
 * which never nest backticks asymmetrically across lines.
 */
function stripInlineCode(line: string): string {
  // Replace matched double-backtick spans first, then single-backtick.
  // Non-greedy match keeps adjacent spans on the same line independent.
  return line.replace(/``[^`\n]*``/g, '').replace(/`[^`\n]*`/g, '');
}
