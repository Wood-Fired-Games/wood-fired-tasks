/**
 * Owner-only file access on Windows.
 *
 * POSIX mode bits (`0o600`, `chmod`) have no effect on a Windows access
 * list, so on Windows the credentials file is limited to the current
 * account with `icacls`: inherited entries are removed and the account alone
 * is granted full control. `icacls` runs through `execFileSync` with an
 * argument array — no shell is involved, so a path with spaces or shell
 * metacharacters is passed through verbatim.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** `icacls` arguments that leave `filePath` accessible to `account` only. */
export function ownerOnlyAclArgs(filePath: string, account: string): string[] {
  if (account.length === 0) {
    throw new Error('Cannot limit file access: no account name');
  }
  return [filePath, '/inheritance:r', '/grant:r', `${account}:F`];
}

/** The current Windows account as `DOMAIN\user`, or the bare user name. */
export function windowsAccountName(
  env: Record<string, string | undefined> = process.env,
  fallback: string = os.userInfo().username,
): string {
  const user = env['USERNAME'];
  const domain = env['USERDOMAIN'];
  if (user && user.length > 0) {
    return domain && domain.length > 0 ? `${domain}\\${user}` : user;
  }
  return fallback;
}

/**
 * Limit `filePath` to the current account. Throws when `icacls` fails, so a
 * caller never goes on to write a secret into a file it could not protect.
 */
export function restrictToOwnerOnWindows(filePath: string): void {
  try {
    execFileSync('icacls', ownerOnlyAclArgs(filePath, windowsAccountName()), {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not limit ${filePath} to its owner: ${msg}`);
  }
}
