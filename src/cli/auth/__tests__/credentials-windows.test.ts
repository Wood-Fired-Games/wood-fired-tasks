/**
 * Credentials file access on Windows (WFT #2609).
 *
 * On Windows the credentials file is limited to its owner with `icacls`
 * (POSIX mode bits do not apply there). These tests cover the command
 * construction directly, and the write path by simulating `win32` with a
 * mocked `execFileSync`. They do not run `icacls` itself.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

  it('passes a path with spaces as one argument (no shell quoting involved)', () => {
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
  it('names icacls by absolute path under SystemRoot, never by bare name', () => {
    expect(icaclsPath({ SystemRoot: 'D:\\Win' })).toBe(
      path.win32.join('D:\\Win', 'System32', 'icacls.exe'),
    );
  });

  it('falls back to C:\\Windows when SystemRoot is unset or not absolute', () => {
    const expected = path.win32.join('C:\\Windows', 'System32', 'icacls.exe');
    expect(icaclsPath({})).toBe(expected);
    expect(icaclsPath({ SystemRoot: 'relative\\dir' })).toBe(expected);
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
    writeFileSync?: (...args: unknown[]) => unknown,
  ) {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync,
    }));
    if (writeFileSync) {
      vi.doMock('node:fs', async (importOriginal) => ({
        ...(await importOriginal<typeof import('node:fs')>()),
        writeFileSync,
      }));
    }
    return import('../credentials.js');
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

  it('limits the file to its owner before the token is written, then moves it into place', async () => {
    const target = path.join(dir, 'credentials');
    const calls: { cmd: string; args: string[]; tmp: string; contentAtCall: string }[] = [];
    const exec = fakeExec((cmd, args) => {
      const [tmpName] = readdirSync(dir);
      const tmp = path.join(dir, tmpName as string);
      calls.push({ cmd, args, tmp, contentAtCall: readFileSync(tmp, 'utf8') });
    });
    const { writeCredentials } = await loadAsWindows(exec);

    writeCredentials(CREDS, target);

    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[number];
    expect(path.win32.isAbsolute(call.cmd)).toBe(true);
    expect(path.win32.basename(call.cmd).toLowerCase()).toBe('icacls.exe');
    expect(call.tmp).not.toBe(target);
    expect(call.args[0]).toBe(path.win32.resolve(call.tmp));
    expect(call.args.slice(1, 3)).toEqual(['/inheritance:r', '/grant:r']);
    expect(call.args[3]).toBe(`*${SID}:F`);
    // Nothing secret was on disk when access was limited.
    expect(call.contentAtCall).not.toContain(CREDS.active.token);
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
      write,
    );

    expect(() => writeCredentials(CREDS, target)).toThrow(/disk full/);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
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
