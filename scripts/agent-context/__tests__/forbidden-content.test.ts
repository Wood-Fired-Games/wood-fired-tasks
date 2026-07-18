import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runChecks, scanTextForForbiddenContent } from '../check.js';
import { MANIFEST_SOURCE, buildManifest, findRepoRoot } from '../manifest.js';

// Unit tests for the section 4.4 forbidden-content scan (task #1604, rule 7
// in check.ts). Positive cases prove the scan actually flags real
// violations; negative cases prove the two allowlists (RFC 2606 example
// domains + project domain for email, file-scoped exact-match list for
// paths) keep today's legitimate documentation examples green.

describe('scanTextForForbiddenContent', () => {
  describe('positive cases (must flag)', () => {
    it('flags an AWS access key ID', () => {
      const errors = scanTextForForbiddenContent(
        'fake.md',
        'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n',
      );
      expect(errors.some((e) => e.includes('AWS access key ID'))).toBe(true);
    });

    it('flags a GitHub token', () => {
      const errors = scanTextForForbiddenContent('fake.md', `token: ghp_${'a'.repeat(36)}\n`);
      expect(errors.some((e) => e.includes('GitHub token'))).toBe(true);
    });

    it('flags a GitLab personal access token', () => {
      const errors = scanTextForForbiddenContent(
        'fake.md',
        `token: glpat-${'a1B2c3D4e5F6g7H8i9J0'}\n`,
      );
      expect(errors.some((e) => e.includes('GitLab personal access token'))).toBe(true);
    });

    it('flags a Slack token', () => {
      const errors = scanTextForForbiddenContent(
        'fake.md',
        `export SLACK_TOKEN=xoxb-${'111111111111'}-${'222222222222'}-${'abcdefghijklmnopqrstuvwx'}\n`,
      );
      expect(errors.some((e) => e.includes('Slack token'))).toBe(true);
    });

    it('flags a PEM private key block', () => {
      const errors = scanTextForForbiddenContent('fake.md', '-----BEGIN RSA PRIVATE KEY-----\n');
      expect(errors.some((e) => e.includes('PEM private key block'))).toBe(true);
    });

    it('flags a Stripe live secret key', () => {
      const errors = scanTextForForbiddenContent('fake.md', `key: sk_live_${'a'.repeat(24)}\n`);
      expect(errors.some((e) => e.includes('Stripe live secret key'))).toBe(true);
    });

    it('flags a JWT-shaped token', () => {
      const errors = scanTextForForbiddenContent(
        'fake.md',
        'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZQ\n',
      );
      expect(errors.some((e) => e.includes('JWT-shaped token'))).toBe(true);
    });

    it('flags an unallowlisted /home absolute path', () => {
      const errors = scanTextForForbiddenContent(
        'some/other/file.md',
        'The binary lives at /home/stuart/bin/tool\n',
      );
      expect(
        errors.some((e) => e.includes('local absolute path') && e.includes('/home/stuart')),
      ).toBe(true);
    });

    it('flags an unallowlisted /Users absolute path', () => {
      const errors = scanTextForForbiddenContent(
        'some/other/file.md',
        'Config at /Users/jdoe/.config/tool.json\n',
      );
      expect(
        errors.some((e) => e.includes('local absolute path') && e.includes('/Users/jdoe')),
      ).toBe(true);
    });

    it('flags an unallowlisted Windows absolute path', () => {
      const errors = scanTextForForbiddenContent(
        'some/other/file.md',
        'Install at C:\\Users\\jdoe\\AppData\\tool.exe\n',
      );
      expect(errors.some((e) => e.includes('local absolute path'))).toBe(true);
    });

    it('flags a non-project, non-example email address', () => {
      const errors = scanTextForForbiddenContent(
        'some/other/file.md',
        'Contact stuart@gmail.com for details.\n',
      );
      expect(
        errors.some(
          (e) => e.includes('non-project email address') && e.includes('stuart@gmail.com'),
        ),
      ).toBe(true);
    });

    it('reports the correct 1-based line number', () => {
      const errors = scanTextForForbiddenContent(
        'fake.md',
        'line one\nline two\nAKIAABCDEFGHIJKLMNOP\n',
      );
      expect(errors.some((e) => e.startsWith('fake.md:3:'))).toBe(true);
    });

    it('does not allowlist a /home path in a file it was not allowlisted for', () => {
      // The exact matched string "/home/you" is allowlisted only for
      // docs/MCP.md. The same string in an unrelated file must still fail.
      const errors = scanTextForForbiddenContent('docs/OTHER.md', 'See /home/you/notes.md\n');
      expect(errors.some((e) => e.includes('local absolute path'))).toBe(true);
    });
  });

  describe('negative cases (must NOT flag)', () => {
    it('does not flag @example.com placeholder emails', () => {
      const errors = scanTextForForbiddenContent(
        'docs/SETUP.md',
        'alice@example.com\nyou@example.com\nbob@example.com\nservice@example.com\n',
      );
      expect(errors).toEqual([]);
    });

    it('does not flag the project support email domain', () => {
      const errors = scanTextForForbiddenContent(
        'SECURITY.md',
        'Report vulnerabilities to security@woodfiredgames.com.\n',
      );
      expect(errors).toEqual([]);
    });

    it('does not flag the allowlisted docs/AGENT_CONTEXT.md ellipsis path examples', () => {
      const errors = scanTextForForbiddenContent(
        'docs/AGENT_CONTEXT.md',
        '- Local absolute paths (`/home/...`, `/Users/...`, `C:\\\\...`).\n',
      );
      expect(errors).toEqual([]);
    });

    it('does not flag the allowlisted docs/MCP.md placeholder home path', () => {
      const errors = scanTextForForbiddenContent(
        'docs/MCP.md',
        '    "wood-fired-tasks": { "command": "/home/you/.local/bin/wft-mcp", "args": [] }\n',
      );
      expect(errors).toEqual([]);
    });

    it('does not flag placeholder token strings like wft_pat_your-token', () => {
      const errors = scanTextForForbiddenContent(
        'docs/API.md',
        'curl -H "Authorization: Bearer wft_pat_your-token-here"\n',
      );
      expect(errors).toEqual([]);
    });

    it('does not flag ordinary prose with no forbidden shapes', () => {
      const errors = scanTextForForbiddenContent(
        'AGENTS.md',
        '# Agent entry point\n\nRead docs/AGENT_CONTEXT.md next.\n',
      );
      expect(errors).toEqual([]);
    });
  });
});

describe('forbidden-content scan wired into runChecks', () => {
  const repoRoot = findRepoRoot();

  it('produces no forbidden-content errors over the current tracked docs', () => {
    const { errors } = runChecks(repoRoot);
    const forbiddenErrors = errors.filter((e) => e.includes('forbidden content'));
    expect(forbiddenErrors).toEqual([]);
  });

  it('runChecks as a whole is still green (sanity: rule 7 did not regress rules 1-6)', () => {
    const { errors } = runChecks(repoRoot);
    expect(errors).toEqual([]);
  });

  it('every "present" MANIFEST_SOURCE file individually scans clean', () => {
    // Directly exercises scanTextForForbiddenContent against real file
    // content (not synthetic strings) for every present, on-disk file —
    // the same set the wired-in rule 7 loop iterates.
    for (const entry of MANIFEST_SOURCE) {
      if (entry.status !== 'present') continue;
      const abs = resolve(repoRoot, entry.path);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8');
      const errors = scanTextForForbiddenContent(entry.path, text);
      expect(errors, `forbidden-content violations in ${entry.path}`).toEqual([]);
    }
  });

  it('sanity: buildManifest still agrees on the present-file set used above', () => {
    const fresh = buildManifest({ repoRoot });
    expect(fresh.files.length).toBeGreaterThan(0);
  });
});
