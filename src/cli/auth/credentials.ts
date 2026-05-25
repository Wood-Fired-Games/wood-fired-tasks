/**
 * CLI credentials helper — owns the on-disk TOML credentials file and the
 * auth-precedence resolver shared by `tasks login`, `tasks logout`,
 * `tasks whoami`, and the API client.
 *
 * Path: `$WFT_CREDENTIALS_PATH` > `$XDG_CONFIG_HOME/wood-fired-tasks/credentials`
 *       (when XDG_CONFIG_HOME is an ABSOLUTE path per XDG Base Directory spec)
 *       > `~/.config/wood-fired-tasks/credentials`.
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
import { z } from 'zod';

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

/**
 * WR-05 (Phase 30 review) — Zod shape validator for the on-disk
 * credentials file. Runs after `parse(body)` so a hand-edited file
 * (missing `[active]`, mistyped key, wrong type) surfaces an actionable
 * error message instead of a downstream `TypeError: Cannot destructure
 * property 'server' of 'undefined'`.
 *
 * Field rules:
 *   - `token`: non-empty string. PAT format `wfb_pat_<base64url>`; we
 *     don't pin the prefix here because the legacy/raw-bearer migration
 *     path (Phase 28 PATs) could in principle ship in different shapes.
 *     "Non-empty" is the load-bearing invariant — anything else and the
 *     API client would 401 anyway.
 *   - `token_id`: positive integer. SQLite rowid is 1-based.
 *   - `server`: non-empty string. We do NOT parse as a URL here because
 *     historical credentials files survived without `--server` defaults;
 *     downstream `apiRequest` validates the URL when it constructs the
 *     fetch.
 *   - `user_id`: positive integer.
 *   - `display_name`: string (may be empty for service accounts).
 *   - `email`: string or null.
 *   - `logged_in_at`: string. We do NOT round-trip via Date.parse here
 *     because `whoami` only displays the string; ISO 8601 conformance
 *     is the writer's job (`tasks login`).
 */
const CredentialsSchema = z.object({
  active: z.object({
    token: z.string().min(1),
    token_id: z.number().int().positive(),
    server: z.string().min(1),
    user_id: z.number().int().positive(),
    display_name: z.string(),
    // smol-toml omits keys whose value is null when serializing (TOML
    // has no null literal), so after parse() the `email` slot can be
    // EITHER a string OR `undefined`. Accept both shapes and normalize
    // `undefined` → `null` below so callers see the documented union.
    email: z.string().nullish(),
    logged_in_at: z.string().min(1),
  }),
});

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
  const override = process.env.WFT_CREDENTIALS_PATH;
  if (override && override.length > 0) return override;

  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.config');
  return path.join(configHome, 'wood-fired-tasks', 'credentials');
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
  // WR-05 (Phase 30 review) — validate shape AFTER TOML parse. A
  // hand-edited file (missing [active], mistyped key, wrong type) used
  // to surface as a downstream `TypeError: Cannot destructure property
  // 'server' of 'undefined'` from whoami.ts / logout.ts. Replace that
  // opaque message with an actionable one that tells the user how to
  // recover.
  const result = CredentialsSchema.safeParse(parsed);
  if (!result.success) {
    // z.ZodError exposes `.issues` — first issue's path + message is
    // usually informative enough to point a user at the bad field.
    const first = result.error.issues[0];
    const fieldPath = first?.path.join('.') ?? '<root>';
    const reason = first?.message ?? 'shape mismatch';
    throw new Error(
      `Credentials file ${filePath} has an invalid shape at \`${fieldPath}\`: ${reason}. ` +
        `Run \`tasks login\` to regenerate the file.`,
    );
  }
  // Normalize `email: undefined` → `email: null` so the Credentials
  // interface contract (`email: string | null`) holds for callers.
  // smol-toml's omit-on-null serialization is the reason undefined can
  // appear here.
  return {
    active: {
      ...result.data.active,
      email: result.data.active.email ?? null,
    },
  };
}

export function writeCredentials(
  creds: Credentials,
  filePath: string = getCredentialsPath()
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const header =
    '# Wood Fired Tasks CLI credentials. Created by `tasks login`.\n' +
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
