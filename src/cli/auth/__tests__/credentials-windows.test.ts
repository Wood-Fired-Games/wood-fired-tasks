/**
 * Credentials file access on Windows (WFT #2609).
 *
 * On Windows the credentials file is limited to its owner with `icacls`
 * (POSIX mode bits do not apply there). These tests cover the command
 * construction directly, and the write path by simulating `win32` with a
 * mocked `execFileSync`. They do not run `icacls` itself.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  icaclsPath,
  ownerOnlyAclArgs,
  parseWhoamiSid,
  windowsAccountName,
} from '../owner-only-file.js';
import type { Credentials } from '../credentials.js';

const CREDS: Credentials = {
  active: {
    token: 'wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    token_id: 7,
    server: 'https://tasks.example.com',
    user_id: 3,
    display_name: 'Someone',
    email: null,
    logged_in_at: '2026-11-24T00:00:00.000Z',
  },
};

describe('ownerOnlyAclArgs', () => {
  it('removes inherited entries and grants full control to the account alone', () => {
    expect(ownerOnlyAclArgs('C:\\Users\\a\\credentials.tmp', 'HOST\\a')).toEqual([
      'C:\\Users\\a\\credentials.tmp',
      '/inheritance:r',
      '/grant:r',
      'HOST\\a:F',
    ]);
  });

  it('keeps a path with spaces as one argument', () => {
    const args = ownerOnlyAclArgs('C:\\Users\\A B\\cred file', 'A B');
    expect(args[0]).toBe('C:\\Users\\A B\\cred file');
    expect(args[3]).toBe('A B:F');
  });

  it('refuses an empty account name', () => {
    expect(() => ownerOnlyAclArgs('C:\\x', '')).toThrow(/account/);
  });

  it('never passes a path that icacls could read as a switch', () => {
    for (const p of ['/tmp/credentials', '/inheritance:r', 'relative\\creds']) {
      const target = ownerOnlyAclArgs(p, 'HOST\\a')[0] as string;
      expect(target.startsWith('/')).toBe(false);
      expect(target.startsWith('-')).toBe(false);
    }
  });
});

describe('icaclsPath', () => {
  it('is the fixed System32 path, whatever SystemRoot says', () => {
    const saved = process.env['SystemRoot'];
    try {
      process.env['SystemRoot'] = 'D:\\Elsewhere';
      expect(icaclsPath()).toBe('C:\\Windows\\System32\\icacls.exe');
    } finally {
      if (saved === undefined) delete process.env['SystemRoot'];
      else process.env['SystemRoot'] = saved;
    }
  });
});

describe('parseWhoamiSid', () => {
  it('reads the SID from `whoami /user /fo csv /nh` output', () => {
    expect(parseWhoamiSid('"host\\a","S-1-5-21-111-222-333-1001"\r\n')).toBe(
      'S-1-5-21-111-222-333-1001',
    );
  });

  it('returns null for output without a SID', () => {
    expect(parseWhoamiSid('')).toBeNull();
    expect(parseWhoamiSid('"host\\a","not-a-sid"')).toBeNull();
  });
});

describe('windowsAccountName', () => {
  const savedUser = process.env['USERNAME'];
  const savedDomain = process.env['USERDOMAIN'];
  afterEach(() => {
    if (savedUser === undefined) delete process.env['USERNAME'];
    else process.env['USERNAME'] = savedUser;
    if (savedDomain === undefined) delete process.env['USERDOMAIN'];
    else process.env['USERDOMAIN'] = savedDomain;
  });

  it('uses the SID the OS reports for the current user, not the environment', () => {
    process.env['USERNAME'] = 'someone-else';
    process.env['USERDOMAIN'] = 'ELSEWHERE';
    const name = windowsAccountName(
      () => '"host\\a","S-1-5-21-111-222-333-1001"',
      () => 'os-user',
    );
    expect(name).toBe('*S-1-5-21-111-222-333-1001');
  });

  it('falls back to the OS user name when whoami gives no SID, still ignoring the environment', () => {
    process.env['USERNAME'] = 'someone-else';
    const failing = (): string => {
      throw new Error('whoami unavailable');
    };
    expect(windowsAccountName(failing, () => 'os-user')).toBe('os-user');
    expect(
      windowsAccountName(
        () => 'garbage',
        () => 'os-user',
      ),
    ).toBe('os-user');
  });
});

describe('writeCredentials on Windows (simulated)', () => {
  const realPlatform = process.platform;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wft-cred-win-'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  const SID = 'S-1-5-21-111-222-333-1001';

  async function loadAsWindows(
    execFileSync: (...args: unknown[]) => unknown,
    fsOverrides?: Record<string, (...args: never[]) => unknown>,
  ) {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync,
    }));
    if (fsOverrides) {
      vi.doMock('node:fs', async (importOriginal) => ({
        ...(await importOriginal<typeof import('node:fs')>()),
        ...fsOverrides,
      }));
    }
    return import('../credentials.js');
  }

  /** Every file under `root`, recursively, with its content. */
  function filesUnder(root: string): { file: string; content: string }[] {
    const out: { file: string; content: string }[] = [];
    for (const name of readdirSync(root)) {
      const p = path.join(root, name);
      if (statSync(p).isDirectory()) out.push(...filesUnder(p));
      else out.push({ file: p, content: readFileSync(p, 'utf8') });
    }
    return out;
  }

  /** whoami answers with the SID; every other command is recorded. */
  function fakeExec(onIcacls: (cmd: string, args: string[]) => void) {
    return vi.fn((cmd: unknown, args: unknown) => {
      const c = cmd as string;
      if (path.win32.basename(c).toLowerCase() === 'whoami.exe') {
        return `"host\\a","${SID}"\r\n`;
      }
      onIcacls(c, args as string[]);
      return Buffer.from('');
    });
  }

  it('limits a new private directory first, writes the token only inside it, then limits the final file', async () => {
    const target = path.join(dir, 'credentials');
    const calls: { args: string[]; files: { file: string; content: string }[]; dirs: string[] }[] =
      [];
    const exec = fakeExec((_cmd, args) => {
      calls.push({
        args,
        files: filesUnder(dir),
        dirs: readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory()),
      });
    });
    const { writeCredentials } = await loadAsWindows(exec);

    writeCredentials(CREDS, target);

    expect(calls).toHaveLength(2);
    const [first, second] = calls as [(typeof calls)[number], (typeof calls)[number]];
    // 1. A private directory next to the target, limited (with inheritance
    //    to its files) while it is still empty: no file exists yet anywhere.
    expect(first.dirs).toHaveLength(1);
    expect(first.args[0]).toBe(path.win32.resolve(path.join(dir, first.dirs[0] as string)));
    expect(first.args.slice(1, 3)).toEqual(['/inheritance:r', '/grant:r']);
    expect(first.args[3]).toBe(`*${SID}:(OI)(CI)F`);
    expect(first.files).toEqual([]);
    // 2. The final file, limited explicitly after it was moved into place.
    expect(second.args[0]).toBe(path.win32.resolve(target));
    expect(second.args[3]).toBe(`*${SID}:F`);
    // The token was only ever written inside the private directory.
    for (const f of second.files) {
      if (f.content.includes(CREDS.active.token)) expect(f.file).toBe(target);
    }
    expect(readFileSync(target, 'utf8')).toContain(CREDS.active.token);
    expect(readdirSync(dir)).toEqual(['credentials']);
  });

  it('refuses to write the token when access cannot be limited, and leaves no file behind', async () => {
    const target = path.join(dir, 'credentials');
    const exec = fakeExec(() => {
      throw new Error('icacls failed');
    });
    const { writeCredentials } = await loadAsWindows(exec);

    expect(() => writeCredentials(CREDS, target)).toThrow(/owner/i);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves no file behind when writing the token fails after access was limited', async () => {
    const target = path.join(dir, 'credentials');
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const write = vi.fn((file: unknown, data: unknown, opts?: unknown) => {
      if (typeof data === 'string' && data.includes(CREDS.active.token)) {
        throw new Error('disk full');
      }
      return realFs.writeFileSync(file as string, data as string, opts as undefined);
    });
    const { writeCredentials } = await loadAsWindows(
      fakeExec(() => {}),
      {
        writeFileSync: write,
      },
    );

    expect(() => writeCredentials(CREDS, target)).toThrow(/disk full/);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports the original error when cleaning up after it also fails', async () => {
    const target = path.join(dir, 'credentials');
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { writeCredentials } = await loadAsWindows(
      fakeExec(() => {}),
      {
        writeFileSync: () => {
          throw new Error('disk full');
        },
        rmSync: () => {
          throw new Error('cleanup refused');
        },
        unlinkSync: () => {
          throw new Error('cleanup refused');
        },
      },
    );

    expect(() => writeCredentials(CREDS, target)).toThrow(/disk full/);
    expect(existsSync(target)).toBe(false);
    // Remove what the refused cleanup left, so the suite's own cleanup runs.
    realFs.rmSync(dir, { recursive: true, force: true });
    realFs.mkdirSync(dir);
  });

  it('removes the final file when it cannot be limited after the move', async () => {
    const target = path.join(dir, 'credentials');
    let n = 0;
    const exec = fakeExec(() => {
      n += 1;
      if (n === 2) throw new Error('icacls failed');
    });
    const { writeCredentials } = await loadAsWindows(exec);

    expect(() => writeCredentials(CREDS, target)).toThrow(/owner/i);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('runs every command without a shell, by absolute path, with an argument array', async () => {
    const shellApis = {
      exec: vi.fn(),
      execSync: vi.fn(),
      spawn: vi.fn(),
      spawnSync: vi.fn(),
    };
    const exec = fakeExec(() => {});
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      ...shellApis,
      execFileSync: exec,
    }));
    const { writeCredentials } = await import('../credentials.js');
    writeCredentials(CREDS, path.join(dir, 'credentials'));

    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [cmd, args, opts] of exec.mock.calls as unknown as [
      string,
      unknown,
      { shell?: unknown } | undefined,
    ][]) {
      expect(path.win32.isAbsolute(cmd)).toBe(true);
      expect(Array.isArray(args)).toBe(true);
      expect(opts?.shell).toBeFalsy();
    }
    for (const fn of Object.values(shellApis)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('writeCredentials on POSIX', () => {
  it.runIf(process.platform !== 'win32')('never runs icacls', async () => {
    vi.resetModules();
    const exec = vi.fn();
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync: exec,
    }));
    const { writeCredentials } = await import('../credentials.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wft-cred-posix-'));
    try {
      writeCredentials(CREDS, path.join(dir, 'credentials'));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
