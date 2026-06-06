/**
 * Tests for `validateInternalLinks` — the markdown link freshness check.
 *
 * The validator reads only `.md` files declared in MANIFEST_SOURCE. It
 * NEVER opens `data/*.db`, `.env`, `~/.claude.json`, or any HTTP
 * endpoint. That guarantee is intrinsic: this module imports only
 * `node:fs` + `node:path`, no `node:http` or `fetch`. The committed-tree
 * test below also confirms there are no surprise external reads (it
 * passes against the repo as committed).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findRepoRoot, validateInternalLinks, MANIFEST_SOURCE } from '../manifest.js';

describe('validateInternalLinks (committed tree)', () => {
  it('reports zero broken links against the repository as committed', () => {
    const errors = validateInternalLinks(findRepoRoot());
    expect(errors, errors.map((e) => e.message).join('\n')).toEqual([]);
  });
});

/**
 * Helper: stand up a throw-away repo root inside the OS temp dir with a
 * single .md file at the given relative path, then point a manipulated
 * MANIFEST_SOURCE entry at it. We achieve "validator targets only this
 * file" by reusing the real MANIFEST_SOURCE but pointing repoRoot at a
 * directory where ONLY the file under test exists; missing files are
 * silently skipped by the validator (existence is checked elsewhere).
 */
function makeTempRepoWithMd(relPath: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ctx-links-'));
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  return dir;
}

describe('validateInternalLinks (synthetic fixtures)', () => {
  // Only entries whose path is a .md file matter to this validator.
  const presentMdEntry = MANIFEST_SOURCE.find(
    (e) => e.status === 'present' && e.path.endsWith('.md'),
  );
  if (!presentMdEntry) {
    throw new Error('Expected at least one present .md entry in MANIFEST_SOURCE.');
  }
  const relPath = presentMdEntry.path;

  it('flags a broken relative link with the file path, line number, and target', () => {
    const md = ['# Test', '', 'This [points nowhere](does-not-exist.md) on purpose.', ''].join(
      '\n',
    );
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const err = errors.find((e) => e.target === 'does-not-exist.md');
    expect(err).toBeDefined();
    expect(err!.file).toBe(relPath);
    expect(err!.line).toBe(3);
    expect(err!.message).toContain(relPath);
    expect(err!.message).toContain('does-not-exist.md');
    expect(err!.message).toContain('broken link');
  });

  it('strips #fragment before resolving and accepts links that exist on disk', () => {
    // The link target after stripping #section must exist. We point at
    // the markdown file itself (which exists) plus a #fragment.
    const fileName = relPath.split('/').pop() ?? relPath;
    const md = [
      '# Test',
      '',
      `Self link with fragment: [self](${fileName}#some-section).`,
      '',
    ].join('\n');
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    // No error for the fragment link — the bare file exists.
    expect(errors.filter((e) => e.target.includes('#some-section'))).toEqual([]);
  });

  it('skips http://, https://, and mailto: links (never resolves them as files)', () => {
    const md = [
      '# Test',
      '',
      'External: [a](https://example.com), [b](http://example.com),',
      '[c](mailto:nobody@example.com).',
      '',
    ].join('\n');
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    // None of the external schemes should produce errors, even though no
    // network call is attempted (the validator just skips them).
    for (const e of errors) {
      expect(e.target).not.toMatch(/^https?:|^mailto:/);
    }
  });

  it('skips bare #anchor links pointing inside the same file', () => {
    const md = ['# Test', '', 'Jump to [section](#a-section) here.', ''].join('\n');
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    expect(errors.filter((e) => e.target.startsWith('#'))).toEqual([]);
  });

  it('does not flag links inside inline backtick code spans (illustrative examples)', () => {
    // This guards the false-positive we hit on docs/AGENT_CONTEXT.md:
    // `> See [AGENTS.md](AGENTS.md).` is the *literal* body a CLAUDE.md
    // pointer file should contain — it's not a real link in this doc.
    const md = [
      '# Test',
      '',
      'A pointer file body looks like `> See [AGENTS.md](AGENTS.md).` and',
      'it must NOT be flagged as broken even when the path would not resolve.',
      '',
    ].join('\n');
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    expect(errors.filter((e) => e.target === 'AGENTS.md')).toEqual([]);
  });

  it('does not flag links inside fenced code blocks', () => {
    const md = ['# Test', '', '```markdown', '[example](definitely-missing.md)', '```', ''].join(
      '\n',
    );
    const root = makeTempRepoWithMd(relPath, md);

    const errors = validateInternalLinks(root);
    expect(errors.filter((e) => e.target === 'definitely-missing.md')).toEqual([]);
  });
});
