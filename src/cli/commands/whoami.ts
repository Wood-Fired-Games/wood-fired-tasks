/**
 * Phase 30 Plan 30-07 Task 2 — `tasks whoami` Commander command.
 *
 * Two-step lookup, in parallel:
 *
 *   1. GET ${active.server}/api/v1/me with Bearer auth — the authoritative
 *      identity envelope (src/api/routes/me/profile.ts).
 *   2. GET ${active.server}/api/v1/me/tokens with Bearer auth — best-effort
 *      enrichment so the user sees the active token's name + lastUsedAt.
 *      (src/api/routes/me/tokens.ts:349)
 *
 * /me failures are FATAL (exit 1). /me/tokens failures are NON-FATAL: the
 * command degrades to just the user envelope and omits the token block.
 *
 * Output modes:
 *   - text (default): 5 left-aligned fields (Display name, Email, Active
 *     token, Last used, Server) on stdout.
 *   - --json: a single envelope object on stdout per `<interfaces>` in
 *     30-07-PLAN.md.
 *
 * Security invariants:
 *   - The PAT value (`creds.active.token`) is NEVER printed to stdout/stderr.
 *     It appears only in the Authorization header construction.
 *   - A 10-second AbortController timeout caps each fetch so a hung server
 *     cannot keep the CLI alive indefinitely (T-30-07-04).
 */
import { Command } from 'commander';
import { readCredentials } from '../auth/credentials.js';

interface MeResponse {
  id: number;
  displayName: string;
  email: string | null;
  isLegacy: boolean;
  isServiceAccount: boolean;
  authenticatedAt?: string;
}

interface TokenListItem {
  id: number;
  name: string;
  prefix: string;
  suffix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

/** Emit one newline-separated JSON envelope on stdout (used in --json mode). */
function emitJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

type MeResult =
  | { kind: 'ok'; body: MeResponse }
  | { kind: 'unauthorized' }
  | { kind: 'http_error'; status: number }
  | { kind: 'network_error'; message: string };

async function fetchMe(server: string, token: string): Promise<MeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${server}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const body = (await res.json()) as MeResponse;
      return { kind: 'ok', body };
    }
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'http_error', status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'network_error', message };
  } finally {
    clearTimeout(timer);
  }
}

type TokensResult = { kind: 'ok'; body: TokenListItem[] } | { kind: 'failed'; reason: string };

async function fetchTokens(server: string, token: string): Promise<TokensResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${server}/api/v1/me/tokens`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const body = (await res.json()) as TokenListItem[];
      return { kind: 'ok', body };
    }
    return { kind: 'failed', reason: `status ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format a key:value line with the label left-padded to width 13.
 * Width 13 = 'Display name:' (the longest label) — keeps the colon column
 * aligned across all 5 lines.
 */
function fmtLine(label: string, value: string): string {
  return `${(label + ':').padEnd(13)} ${value}`;
}

export const whoamiCommand = new Command('whoami')
  .description('Show the currently logged-in user')
  .action(async () => {
    const program = whoamiCommand.parent;
    const globalOpts = program?.optsWithGlobals() ?? {};
    const isJson: boolean = globalOpts['json'] === true;

    const creds = readCredentials();
    if (creds === null) {
      if (isJson) {
        emitJsonEvent({ event: 'not_logged_in' });
      } else {
        process.stderr.write('Not logged in. Run: tasks login\n');
      }
      process.exitCode = 1;
      return;
    }

    const { server, token, token_id } = creds.active;

    // Parallel fetches. /me/tokens is best-effort; we don't let its failure
    // gate the command.
    const [meResult, tokensResult] = await Promise.all([
      fetchMe(server, token),
      fetchTokens(server, token),
    ]);

    if (meResult.kind === 'unauthorized') {
      if (isJson) {
        emitJsonEvent({ event: 'invalid_token' });
      } else {
        process.stderr.write('Stored token is invalid. Run: tasks login\n');
      }
      process.exitCode = 1;
      return;
    }
    if (meResult.kind === 'network_error') {
      if (isJson) {
        emitJsonEvent({
          event: 'error',
          message: `Could not reach ${server}: ${meResult.message}`,
        });
      } else {
        process.stderr.write(`Could not reach ${server}: ${meResult.message}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (meResult.kind === 'http_error') {
      if (isJson) {
        emitJsonEvent({
          event: 'error',
          message: `Server returned ${meResult.status}`,
        });
      } else {
        process.stderr.write(`Could not reach ${server}: status ${meResult.status}\n`);
      }
      process.exitCode = 1;
      return;
    }

    // /me succeeded. Find the matching token row (if any).
    const me = meResult.body;
    let activeToken: TokenListItem | null = null;
    if (tokensResult.kind === 'ok') {
      activeToken = tokensResult.body.find((t) => t.id === token_id) ?? null;
    } else {
      // Surface the /me/tokens failure as a stderr warning (text mode only;
      // --json mode just omits the token field).
      if (!isJson) {
        process.stderr.write(`(warning: could not list tokens: ${tokensResult.reason})\n`);
      }
    }

    if (isJson) {
      const envelope: Record<string, unknown> = {
        user: {
          id: me.id,
          displayName: me.displayName,
          email: me.email,
          isLegacy: me.isLegacy,
          isServiceAccount: me.isServiceAccount,
        },
        server,
      };
      if (activeToken) {
        envelope['token'] = {
          id: activeToken.id,
          name: activeToken.name,
          lastUsedAt: activeToken.lastUsedAt,
        };
      }
      emitJsonEvent(envelope);
      return;
    }

    // Text mode.
    process.stdout.write(fmtLine('Display name', me.displayName) + '\n');
    process.stdout.write(fmtLine('Email', me.email ?? '(none)') + '\n');
    if (activeToken) {
      process.stdout.write(
        fmtLine('Active token', `${activeToken.name} (id ${activeToken.id})`) + '\n',
      );
      process.stdout.write(fmtLine('Last used', activeToken.lastUsedAt ?? '(never)') + '\n');
    }
    process.stdout.write(fmtLine('Server', server) + '\n');
  });
