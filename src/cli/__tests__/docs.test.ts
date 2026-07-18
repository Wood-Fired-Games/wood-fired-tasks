import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import {
  DOCS_CATALOG,
  docNames,
  resolveDocPath,
  docsDir,
  listDocs,
  readDoc,
  openDoc,
  openCommandFor,
} from '../commands/docs.js';
import { packageRoot } from '../../assets/resolve.js';

const ORIG_CWD = process.cwd();

afterEach(() => {
  // No-op when chdir is unsupported (worker thread). The withTempCwd tests that
  // actually change cwd skip under that pool — see the note on withTempCwd.
  if (isMainThread) process.chdir(ORIG_CWD);
});

// process.chdir() throws inside worker_threads. Stryker's vitest runner forces
// pool:'threads' for its mutation dry run (task #823); the two tests that prove
// docs paths are resolved via the asset resolver (NOT cwd) must change cwd, so
// they are skipped there (it.skipIf(!isMainThread)) and run fully under normal
// `npm test` (forks pool / main thread). The catalog and open() tests below do
// not touch cwd and keep covering docs.ts under mutation.
function withTempCwd<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-docs-cwd-'));
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    process.chdir(ORIG_CWD);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('tasks docs catalog', () => {
  it('enumerates the shipped guides by friendly name', () => {
    const names = docNames();
    for (const expected of ['usage-patterns', 'setup', 'cli', 'api', 'mcp', 'navigation']) {
      expect(names).toContain(expected);
    }
    // Catalog maps each name to a .md file in package.json `files`.
    expect(DOCS_CATALOG['usage-patterns']).toBe('USAGE_PATTERNS.md');
    expect(DOCS_CATALOG['cli']).toBe('CLI.md');
    expect(DOCS_CATALOG['scm']).toBe('SCM.md');
  });

  it('lists only guides that exist on disk and points under packageRoot', () => {
    const entries = listDocs();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      // Resolved via the asset resolver -> always under packageRoot/docs.
      expect(e.path.startsWith(path.join(packageRoot, 'docs'))).toBe(true);
    }
    // The keystone guides must actually ship.
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['usage-patterns'].exists).toBe(true);
    expect(byName['setup'].exists).toBe(true);
    expect(byName['cli'].exists).toBe(true);
    expect(byName['scm'].exists).toBe(true);
  });
});

describe('tasks docs resolution (asset resolver, not cwd)', () => {
  it.skipIf(!isMainThread)('resolveDocPath resolves under packageRoot, independent of cwd', () => {
    withTempCwd((dir) => {
      // Sanity: cwd really is the temp dir, outside the repo.
      expect(process.cwd()).toBe(fs.realpathSync(dir));

      const p = resolveDocPath('usage-patterns');
      expect(p).toBe(path.join(packageRoot, 'docs', 'USAGE_PATTERNS.md'));
      // Must NOT resolve relative to the temp cwd.
      expect(p.startsWith(dir)).toBe(false);
      expect(fs.existsSync(p)).toBe(true);

      expect(docsDir()).toBe(path.join(packageRoot, 'docs'));
    });
  });

  it.skipIf(!isMainThread)(
    'show (readDoc) returns the real bundled content from a temp cwd',
    () => {
      // Capture the on-disk truth from the repo first.
      const truth = fs.readFileSync(path.join(packageRoot, 'docs', 'USAGE_PATTERNS.md'), 'utf8');
      expect(truth.length).toBeGreaterThan(0);

      withTempCwd(() => {
        const content = readDoc('usage-patterns');
        expect(content).toBe(truth);
      });
    },
  );

  it('throws on an unknown guide name', () => {
    expect(() => resolveDocPath('nope')).toThrow(/Unknown doc/);
  });
});

describe('tasks docs open (cross-platform, no elevation)', () => {
  it('invokes the injected runner with the platform-correct opener', () => {
    const cases: Array<{
      platform: NodeJS.Platform;
      cmd: string;
      head: string;
    }> = [
      { platform: 'darwin', cmd: 'open', head: 'open' },
      { platform: 'linux', cmd: 'xdg-open', head: 'xdg-open' },
      { platform: 'win32', cmd: 'cmd', head: 'cmd' },
    ];
    for (const c of cases) {
      const ran: Array<{ cmd: string; args: string[] }> = [];
      const result = openDoc('setup', {
        platform: c.platform,
        runner: (cmd, args) => ran.push({ cmd, args }),
      });
      expect(ran).toHaveLength(1);
      expect(ran[0].cmd).toBe(c.cmd);
      expect(result.cmd).toBe(c.cmd);
      // The resolved doc path is passed through to the opener.
      expect(ran[0].args).toContain(path.join(packageRoot, 'docs', 'SETUP.md'));
    }
  });

  it('NEVER uses an elevated command on any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const { cmd, args } = openCommandFor('/tmp/x.md', platform);
      const haystack = [cmd, ...args].join(' ').toLowerCase();
      for (const banned of ['sudo', 'runas', 'pkexec', 'doas']) {
        expect(haystack).not.toContain(banned);
      }
    }
  });

  it('hard-guards: a runner asked to elevate is impossible via openDoc mapping', () => {
    // The mapping itself never yields an elevated cmd; assert the guard exists
    // by confirming none of the platform mappings start with an elevation verb.
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const { cmd } = openCommandFor('/tmp/x.md', platform);
      expect(/^(sudo|runas|pkexec|doas)$/i.test(cmd)).toBe(false);
    }
  });
});
