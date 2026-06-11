/**
 * Shared manual-PAT onboarding primitives used by BOTH `tasks setup --remote`
 * and `tasks login` (tasks #857/#858).
 *
 * History: `setup` grew a full manual-PAT path (browser-SSO gate → validate the
 * pasted PAT against `GET /api/v1/me` → persist via {@link writeCredentials}),
 * but `login` shipped device-flow-only and `setup --remote --token` wrote the
 * PAT to an orphaned cache file that NO code reads. Both bugs trace to the same
 * logic living inline in setup.ts where login couldn't reuse it. This module is
 * the single source of truth so the two commands can't drift again.
 *
 * Nothing here writes to `claude.json`; the credentials TOML (owned by
 * {@link writeCredentials}) is the ONLY place a manual PAT lands. The CLI and the
 * remote MCP bridge both resolve their bearer token from that file at runtime.
 */
import { writeCredentials } from './credentials.js';
import { promptSecret, type PromptIO } from '../util/prompt.js';
import { shouldPrompt } from '../prompts/interactive.js';

/**
 * Whether the browser/device login (Google SSO) can actually COMPLETE against
 * `baseUrl` (#835).
 *
 * The whole OIDC dance — the verification page AND the IdP's OAuth callback —
 * happens at the server's origin, and identity providers (Google especially)
 * reject non-`https` OAuth redirect URIs *except* for `localhost`/`127.0.0.1`.
 * So a server reached over plain `http` at a non-localhost address can report
 * `oidc: 'ready'` yet still be unable to finish browser login: the user's
 * browser gets bounced to an `http://…/auth/callback` the IdP won't honor. We
 * detect that up front so onboarding can tell the user the truth (need https,
 * or use a PAT) instead of opening a URL that dead-ends.
 *
 * Returns true for any `https` URL and for `http://localhost` / `127.0.0.1` /
 * `[::1]`; false for plain-http non-loopback hosts and unparseable input.
 */
export function canUseBrowserSso(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * The advisory block shown when browser SSO can't complete against `baseUrl`
 * (plain-http non-localhost): explain the https requirement and how to mint a
 * PAT on the server host. Returned as discrete lines so each caller logs them
 * through its own sink (setup → `log()`, login → stderr / JSON). Shared so the
 * two commands print identical guidance (#857).
 */
export function browserSsoGuidance(baseUrl: string): string[] {
  return [
    '',
    `"${baseUrl}" is plain http at a non-localhost address.`,
    'Browser login via Google SSO requires an https URL — identity providers',
    'reject non-https OAuth redirect URIs except for localhost — so the device',
    'flow cannot complete against this server. To finish, either:',
    '  • re-run with an https URL for this server (e.g. front it with a TLS',
    '    reverse proxy / real domain so Google SSO completes), or',
    '  • paste a personal access token now.',
    '',
    'To mint a PAT, run this ON THE SERVER HOST:',
    '  tasks db mint-token --user <your-email-or-user-id>',
    '(or create one from your account page once logged in via the browser).',
    '',
  ];
}

/**
 * The minimal identity envelope `GET /api/v1/me` returns (task #809). Mirrors
 * the fields {@link writeCredentials} needs so a manually-pasted PAT lands in
 * the SAME credentials file the device flow writes — the bridge then resolves
 * its bearer token from there at runtime (URL-only claude.json entry, #810).
 */
export interface ManualPatIdentity {
  id: number;
  displayName: string;
  email: string | null;
  /** Best-effort token rowid; defaults to 1 when the server omits it. */
  tokenId?: number;
}

/**
 * Outcome of persisting a manually-supplied PAT (task #809).
 *  - `{ ok: true, identity }`  — the PAT validated and credentials were written.
 *  - `{ ok: false, reason }`   — the PAT was rejected / unreachable; `reason`
 *    is surfaced to the user and NOTHING is persisted.
 */
export type ManualPatPersistResult =
  | { ok: true; identity: ManualPatIdentity }
  | { ok: false; reason: string };

/** Injectable manual-PAT persistence seam so tests drive it without a server. */
export type ManualPatPersist = (baseUrl: string, token: string) => Promise<ManualPatPersistResult>;

/**
 * Default manual-PAT persistence (task #809).
 *
 * Validate the pasted PAT against `GET <baseUrl>/api/v1/me` (the same identity
 * envelope `tasks whoami` reads), then persist it through {@link writeCredentials}
 * — the SAME credentials writer the device flow uses. This is the only place the
 * manual PAT lands; the claude.json entry stays URL-only (#810) and the bridge
 * resolves the bearer token from this credentials file at runtime, so the secret
 * is never embedded in claude.json.
 *
 * A non-2xx / network failure returns `{ ok: false, reason }` and writes
 * NOTHING — the caller reports the reason and exits without a half-configured
 * install.
 */
export async function persistManualPat(
  baseUrl: string,
  token: string,
): Promise<ManualPatPersistResult> {
  const meUrl = new URL('/api/v1/me', baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(meUrl, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not reach ${meUrl}: ${message}` };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'the personal access token was rejected (HTTP 401)' };
  }
  if (!response.ok) {
    return { ok: false, reason: `${meUrl} returned HTTP ${response.status}` };
  }

  let body: { id?: unknown; displayName?: unknown; email?: unknown } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: `${meUrl} returned a non-JSON body` };
  }

  if (body === null || typeof body.id !== 'number' || typeof body.displayName !== 'string') {
    return { ok: false, reason: `${meUrl} did not return a usable identity` };
  }
  const email = typeof body.email === 'string' ? body.email : null;
  const identity: ManualPatIdentity = { id: body.id, displayName: body.displayName, email };

  // Persist through the SAME credentials writer the device flow uses. The
  // server's /me envelope does not carry the token rowid, so default token_id
  // to 1 (a positive int, satisfying the credentials schema); `whoami`'s
  // best-effort token enrichment degrades gracefully when it can't match it.
  try {
    writeCredentials({
      active: {
        token,
        token_id: 1,
        server: baseUrl,
        user_id: identity.id,
        display_name: identity.displayName,
        email: identity.email,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to write credentials file: ${message}` };
  }

  return { ok: true, identity };
}

/** Inputs to {@link resolveManualPatToken}. */
export interface ResolveManualPatTokenArgs {
  /** Explicit PAT (e.g. `--token <pat>`); wins unconditionally when non-empty. */
  token?: string;
  /** Injectable prompt IO forwarded to {@link promptSecret} (tests/no-TTY). */
  promptIO?: PromptIO;
  /** TTY predicate (defaults to {@link shouldPrompt}). */
  isInteractive?: () => boolean;
  /** Injectable secret prompt (defaults to {@link promptSecret}) for tests. */
  promptSecretFn?: (prompt: string, io?: PromptIO) => Promise<string>;
  /** Prompt label shown before reading the secret. */
  promptLabel?: string;
  /**
   * Optional env var consulted as the LAST resort on a non-TTY (e.g.
   * `'WFT_API_KEY'` for `setup`, which the remote bridge also reads). Omit to
   * disable the env fallback (e.g. `tasks login`).
   */
  envVar?: string;
}

/**
 * Resolve a manual PAT from, in precedence order:
 *   1. an explicit `token` (the `--token` flag),
 *   2. an interactive `promptSecret` (only on a TTY — never echoed),
 *   3. an optional `envVar` fallback (non-TTY automation).
 *
 * Returns `undefined` when none yields a non-empty value, so the caller can
 * print actionable guidance instead of hanging on a prompt with no TTY. Shared
 * by `setup` and `login` so their PAT-sourcing rules stay identical (#857).
 */
export async function resolveManualPatToken(
  args: ResolveManualPatTokenArgs,
): Promise<string | undefined> {
  let token = args.token;

  if ((typeof token !== 'string' || token.length === 0) && (args.isInteractive ?? shouldPrompt)()) {
    const ask = args.promptSecretFn ?? promptSecret;
    token = await ask(args.promptLabel ?? 'Paste a personal access token: ', args.promptIO);
  }

  if ((typeof token !== 'string' || token.length === 0) && args.envVar) {
    const envToken = process.env[args.envVar];
    if (typeof envToken === 'string' && envToken.length > 0) {
      token = envToken;
    }
  }

  return typeof token === 'string' && token.length > 0 ? token : undefined;
}
