import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoneBackend } from '../none.js';
import type { ScmVerbContext } from '../types.js';

/**
 * task #1564 — none-mode perf benchmark over a synthetic ≥10k-file tree
 * (spec §5.1; parent spec §5.5 performance envelope: "a 50k-file tree
 * completes status in single-digit seconds; the test suite pins a
 * generated-tree benchmark so a regression is a test failure").
 *
 * Fast-path assertion route: (b) generous wall-clock ceiling, NOT hash-call
 * spying. `none.ts` imports `createHash` from `node:crypto` at module scope;
 * intercepting it via `vi.mock`/`vi.spyOn` across the ESM boundary is brittle
 * (module-namespace objects are read-only, and `none.ts` calls `createHash`
 * directly rather than through an injectable seam). A wall-clock assertion
 * instead exercises the PUBLIC API exactly the way production code does, so
 * it can't drift from the real fast-path behavior the way a mock could.
 *
 * A bare "under 30s" ceiling alone would not catch a rehash-everything
 * regression at this tree size (hashing 10k few-byte files finishes well
 * under 30s even without the fast path). So this test asserts BOTH:
 *   1. an absolute ceiling (steady-state re-walk completes under 30s), and
 *   2. a RELATIVE signal (steady-state re-walk is at most half the wall time
 *      of the baseline hash-everything walk) — the generous margin the task
 *      brief calls for. A regression that re-hashes every file on every
 *      `changed-files` call would make the re-walk take roughly as long as
 *      the baseline walk (ratio ≈ 1.0), clearly failing the ≤0.5 bound, while
 *      the fast-path-correct implementation only re-hashes the handful of
 *      touched files and finishes in a small fraction of the baseline time.
 */
describe('none SCM backend perf (task #1564)', () => {
  const DIR_COUNT = 100;
  const FILES_PER_DIR = 100;
  const TOTAL_FILES = DIR_COUNT * FILES_PER_DIR; // 10,000 — meets the ≥10k-file AC.

  function ctx(root: string, context = 'task-1564-perf'): ScmVerbContext {
    return { repo: root, context };
  }

  function generateTree(root: string): void {
    for (let d = 0; d < DIR_COUNT; d++) {
      const dirAbs = join(root, `dir${d}`);
      mkdirSync(dirAbs, { recursive: true });
      for (let f = 0; f < FILES_PER_DIR; f++) {
        writeFileSync(join(dirAbs, `file${f}.txt`), `d${d}f${f}\n`, 'utf8');
      }
    }
  }

  it('baseline over a 10k-file tree, then a steady-state re-walk hashes only touched files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scm-none-perf-'));
    try {
      generateTree(root);

      const backend = new NoneBackend();
      const baselineStart = Date.now();
      const baseline = await backend.baseline(ctx(root));
      const baselineMs = Date.now() - baselineStart;
      expect(baseline.id).toMatch(/^none:[0-9a-f]{64}$/);

      // Mutate a HANDFUL of files: modify 5, add 1, delete 1. Everything else
      // in the 10,000-file tree is left byte-for-byte and mtime-for-mtime
      // untouched, so the fast path should skip re-hashing it entirely.
      const modifiedPaths = Array.from({ length: 5 }, (_unused, i) => `dir0/file${i}.txt`);
      for (const relPath of modifiedPaths) {
        writeFileSync(join(root, relPath), 'mutated\n', 'utf8');
      }
      const addedPath = 'dir0/extra-new-file.txt';
      writeFileSync(join(root, addedPath), 'new\n', 'utf8');
      const deletedPath = 'dir1/file0.txt';
      rmSync(join(root, deletedPath));

      const reWalkStart = Date.now();
      const changed = await backend.changedFiles(ctx(root), baseline.id);
      const reWalkMs = Date.now() - reWalkStart;

      // --- Correctness: exactly the mutated file set, nothing more. ---
      const expected = [
        ...modifiedPaths.map((path) => ({ path, change: 'modified' as const })),
        { path: addedPath, change: 'added' as const },
        { path: deletedPath, change: 'deleted' as const },
      ];
      expect(changed.files).toHaveLength(expected.length);
      for (const entry of expected) {
        expect(changed.files).toContainEqual(entry);
      }

      // --- Perf: steady-state re-walk is fast, both in absolute and
      // relative terms (see route-(b) rationale in the describe-block doc
      // comment above). ---
      expect(reWalkMs).toBeLessThan(30_000);
      expect(reWalkMs).toBeLessThanOrEqual(baselineMs / 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('generated fixture tree actually reaches the ≥10k-file floor the AC requires', () => {
    expect(TOTAL_FILES).toBeGreaterThanOrEqual(10_000);
  });
});
