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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = '1';
export const GENERATOR_PATH = 'scripts/agent-context/generate.ts';
export const MANIFEST_PATH = '.agent-context.json';

// ~4 chars per token, per the contract.
const CHARS_PER_TOKEN = 4;
// Average characters per line used to derive an approximate token budget from
// a line budget. 80 is a generous upper bound for prose-heavy markdown.
const CHARS_PER_LINE = 80;

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
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Authority = 'authoritative' | 'generated' | 'adapter';
export type FileStatus = 'present' | 'reserved';
export type WhenToRead =
  | 'first'
  | 'second'
  | 'on-demand'
  | 'generated-index'
  | 'reference';

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
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'present',
  },
  {
    path: 'docs/WORKFLOWS.md',
    role: 'workflows',
    purpose:
      'Canonical build, test, lint, migrate, run, and smoke command recipes.',
    when_to_read: 'second',
    line_budget: 250,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'reserved',
    notes: 'Reserved slot — landing in task #277.',
  },
  {
    path: 'docs/INTERFACES.md',
    role: 'interfaces-index',
    purpose:
      'Generated index of REST routes, MCP tools, and CLI subcommands with source-file pointers.',
    when_to_read: 'generated-index',
    line_budget: 400,
    authority: 'generated',
    owner_role: 'Repository maintainers',
    status: 'reserved',
    notes: 'Reserved slot — landing in task #278.',
  },
  {
    path: 'docs/NAVIGATION.md',
    role: 'navigation-index',
    purpose:
      'Task-oriented index: "if you want to do X, read these files in this order."',
    when_to_read: 'on-demand',
    line_budget: 300,
    authority: 'authoritative',
    owner_role: 'Repository maintainers',
    status: 'reserved',
    notes: 'Reserved slot — landing in task #279.',
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
    notes:
      'Advisory budget — currently exceeds the contract target; tighten in a follow-up.',
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
    line_budget: 800,
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
  'mcp-tool-change': [
    'AGENTS.md',
    'docs/MCP.md',
    'docs/REPO_MAP.md',
    'docs/INTERFACES.md',
  ],
  'cli-change': [
    'AGENTS.md',
    'docs/CLI.md',
    'docs/REPO_MAP.md',
    'docs/INTERFACES.md',
  ],
  'db-migration': [
    'AGENTS.md',
    'docs/REPO_MAP.md',
    'docs/SETUP.md',
    'docs/ARCHITECTURE.md',
  ],
  'schema-change': [
    'AGENTS.md',
    'docs/REPO_MAP.md',
    'docs/API.md',
    'docs/INTERFACES.md',
  ],
  'slack-change': ['AGENTS.md', 'docs/SLACK.md', 'docs/REPO_MAP.md'],
  'docs-only': ['AGENTS.md', 'docs/AGENT_CONTEXT.md', 'CONTRIBUTING.md'],
  release: ['AGENTS.md', 'docs/RELEASE.md', 'CONTRIBUTING.md'],
  'test-fix': ['AGENTS.md', 'docs/REPO_MAP.md', 'CONTRIBUTING.md'],
  'security-sensitive': [
    'AGENTS.md',
    'SECURITY.md',
    'docs/SETUP.md',
    'docs/REPO_MAP.md',
  ],
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
  throw new Error(
    `findRepoRoot: could not locate package.json starting from ${here}`,
  );
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
    const approxTokenBudget = Math.round(
      (entry.line_budget * CHARS_PER_LINE) / CHARS_PER_TOKEN,
    );
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
      name: 'wood-fired-bugs',
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
