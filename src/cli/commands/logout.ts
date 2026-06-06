/**
 * Phase 30 Plan 30-07 Task 1 — `tasks logout` Commander command.
 *
 * Two-step logout, in order:
 *
 *   1. DELETE ${active.server}/api/v1/me/tokens/active with Bearer auth from
 *      the credentials file. The server (src/api/routes/me/tokens.ts:410)
 *      responds 204 on success, 401 if the token is already invalid, and a
 *      handful of other statuses on edge cases.
 *
 *   2. Whatever the server's verdict, delete the local credentials file
 *      (Plan 30-05's `deleteCredentials`). The local-side intent —
 *      "this machine no longer logs in" — is satisfied regardless of
 *      whether the server-side revoke landed; the warning text tells the
 *      user how to manually revoke a stranded token if it didn't.
 *
 * Idempotency: running `tasks logout` with no credentials file is NOT an
 * error. We print 'Not logged in' to stderr and exit 0. This matches POSIX
 * convention (`rm -f` on a missing file is also exit 0) and means CI
 * pipelines can call logout unconditionally during teardown.
 *
 * Security invariants:
 *   - The PAT value (`creds.active.token`) is NEVER printed to stdout/stderr.
 *     The only place it appears in code is the `Authorization` header
 *     construction. Subprocess test 9 (logout.test.ts) enforces this with a
 *     grep over the combined output.
 *   - The 10-second AbortController timeout (T-30-07-04) caps the DELETE
 *     call so a hung server cannot keep the CLI alive indefinitely.
 */
import { Command } from 'commander';
import { readCredentials, deleteCredentials } from '../auth/credentials.js';

/** Emit one newline-separated JSON envelope on stdout (used in --json mode). */
function emitJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Attempt the server-side revoke. Returns a discriminated result so the
 * caller can decide on the local-side cleanup + user-facing message.
 */
type RevokeResult =
  | { kind: 'revoked' }
  | { kind: 'already_invalid' }
  | { kind: 'http_error'; status: number; snippet: string }
  | { kind: 'network_error'; message: string };

async function revokeServerSide(server: string, token: string): Promise<RevokeResult> {
  const url = `${server}/api/v1/me/tokens/active`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 204) return { kind: 'revoked' };
    if (res.status === 401) return { kind: 'already_invalid' };
    // Read a small snippet of the body for diagnostics (capped to avoid
    // dumping arbitrary server payloads into the user's terminal).
    let snippet = '';
    try {
      const body = await res.text();
      snippet = body.slice(0, 160);
    } catch {
      // ignore — the message is informational only
    }
    return { kind: 'http_error', status: res.status, snippet };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'network_error', message };
  } finally {
    clearTimeout(timer);
  }
}

export const logoutCommand = new Command('logout')
  .description('Revoke the active PAT and remove local credentials')
  .action(async () => {
    const program = logoutCommand.parent;
    const globalOpts = program?.optsWithGlobals() ?? {};
    const isJson: boolean = globalOpts['json'] === true;

    // 1. Read credentials. If absent, this is idempotent — exit 0 with a
    //    friendly note. We use readCredentials() directly (not resolveAuth)
    //    because logout is specifically about the on-disk file, not the
    //    broader auth-precedence chain.
    const creds = readCredentials();
    if (creds === null) {
      if (isJson) {
        emitJsonEvent({
          event: 'logged_out',
          revoked: false,
          alreadyLoggedOut: true,
        });
      } else {
        process.stderr.write('Not logged in\n');
      }
      return;
    }

    const { server, token, token_id } = creds.active;

    // 2. Try the server-side revoke. Outcome controls only the user-facing
    //    message — local cleanup runs unconditionally below.
    const result = await revokeServerSide(server, token);

    // 3. Local cleanup. Always run, regardless of `result.kind`.
    deleteCredentials();

    // 4. Dispatch on outcome.
    if (result.kind === 'revoked') {
      if (isJson) {
        emitJsonEvent({
          event: 'logged_out',
          revoked: true,
          tokenId: token_id,
        });
      } else {
        process.stderr.write('Logged out\n');
      }
      return;
    }

    if (result.kind === 'already_invalid') {
      if (isJson) {
        emitJsonEvent({
          event: 'logged_out',
          revoked: false,
          tokenId: token_id,
          warning: 'token was already invalid',
        });
      } else {
        process.stderr.write('Logged out (server-side token was already invalid)\n');
      }
      return;
    }

    if (result.kind === 'http_error') {
      // 5xx = the server tried but failed → treat as a "stranded token"
      // case and surface the token id + manual-revoke guidance (PLAN
      // truth: 5xx + network error share the same recovery message).
      // 4xx (other than 401) = the request was malformed somehow → still
      // delete the local file but show the status + body snippet so the
      // user has something to report.
      if (result.status >= 500) {
        const warning = `server-side revoke failed: status ${result.status}`;
        if (isJson) {
          emitJsonEvent({
            event: 'logged_out',
            revoked: false,
            tokenId: token_id,
            warning,
          });
        } else {
          process.stderr.write(
            'Local credentials cleared, but server-side revoke failed. ' +
              `The token may still be valid. Use the web UI to revoke token ` +
              `id ${token_id} after re-authenticating.\n`,
          );
        }
        return;
      }
      const warning = `status ${result.status}${result.snippet ? `: ${result.snippet}` : ''}`;
      if (isJson) {
        emitJsonEvent({
          event: 'logged_out',
          revoked: false,
          tokenId: token_id,
          warning,
        });
      } else {
        process.stderr.write(
          `Local credentials cleared. Server returned ${result.status}` +
            (result.snippet ? `: ${result.snippet}` : '') +
            '\n',
        );
      }
      return;
    }

    // network_error
    const warning = `server-side revoke failed: ${result.message}`;
    if (isJson) {
      emitJsonEvent({
        event: 'logged_out',
        revoked: false,
        tokenId: token_id,
        warning,
      });
    } else {
      process.stderr.write(
        'Local credentials cleared, but server-side revoke failed. ' +
          `The token may still be valid. Use the web UI to revoke token ` +
          `id ${token_id} after re-authenticating.\n`,
      );
    }
  });
