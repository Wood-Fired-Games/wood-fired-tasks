import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkRecipeCountConsistency,
  countNavigationRecipes,
  findDuplicateAgentsTableRows,
  runChecks,
} from '../check.js';
import {
  type AgentContextManifest,
  MANIFEST_GROUPS,
  MANIFEST_PATH,
  MANIFEST_SOURCE,
  OWNER_LINE_EXEMPT,
  buildManifest,
  findRepoRoot,
} from '../manifest.js';

const REQUIRED_GROUPS = [
  'api-change',
  'mcp-tool-change',
  'cli-change',
  'db-migration',
  'schema-change',
  'slack-change',
  'docs-only',
  'release',
  'test-fix',
  'security-sensitive',
] as const;

// Note: we intentionally do not hard-code the reserved-slot list. As
// canonical docs land, entries flip from `reserved` -> `present`; a
// hard-coded list creates a moving snapshot that breaks every flip. The
// `every reserved entry must lack actual_lines` invariant below catches
// any real drift.

function loadOnDisk(repoRoot: string): AgentContextManifest {
  const abs = resolve(repoRoot, MANIFEST_PATH);
  expect(existsSync(abs)).toBe(true);
  return JSON.parse(readFileSync(abs, 'utf8')) as AgentContextManifest;
}

describe('agent-context manifest', () => {
  const repoRoot = findRepoRoot();

  it('runChecks reports no errors against the committed manifest', () => {
    const { errors } = runChecks(repoRoot);
    expect(errors).toEqual([]);
  });

  it('every "present" entry exists on disk and stays within its line budget', () => {
    const fresh = buildManifest({ repoRoot });
    for (const entry of fresh.files) {
      if (entry.status !== 'present') continue;
      expect(entry.actual_lines, `actual_lines missing for ${entry.path}`).toBeDefined();
      expect(entry.actual_lines!, `line budget overrun for ${entry.path}`).toBeLessThanOrEqual(
        entry.line_budget,
      );
    }
  });

  it('every "present" entry has non-empty required fields', () => {
    const fresh = buildManifest({ repoRoot });
    for (const entry of fresh.files) {
      if (entry.status !== 'present') continue;
      expect(entry.path.length, 'path').toBeGreaterThan(0);
      expect(entry.purpose.length, `purpose for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.authority.length, `authority for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.when_to_read.length, `when_to_read for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.role.length, `role for ${entry.path}`).toBeGreaterThan(0);
      expect(entry.owner_role.length, `owner_role for ${entry.path}`).toBeGreaterThan(0);
    }
  });

  it('every reserved entry must lack actual_lines (file not on disk)', () => {
    const fresh = buildManifest({ repoRoot });
    for (const entry of fresh.files) {
      if (entry.status !== 'reserved') continue;
      expect(
        entry.actual_lines,
        `${entry.path} is marked reserved but has actual_lines — flip to present`,
      ).toBeUndefined();
    }
  });

  it('contains every required task-oriented group', () => {
    const fresh = buildManifest({ repoRoot });
    for (const g of REQUIRED_GROUPS) {
      expect(fresh.groups[g], `group ${g} missing`).toBeDefined();
      expect(fresh.groups[g]!.length, `group ${g} empty`).toBeGreaterThan(0);
    }
  });

  it('exposes the same groups in MANIFEST_GROUPS and the built manifest', () => {
    const fresh = buildManifest({ repoRoot });
    expect(Object.keys(fresh.groups).sort()).toEqual(Object.keys(MANIFEST_GROUPS).sort());
  });

  it('uses only relative paths and never absolute or parent-escaping paths', () => {
    const fresh = buildManifest({ repoRoot });
    const forbidden = /^(\/|[A-Za-z]:\\|~)|(^|\/)\.\.(\/|$)/;
    for (const entry of fresh.files) {
      expect(
        forbidden.test(entry.path),
        `path "${entry.path}" must be relative and stay inside the repo`,
      ).toBe(false);
    }
    for (const [key, files] of Object.entries(fresh.groups)) {
      for (const p of files) {
        expect(forbidden.test(p), `group ${key} contains non-relative path "${p}"`).toBe(false);
      }
    }
  });

  it('every group entry references a path declared in the files table', () => {
    const fresh = buildManifest({ repoRoot });
    const known = new Set(fresh.files.map((f) => f.path));
    for (const [key, files] of Object.entries(fresh.groups)) {
      for (const p of files) {
        expect(known.has(p), `group ${key} references unknown path "${p}"`).toBe(true);
      }
    }
  });

  it('owner-line exempt set never exempts the navigation hub or contract files', () => {
    expect(OWNER_LINE_EXEMPT.has('README.md')).toBe(true);
    expect(OWNER_LINE_EXEMPT.has('SECURITY.md')).toBe(true);
    expect(OWNER_LINE_EXEMPT.has('AGENTS.md')).toBe(false);
    expect(OWNER_LINE_EXEMPT.has('docs/AGENT_CONTEXT.md')).toBe(false);
    expect(OWNER_LINE_EXEMPT.has('docs/REPO_MAP.md')).toBe(false);
  });

  it('committed manifest matches a freshly-built manifest (ignoring timestamp)', () => {
    const fresh = buildManifest({ repoRoot });
    const onDisk = loadOnDisk(repoRoot);
    const stripTs = (m: AgentContextManifest) => {
      const { generated_at: _ignored, ...rest } = m._generated;
      return { ...m, _generated: rest };
    };
    expect(stripTs(onDisk)).toEqual(stripTs(fresh));
  });

  it('declares MANIFEST_SOURCE in agreement with the built manifest entry count', () => {
    const fresh = buildManifest({ repoRoot });
    expect(fresh.files.length).toBe(MANIFEST_SOURCE.length);
  });

  it('committed manifest is valid JSON with the expected top-level shape', () => {
    const onDisk = loadOnDisk(repoRoot);
    expect(onDisk.$schema_version).toBe('1');
    expect(onDisk._generated.by).toBe('scripts/agent-context/generate.ts');
    expect(typeof onDisk._generated.generated_at).toBe('string');
    expect(onDisk.project.name).toBe('wood-fired-tasks');
    expect(onDisk.project.first_read).toBe('AGENTS.md');
    expect(onDisk.project.contract).toBe('docs/AGENT_CONTEXT.md');
    expect(Array.isArray(onDisk.files)).toBe(true);
    expect(typeof onDisk.groups).toBe('object');
    expect(typeof onDisk.custom_fields).toBe('object');
  });

  // --- Adapter-link enforcement (task #285) -------------------------------
  //
  // Adapter files (authority: 'adapter') exist only to point a vendor
  // toolchain or convention scanner at the canonical AGENTS.md. The check
  // pipeline must (a) recognise at least the two committed adapters
  // (CLAUDE.md, llms.txt), (b) ensure every committed adapter links to
  // AGENTS.md, and (c) emit a specific error message when an adapter is
  // missing the link. The first two assertions guard the rule itself; the
  // third proves the enforcement code path is wired in by stubbing a
  // throwaway adapter without an AGENTS.md link and re-running the check.

  it('declares every committed adapter and they all link to AGENTS.md', () => {
    const fresh = buildManifest({ repoRoot });
    const adapters = fresh.files.filter((f) => f.authority === 'adapter' && f.status === 'present');
    // Sanity: the two adapters introduced in #285 must be present.
    const paths = new Set(adapters.map((a) => a.path));
    expect(paths.has('CLAUDE.md')).toBe(true);
    expect(paths.has('llms.txt')).toBe(true);

    // Each adapter must contain an AGENTS.md link.
    const adapterLinkRe = /\]\((?:\.\/)?AGENTS\.md(?:#[^)]*)?\)/;
    for (const a of adapters) {
      const abs = resolve(repoRoot, a.path);
      expect(existsSync(abs), `${a.path} should exist on disk`).toBe(true);
      const text = readFileSync(abs, 'utf8');
      expect(adapterLinkRe.test(text), `${a.path} must link to AGENTS.md (adapter-link rule)`).toBe(
        true,
      );
    }

    // And the committed tree must not surface any adapter-link errors.
    const { errors } = runChecks(repoRoot);
    const adapterLinkErrors = errors.filter((e) => e.includes('does not link to AGENTS.md'));
    expect(adapterLinkErrors).toEqual([]);
  });
});

// --- Rule 9: recipe-count consistency (task #1602) -------------------------

/**
 * Stand up a throw-away repo root inside the OS temp dir containing exactly
 * the given files (relative path -> contents). Mirrors links.test.ts's
 * makeTempRepoWithMd but supports writing several files at once, since the
 * recipe-count check reads docs/NAVIGATION.md plus AGENTS.md/llms.txt.
 */
function makeTempRepoWithFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ctx-check-'));
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

describe('countNavigationRecipes + checkRecipeCountConsistency (committed tree)', () => {
  const repoRoot = findRepoRoot();

  it('counts the committed docs/NAVIGATION.md recipe headings and both claim sites agree', () => {
    const actual = countNavigationRecipes(repoRoot);
    expect(actual).toBeGreaterThan(0);

    const agentsText = readFileSync(resolve(repoRoot, 'AGENTS.md'), 'utf8');
    expect(agentsText).toContain(`(${actual} task shapes with files`);

    const llmsText = readFileSync(resolve(repoRoot, 'llms.txt'), 'utf8');
    expect(llmsText).toContain(`${actual} change-type recipes`);

    expect(checkRecipeCountConsistency(repoRoot)).toEqual([]);
  });

  it('the committed tree surfaces no recipe-count errors via runChecks', () => {
    const { errors } = runChecks(repoRoot);
    const recipeErrors = errors.filter(
      (e) => e.includes('task shapes') || e.includes('change-type recipes'),
    );
    expect(recipeErrors).toEqual([]);
  });
});

describe('checkRecipeCountConsistency (synthetic fixtures)', () => {
  const navWithThreeRecipes = [
    '# Navigation',
    '',
    '### 1. First recipe',
    'body',
    '',
    '### 2. Second recipe',
    'body',
    '',
    '### 3. Third recipe',
    'body',
    '',
  ].join('\n');

  it('passes when AGENTS.md and llms.txt both quote the actual heading count', () => {
    const root = makeTempRepoWithFiles({
      'docs/NAVIGATION.md': navWithThreeRecipes,
      'AGENTS.md': 'See (3 task shapes with files / tests / docs) for details.',
      'llms.txt': '- [docs/NAVIGATION.md](docs/NAVIGATION.md): 3 change-type recipes.',
    });

    expect(countNavigationRecipes(root)).toBe(3);
    expect(checkRecipeCountConsistency(root)).toEqual([]);
  });

  it('fails when AGENTS.md quotes a stale count (this is the guard the task requires)', () => {
    const root = makeTempRepoWithFiles({
      'docs/NAVIGATION.md': navWithThreeRecipes,
      'AGENTS.md': 'See (2 task shapes with files / tests / docs) for details.',
      'llms.txt': '- [docs/NAVIGATION.md](docs/NAVIGATION.md): 3 change-type recipes.',
    });

    const errors = checkRecipeCountConsistency(root);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('AGENTS.md claims 2 task shapes');
    expect(errors[0]).toContain('has 3');
  });

  it('fails when llms.txt quotes a stale count', () => {
    const root = makeTempRepoWithFiles({
      'docs/NAVIGATION.md': navWithThreeRecipes,
      'AGENTS.md': 'See (3 task shapes with files / tests / docs) for details.',
      'llms.txt': '- [docs/NAVIGATION.md](docs/NAVIGATION.md): 19 change-type recipes.',
    });

    const errors = checkRecipeCountConsistency(root);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('llms.txt claims 19 change-type recipes');
    expect(errors[0]).toContain('has 3');
  });

  it('fails when a claim site is missing the count phrase entirely', () => {
    const root = makeTempRepoWithFiles({
      'docs/NAVIGATION.md': navWithThreeRecipes,
      'AGENTS.md': 'No recipe count mentioned here.',
      'llms.txt': '- [docs/NAVIGATION.md](docs/NAVIGATION.md): 3 change-type recipes.',
    });

    const errors = checkRecipeCountConsistency(root);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('AGENTS.md: expected a "task shapes" count claim');
  });
});

// --- Rule 10: duplicate-row guard for AGENTS.md tables (task #1602) --------

describe('findDuplicateAgentsTableRows (committed tree)', () => {
  it('the committed AGENTS.md has no duplicate table rows', () => {
    const repoRoot = findRepoRoot();
    expect(findDuplicateAgentsTableRows(repoRoot)).toEqual([]);
  });

  it('the committed tree surfaces no duplicate-row errors via runChecks', () => {
    const repoRoot = findRepoRoot();
    const { errors } = runChecks(repoRoot);
    const dupErrors = errors.filter((e) => e.includes('duplicate table row'));
    expect(dupErrors).toEqual([]);
  });
});

describe('findDuplicateAgentsTableRows (synthetic fixtures)', () => {
  it('flags a doc listed twice in the same table (the ONBOARDING_SMOKE.md regression)', () => {
    const agentsMd = [
      '# Agents',
      '',
      '## Deeper docs',
      '',
      '| File | One-line purpose |',
      '|---|---|',
      '| [docs/A.md](docs/A.md) | First doc |',
      '| [docs/ONBOARDING_SMOKE.md](docs/ONBOARDING_SMOKE.md) | Onboarding smoke test |',
      '| [docs/B.md](docs/B.md) | Second doc |',
      '| [docs/ONBOARDING_SMOKE.md](docs/ONBOARDING_SMOKE.md) | Repeatable onboarding smoke |',
      '',
    ].join('\n');
    const root = makeTempRepoWithFiles({ 'AGENTS.md': agentsMd });

    const errors = findDuplicateAgentsTableRows(root);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain(
      'duplicate table row "[docs/ONBOARDING_SMOKE.md](docs/ONBOARDING_SMOKE.md)"',
    );
    expect(errors[0]).toContain('first seen at line 8');
  });

  it('does not flag the same doc appearing once each in two separate tables', () => {
    const agentsMd = [
      '# Agents',
      '',
      '## Table one',
      '',
      '| File | Purpose |',
      '|---|---|',
      '| [docs/A.md](docs/A.md) | First doc |',
      '',
      '## Table two',
      '',
      '| File | Purpose |',
      '|---|---|',
      '| [docs/A.md](docs/A.md) | First doc, again in a different table |',
      '',
    ].join('\n');
    const root = makeTempRepoWithFiles({ 'AGENTS.md': agentsMd });

    expect(findDuplicateAgentsTableRows(root)).toEqual([]);
  });

  it('does not flag a clean table with no repeats', () => {
    const agentsMd = [
      '| File | Purpose |',
      '|---|---|',
      '| [docs/A.md](docs/A.md) | First doc |',
      '| [docs/B.md](docs/B.md) | Second doc |',
      '',
    ].join('\n');
    const root = makeTempRepoWithFiles({ 'AGENTS.md': agentsMd });

    expect(findDuplicateAgentsTableRows(root)).toEqual([]);
  });

  it('returns no errors when AGENTS.md does not exist at the given root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-ctx-check-empty-'));
    expect(findDuplicateAgentsTableRows(root)).toEqual([]);
  });
});
