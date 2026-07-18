/**
 * Tests for rule 8 (manifest completeness): every `docs/*.md` file on disk
 * must be either a `MANIFEST_SOURCE` entry (scripts/agent-context/
 * manifest.ts) or on the explicit `DOC_ALLOWLIST` in check.ts.
 *
 * Task #1609 — root-cause guard for the finding that `docs/SCM.md` shipped
 * discoverable in only 2 of the repo's five parallel doc indexes (AGENTS.md,
 * docs/README.md, docs/NAVIGATION.md, llms.txt, .agent-context.json).
 * Nothing previously caught a new `docs/*.md` that skipped the manifest
 * entirely; this rule does.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DOC_ALLOWLIST_CLASSES,
  discoverDocsMarkdownFiles,
  findUntrackedDocs,
  runChecks,
} from '../check.js';
import { MANIFEST_SOURCE, findRepoRoot } from '../manifest.js';

const DOC_ALLOWLIST = new Set(DOC_ALLOWLIST_CLASSES.flatMap((c) => c.paths));

/**
 * Stand up a throwaway repo root inside the OS temp dir with a `docs/`
 * subtree containing the given relative-path -> contents map. Mirrors the
 * `makeTempRepoWithMd` helper in links.test.ts — synthetic fixtures never
 * touch the real repository's `docs/` tree, so they can't race against
 * other test files exercising `runChecks(findRepoRoot())` in parallel.
 */
function makeTempDocsTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-ctx-doc-guard-'));
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return root;
}

describe('DOC_ALLOWLIST_CLASSES', () => {
  it('every class carries a real rationale and a non-empty path list', () => {
    expect(DOC_ALLOWLIST_CLASSES.length).toBeGreaterThan(0);
    for (const cls of DOC_ALLOWLIST_CLASSES) {
      expect(cls.description.length, 'class description').toBeGreaterThan(20);
      expect(
        cls.paths.length,
        `class "${cls.description.slice(0, 40)}..." has no paths`,
      ).toBeGreaterThan(0);
    }
  });

  it('has no duplicate paths across classes', () => {
    const seen = new Set<string>();
    for (const cls of DOC_ALLOWLIST_CLASSES) {
      for (const p of cls.paths) {
        expect(seen.has(p), `"${p}" is allowlisted in more than one class`).toBe(false);
        seen.add(p);
      }
    }
  });

  it('does not allowlist a path that is also a MANIFEST_SOURCE entry', () => {
    const known = new Set(MANIFEST_SOURCE.map((e) => e.path));
    for (const p of DOC_ALLOWLIST) {
      expect(known.has(p), `"${p}" is both manifest-tracked and allowlisted`).toBe(false);
    }
  });

  it('every allowlisted path still exists on disk under docs/', () => {
    // An allowlist entry for a file that was since deleted is dead weight;
    // a real removal should drop the allowlist entry too, not leave a
    // stale reference nothing exercises.
    const repoRoot = findRepoRoot();
    const onDisk = new Set(discoverDocsMarkdownFiles(repoRoot));
    for (const p of DOC_ALLOWLIST) {
      expect(onDisk.has(p), `allowlisted path "${p}" no longer exists on disk`).toBe(true);
    }
  });
});

describe('discoverDocsMarkdownFiles (committed tree)', () => {
  it('recursively finds nested docs/**/*.md files, not just the top level', () => {
    const repoRoot = findRepoRoot();
    const found = discoverDocsMarkdownFiles(repoRoot);
    expect(found).toContain('docs/AGENT_CONTEXT.md');
    expect(found).toContain('docs/superpowers/PLAN-TEMPLATE.md');
    expect(found).toContain('docs/rename/AUDIT.md');
    expect(found).toContain('docs/automation-recipes/claude-routines.md');
  });

  it('only returns .md files, not sibling non-markdown files', () => {
    const repoRoot = findRepoRoot();
    const found = discoverDocsMarkdownFiles(repoRoot);
    for (const p of found) {
      expect(p.endsWith('.md')).toBe(true);
    }
    // docs/loop-run-schema.json exists alongside loop-run-schema.md and must
    // not be picked up by the .md-only walk.
    expect(found).not.toContain('docs/loop-run-schema.json');
  });

  it('returns an empty array against a repo root with no docs/ directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-ctx-doc-guard-empty-'));
    expect(discoverDocsMarkdownFiles(root)).toEqual([]);
  });
});

describe('findUntrackedDocs (committed tree)', () => {
  it('reports zero untracked docs against the repository as committed', () => {
    const errors = findUntrackedDocs(findRepoRoot());
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('runChecks as a whole surfaces no rule-8 errors (sanity: did not regress rules 1-7)', () => {
    const { errors } = runChecks(findRepoRoot());
    const rule8Errors = errors.filter((e) => e.includes('is a docs/*.md file but is neither'));
    expect(rule8Errors).toEqual([]);
  });

  it('runChecks against the committed tree is green end-to-end', () => {
    const { errors } = runChecks(findRepoRoot());
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

describe('findUntrackedDocs (synthetic fixtures)', () => {
  it('flags a brand-new docs/*.md that is neither tracked nor allowlisted', () => {
    const root = makeTempDocsTree({
      'docs/__tmp-untracked-demo.md': '# Untracked\n\nNo owner, no index, no manifest entry.\n',
    });
    const errors = findUntrackedDocs(root, []); // empty manifest source: nothing tracked
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('docs/__tmp-untracked-demo.md');
    expect(errors[0]).toContain('MANIFEST_SOURCE');
    expect(errors[0]).toContain('DOC_ALLOWLIST');
  });

  it('does not flag a file present in the injected manifestSource', () => {
    const root = makeTempDocsTree({ 'docs/TRACKED.md': '# Tracked\n' });
    const fakeSource = [
      {
        path: 'docs/TRACKED.md',
        role: 'deep-doc',
        purpose: 'test fixture',
        when_to_read: 'on-demand' as const,
        line_budget: 10,
        authority: 'authoritative' as const,
        owner_role: 'test',
        status: 'present' as const,
      },
    ];
    expect(findUntrackedDocs(root, fakeSource)).toEqual([]);
  });

  it('does not flag a file on the real DOC_ALLOWLIST even with an empty manifestSource', () => {
    // Exercises the class-based exemption specifically (not a
    // MANIFEST_SOURCE match), using a real allowlisted path/content.
    const allowlistedPath = [...DOC_ALLOWLIST][0];
    if (!allowlistedPath) throw new Error('DOC_ALLOWLIST must not be empty');
    const root = makeTempDocsTree({ [allowlistedPath]: '# Allowlisted\n' });
    expect(findUntrackedDocs(root, [])).toEqual([]);
  });

  it('flags multiple untracked files independently, one error each', () => {
    const root = makeTempDocsTree({
      'docs/__tmp-a.md': '# A\n',
      'docs/__tmp-b.md': '# B\n',
      'docs/nested/__tmp-c.md': '# C\n',
    });
    const errors = findUntrackedDocs(root, []);
    expect(errors.length).toBe(3);
    expect(errors.some((e) => e.includes('docs/__tmp-a.md'))).toBe(true);
    expect(errors.some((e) => e.includes('docs/__tmp-b.md'))).toBe(true);
    expect(errors.some((e) => e.includes('docs/nested/__tmp-c.md'))).toBe(true);
  });
});

describe('findUntrackedDocs regression demo (task #1609 acceptance criterion)', () => {
  it('a fresh docs/*.md fails the guard against the REAL manifest+allowlist; removing it clears the guard', () => {
    // Automated equivalent of the manual "create docs/__tmp1609.md, show it
    // fails, delete it, show it passes" demonstration the task asks for —
    // run here against a synthetic repo root (so it never touches the live
    // docs/ tree and can't race other test files) but with the REAL
    // MANIFEST_SOURCE + DOC_ALLOWLIST (the default `manifestSource` param).
    const root = makeTempDocsTree({});
    mkdirSync(join(root, 'docs'), { recursive: true });

    // Before: no docs/ files exist in the synthetic tree -> nothing to flag.
    expect(findUntrackedDocs(root)).toEqual([]);

    // Add an untracked doc.
    const tempDocPath = join(root, 'docs', '__tmp1609.md');
    writeFileSync(tempDocPath, '# Demo doc\n\nNot registered anywhere.\n', 'utf8');
    const withTemp = findUntrackedDocs(root);
    expect(withTemp.some((e) => e.includes('docs/__tmp1609.md'))).toBe(true);

    // Remove it: guard clears.
    rmSync(tempDocPath);
    expect(findUntrackedDocs(root)).toEqual([]);
  });
});
