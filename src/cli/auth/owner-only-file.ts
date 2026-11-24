/**
 * Owner-only file access on Windows.
 *
 * POSIX mode bits (`0o600`, `chmod`) have no effect on a Windows access
 * list, so on Windows the credentials file is limited to the current
 * account with `icacls` (run by absolute path): inherited entries are
 * removed and the account alone is granted full control. The account is
 * the SID the OS reports for the current user (`whoami /user`), never a
 * value read from the environment. Commands run through `execFileSync` with
 * an argument array — no shell is involved, so a path with spaces or shell
 * metacharacters is passed through verbatim.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** Absolute path of a program in the Windows System32 directory. */
function system32(program: string, env: Record<string, string | undefined>): string {
  const root = env['SystemRoot'];
  const windowsDir = root && path.win32.isAbsolute(root) ? root : 'C:\\Windows';
  return path.win32.join(windowsDir, 'System32', program);
}

/** Absolute path of `icacls.exe` under the Windows directory. */
export function icaclsPath(env: Record<string, string | undefined> = process.env): string {
  return system32('icacls.exe', env);
}

/**
 * `icacls` arguments that leave `filePath` accessible to `account` only.
 * The path is resolved to a full Windows path first, so it can never begin
 * with `/` (which icacls would read as a switch).
 */
export function ownerOnlyAclArgs(filePath: string, account: string): string[] {
  if (account.length === 0) {
    throw new Error('Cannot limit file access: no account name');
  }
  const target = path.win32.resolve(filePath);
  if (target.startsWith('/') || target.startsWith('-')) {
    throw new Error(`Cannot limit file access: unexpected path ${filePath}`);
  }
  return [target, '/inheritance:r', '/grant:r', `${account}:F`];
}

/** The SID in `whoami /user /fo csv /nh` output, or null. */
export function parseWhoamiSid(output: string): string | null {
  const match = /"(S-1-\d+(?:-\d+)+)"/.exec(output);
  return match?.[1] ?? null;
}

function runWhoami(): string {
  return execFileSync(system32('whoami.exe', process.env), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
}

/**
 * The current Windows account for an icacls grant: `*<SID>` from the OS,
 * or the OS user name when no SID can be read.
 */
export function windowsAccountName(
  whoami: () => string = runWhoami,
  osUserName: () => string = () => os.userInfo().username,
): string {
  let sid: string | null = null;
  try {
    sid = parseWhoamiSid(whoami());
  } catch {
    sid = null;
  }
  return sid !== null ? `*${sid}` : osUserName();
}

/**
 * Limit `filePath` to the current account. Throws when `icacls` fails, so a
 * caller never goes on to write a secret into a file it could not protect.
 */
export function restrictToOwnerOnWindows(filePath: string): void {
  try {
    execFileSync(icaclsPath(), ownerOnlyAclArgs(filePath, windowsAccountName()), {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not limit ${filePath} to its owner: ${msg}`);
  }
}
