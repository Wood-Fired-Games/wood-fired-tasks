/**
 * CLI credentials helper — owns the on-disk TOML credentials file and the
 * auth-precedence resolver shared by `tasks login`, `tasks logout`,
 * `tasks whoami`, and the API client.
 *
 * Path: `$WFB_CREDENTIALS_PATH` > `$XDG_CONFIG_HOME/wood-fired-bugs/credentials`
 *       (when XDG_CONFIG_HOME is an ABSOLUTE path per XDG Base Directory spec)
 *       > `~/.config/wood-fired-bugs/credentials`.
 *
 * On POSIX the file is enforced at mode 0o600 — `writeCredentials` opens with
 * the mode AND chmods after (belt-and-braces against permissive umasks), and
 * `readCredentials` refuses to read if any "other" or "group" bits are set
 * (the user is told to `chmod 600` instead of getting a silent secret leak).
 *
 * The on-disk write uses the atomic-rename pattern: write to a `.tmp.<pid>.<ts>`
 * sibling, set mode 0o600, then renameSync onto the final path. POSIX rename(2)
 * is atomic within a single filesystem — a reader can never see a partially
 * written file.
 *
 * `resolveAuth` walks: --token flag override > file > env.API_KEY > none.
 * The flag override is installed by the Commander preAction hook in the
 * `tasks` and `tasks-client` bin entry points (see Task 3).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

const POSIX = process.platform !== 'win32';

export interface Credentials {
  active: {
    token: string;
    token_id: number;
    server: string;
    user_id: number;
    display_name: string;
    email: string | null;
    logged_in_at: string; // ISO 8601 UTC
  };
}

export type AuthSource =
  | { kind: 'bearer'; token: string; origin: 'flag' | 'file' }
  | { kind: 'legacy'; key: string }
  | { kind: 'none' };

/** Module-scope storage for the --token CLI flag. The Commander preAction
 *  hook installs this; resolveAuth reads it. Null = no override active. */
let currentTokenOverride: string | null = null;

export function setTokenOverride(token: string | null): void {
  currentTokenOverride = token;
}

export function getCredentialsPath(): string {
  const override = process.env.WFB_CREDENTIALS_PATH;
  if (override && override.length > 0) return override;

  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.config');
  return path.join(configHome, 'wood-fired-bugs', 'credentials');
}

export function readCredentials(filePath: string = getCredentialsPath()): Credentials | null {
  if (!existsSync(filePath)) return null;

  if (POSIX) {
    const mode = statSync(filePath).mode & 0o777;
    // Refuse if any "group" or "other" bit is set — the file is supposed to
    // be 0600 (owner read/write only). Surface a friendly error rather than
    // silently leaking secrets to other local users.
    if ((mode & 0o077) !== 0) {
      const octal = mode.toString(8).padStart(3, '0');
      throw new Error(
        `Credentials file ${filePath} has insecure permissions (mode ${octal}). ` +
          `Run: chmod 600 ${filePath}`
      );
    }
  }

  const body = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Credentials file is malformed TOML: ${msg}`);
  }
  // Shape validation is deferred to callers — TOML structure guarantees an
  // object with an `[active]` table when the file was written by us.
  return parsed as Credentials;
}

export function writeCredentials(
  creds: Credentials,
  filePath: string = getCredentialsPath()
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const header =
    '# Wood Fired Bugs CLI credentials. Created by `tasks login`.\n' +
    '# Do NOT commit this file to version control.\n\n';
  const body = header + stringify(creds);

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  // writeFileSync's `mode` is the open(2) creation mode — combined with the
  // process umask. Belt-and-braces chmod below pins it to exactly 0o600.
  writeFileSync(tmp, body, { mode: 0o600 });
  if (POSIX) chmodSync(tmp, 0o600);

  // Atomic on POSIX (single-fs rename(2)); on Windows MoveFileEx provides
  // similar semantics. If rename throws (e.g. cross-fs), the tmp file is left
  // behind — acceptable; the final path never sees partial state.
  renameSync(tmp, filePath);
}

export function deleteCredentials(filePath: string = getCredentialsPath()): boolean {
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export async function resolveAuth(): Promise<AuthSource> {
  // 1. --token flag wins unconditionally.
  if (currentTokenOverride !== null) {
    return { kind: 'bearer', token: currentTokenOverride, origin: 'flag' };
  }

  // 2. Credentials file. Errors propagate (malformed TOML / insecure perms
  //    should surface to the user — silently falling through to env.API_KEY
  //    would mask a real problem).
  const creds = readCredentials();
  if (creds !== null) {
    return { kind: 'bearer', token: creds.active.token, origin: 'file' };
  }

  // 3. Legacy API_KEY env (MIGR-01 — every pre-Phase-30 CLI workflow keeps
  //    working unchanged).
  const apiKey = process.env.API_KEY;
  if (apiKey && apiKey.length > 0) {
    return { kind: 'legacy', key: apiKey };
  }

  // 4. None — the caller decides (apiRequest throws NotAuthenticatedError).
  return { kind: 'none' };
}
