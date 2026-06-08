/**
 * Phase 30 Plan 06 Task 3 — `tasks login` Commander command.
 *
 * Composes the three primitives shipped in Plans 30-05 and 30-06:
 *   - requestDeviceCode + pollForToken (this plan, ../auth/device-flow.ts)
 *   - openBrowser                       (this plan, ../auth/browser-open.ts)
 *   - writeCredentials                  (Plan 30-05, ../auth/credentials.ts)
 *
 * Two output modes:
 *   - text (default): human-friendly messages on stderr, nothing on stdout
 *     (so a shell pipeline like `tasks login && tasks list` won't pollute
 *     stdout with login chrome).
 *   - --json: emits a sequence of newline-separated JSON envelopes on stdout
 *     ({event:'pending'}, {event:'slow_down'}*, {event:'logged_in'|'failed'})
 *     so scripts can drive a programmatic login flow.
 *
 * Security invariants:
 *   - The PAT value (response.token) is NEVER printed to stdout/stderr. The
 *     credentials file is the only place it lives after a successful login.
 *     Subprocess test 9 (login.test.ts) enforces this with a grep over the
 *     combined output.
 *   - The verification_uri is server-supplied. openBrowser spawns with
 *     shell:false so even a hostile URL cannot inject shell metacharacters.
 *   - --token-name is passed through to the server's /auth/device/code body
 *     as `token_name`. v1.6 of the server ignores this and auto-mints
 *     `cli-<hostname>-<date>`; v1.7+ will honor it. Plan-level decision.
 */
import os from 'node:os';
import { Command } from 'commander';
import { env } from '../config/env.js';
import { writeCredentials } from '../auth/credentials.js';
import { openBrowser } from '../auth/browser-open.js';
import { requestDeviceCode, pollForToken, type DeviceTokenSuccess } from '../auth/device-flow.js';
import {
  canUseBrowserSso,
  browserSsoGuidance,
  persistManualPat,
  resolveManualPatToken,
  type ManualPatPersist,
} from '../auth/manual-pat.js';
import type { PromptIO } from '../util/prompt.js';

/** Emit one newline-separated JSON envelope on stdout (used in --json mode). */
function emitJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Inputs to {@link runDeviceLogin}. All values are already resolved/validated by
 * the caller (the `login` command and, in Phase 30 Plan 07+, the setup wizard).
 *
 * - `baseUrl`     — validated server base URL (the caller must `new URL()` it first).
 * - `clientId`    — OIDC client id (`wft-cli` by default).
 * - `hostname`    — local hostname, surfaced to the server for PAT auto-naming.
 * - `tokenName`   — optional advisory PAT name (`--token-name`).
 * - `openBrowser` — when `true`, best-effort auto-open the verification URL.
 * - `isJson`      — when `true`, emit newline-separated JSON envelopes on stdout
 *                   instead of human-friendly text on stderr.
 */
export interface RunDeviceLoginArgs {
  baseUrl: string;
  clientId: string;
  hostname: string;
  tokenName?: string;
  openBrowser: boolean;
  isJson: boolean;
}

/** Outcome of {@link runDeviceLogin}. `ok: false` means the flow already emitted
 *  its failure output; the caller only has to set a non-zero exit code. */
export type RunDeviceLoginResult = { ok: true; user: DeviceTokenSuccess['user'] } | { ok: false };

/**
 * Shared device-login core: request a device code, surface the verification URL
 * + user code, best-effort open the browser, poll until approval, and persist
 * credentials. Behavior (stdout/stderr output, exit semantics, security
 * invariants) is identical to the original inline `login` action — this is the
 * reusable seam consumed by the `login` command and the setup wizard.
 *
 * Does NOT set `process.exitCode`; on failure it returns `{ ok: false }` after
 * emitting the appropriate error output, and the caller decides the exit code.
 */
export async function runDeviceLogin(args: RunDeviceLoginArgs): Promise<RunDeviceLoginResult> {
  const { baseUrl, clientId, hostname, tokenName, openBrowser: shouldOpenBrowser, isJson } = args;

  // 2. Request a device_code from the server.
  let codeResponse;
  try {
    codeResponse = await requestDeviceCode({
      baseUrl,
      clientId,
      hostname,
      ...(tokenName !== undefined ? { tokenName } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) {
      emitJsonEvent({ event: 'failed', error: 'request_failed', message });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return { ok: false };
  }

  // 3. Surface the verification URL + user_code prominently.
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval,
    expires_in,
  } = codeResponse;

  if (isJson) {
    emitJsonEvent({
      event: 'pending',
      verification_uri,
      verification_uri_complete,
      user_code,
      interval,
      expires_in,
    });
  } else {
    // Render a decorative block so the user_code is hard to misread. No
    // ANSI color codes — copy-paste must survive piping through `tee` or
    // a non-color terminal. The width is sized to fit `XXXX-XXXX` + 3 char
    // padding either side (8 letters + dash + 6 spaces = 15; plus 2 borders).
    const spaced = user_code.split('').join(' ');
    const inner = `   ${spaced}   `;
    const horiz = '─'.repeat(inner.length);
    process.stderr.write('\n');
    process.stderr.write(`Visit: ${verification_uri_complete}\n`);
    process.stderr.write('\n');
    process.stderr.write(`┌${horiz}┐\n`);
    process.stderr.write(`│${inner}│\n`);
    process.stderr.write(`└${horiz}┘\n`);
    process.stderr.write('\n');
    process.stderr.write('Waiting for approval...\n');
  }

  // 4. Best-effort browser launch (skipped if !openBrowser).
  if (shouldOpenBrowser) {
    const opened = openBrowser(verification_uri_complete);
    if (!isJson) {
      if (opened) {
        process.stderr.write('(Opening browser...)\n');
      } else {
        process.stderr.write('(Could not auto-open browser. Open the URL above manually.)\n');
      }
    }
  }

  // 5. Poll until the user approves (or a terminal error fires).
  const result = await pollForToken({
    baseUrl,
    deviceCode: device_code,
    clientId,
    initialInterval: interval,
    expiresIn: expires_in,
    onEvent: (e) => {
      if (isJson) {
        emitJsonEvent({ event: e.kind, interval: e.interval });
      } else {
        // Lightweight text-mode progress: one dot per pending poll. Stays
        // quiet on slow_down so the user can see if pace ever changes.
        if (e.kind === 'pending') {
          process.stderr.write('.');
        }
      }
    },
  });

  if (!isJson) {
    // Newline after any pending-dot stream so the next line is clean.
    process.stderr.write('\n');
  }

  // 6. Dispatch on result.
  if (result.kind === 'terminal_error') {
    if (isJson) {
      emitJsonEvent({
        event: 'failed',
        error: result.error,
        message: result.message,
      });
    } else {
      process.stderr.write(`${result.message}\n`);
    }
    return { ok: false };
  }

  // result.kind === 'ok' — persist credentials.
  const { response } = result;
  try {
    writeCredentials({
      active: {
        token: response.token,
        token_id: response.token_id,
        server: baseUrl,
        user_id: response.user.id,
        display_name: response.user.displayName,
        email: response.user.email,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? `Failed to write credentials file: ${err.message}`
        : 'Failed to write credentials file.';
    if (isJson) {
      emitJsonEvent({ event: 'failed', error: 'write_failed', message });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return { ok: false };
  }

  if (isJson) {
    emitJsonEvent({
      event: 'logged_in',
      user: response.user,
      token_id: response.token_id,
    });
  } else {
    process.stderr.write(`Logged in as ${response.user.displayName}\n`);
  }

  return { ok: true, user: response.user };
}

/**
 * Inputs to {@link runManualPatLogin} (task #857). Mirrors {@link RunDeviceLoginArgs}
 * for the parts the command shares (baseUrl, isJson).
 */
export interface RunManualPatLoginArgs {
  /** Validated server base URL. */
  baseUrl: string;
  /** Explicit PAT (`--token <pat>`); when absent, prompt on a TTY. */
  token?: string;
  /** When true, emit newline-separated JSON envelopes on stdout (vs text on stderr). */
  isJson: boolean;
  /** Injectable prompt IO (tests). Defaults to process.stdin/stdout. */
  promptIO?: PromptIO;
  /** Injectable TTY predicate (tests). Defaults to the real shouldPrompt. */
  isInteractive?: () => boolean;
  /** Injectable persistence seam (tests). Defaults to {@link persistManualPat}. */
  manualPatPersist?: ManualPatPersist;
}

/**
 * Manual-PAT login core (task #857): the parity-with-`tasks setup` path that
 * lets `tasks login` finish on a server where browser SSO can't complete (a
 * plain-http / LAN-IP server the IdP rejects), or whenever the user supplies a
 * PAT directly.
 *
 * Behavior:
 *   1. If browser SSO can't complete against `baseUrl` AND no `--token` was
 *      supplied, print the same https-required / mint-a-PAT guidance `setup`
 *      shows (shared via {@link browserSsoGuidance}).
 *   2. Resolve the PAT: `--token` flag → interactive `promptSecret` (TTY only).
 *   3. Validate + persist via {@link persistManualPat} — the SAME credentials
 *      writer the device flow uses, so `tasks whoami` / the API client / the MCP
 *      bridge all see the credential afterward.
 *
 * Security invariant (matches the device path): the PAT is NEVER written to
 * stdout/stderr — the credentials file is its only resting place.
 */
export async function runManualPatLogin(
  args: RunManualPatLoginArgs,
): Promise<RunDeviceLoginResult> {
  const { baseUrl, isJson } = args;
  const hasToken = typeof args.token === 'string' && args.token.length > 0;

  // Explain the https requirement up front when the user reached for `login`
  // on a server browser SSO can't complete against and gave us no PAT to use.
  if (!hasToken && !canUseBrowserSso(baseUrl) && !isJson) {
    for (const line of browserSsoGuidance(baseUrl)) {
      process.stderr.write(`${line}\n`);
    }
  }

  const token = await resolveManualPatToken({
    ...(args.token !== undefined && { token: args.token }),
    ...(args.promptIO !== undefined && { promptIO: args.promptIO }),
    ...(args.isInteractive !== undefined && { isInteractive: args.isInteractive }),
    promptLabel: 'Paste a personal access token: ',
  });

  if (token === undefined) {
    const message = 'No personal access token supplied. Re-run with --token <pat> to finish login.';
    if (isJson) {
      emitJsonEvent({ event: 'failed', error: 'no_token', message });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return { ok: false };
  }

  const persist = args.manualPatPersist ?? persistManualPat;
  const persisted = await persist(baseUrl, token);
  if (!persisted.ok) {
    const message = `Could not store the personal access token: ${persisted.reason}.`;
    if (isJson) {
      emitJsonEvent({ event: 'failed', error: 'pat_rejected', message });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return { ok: false };
  }

  const user = {
    id: persisted.identity.id,
    displayName: persisted.identity.displayName,
    email: persisted.identity.email,
  } as DeviceTokenSuccess['user'];

  if (isJson) {
    emitJsonEvent({
      event: 'logged_in',
      user,
      token_id: persisted.identity.tokenId ?? null,
    });
  } else {
    process.stderr.write(`Logged in as ${persisted.identity.displayName}\n`);
  }
  return { ok: true, user };
}

export const loginCommand = new Command('login')
  .description('Authenticate with the WFT server via OAuth device flow')
  .option(
    '--token-name <name>',
    'Name for the minted PAT (currently advisory; reserved for v1.7 explicit naming)',
  )
  .option(
    '--token <pat>',
    'Authenticate with a personal access token instead of the browser device flow (required for remote non-https servers where Google SSO cannot complete). The PAT is validated against the server and stored in the credentials file.',
  )
  .option('--no-browser', 'Skip auto-opening the verification URL in a browser')
  .option(
    '--server <url>',
    'Override API_BASE_URL for this invocation (stored in credentials file)',
  )
  .action(async (opts) => {
    // Read --json from the GLOBAL program options (the flag is registered on
    // the root program in src/cli/bin/{tasks,tasks-client}.ts).
    const program = loginCommand.parent;
    const globalOpts = program?.optsWithGlobals() ?? {};
    const isJson: boolean = globalOpts['json'] === true;

    // 1. Validate base URL.
    const baseUrl: string = opts.server ?? env.API_BASE_URL;
    try {
      // eslint-disable-next-line no-new
      new URL(baseUrl);
    } catch {
      const msg = `Invalid server URL: ${baseUrl}`;
      if (isJson) {
        emitJsonEvent({ event: 'failed', error: 'invalid_url', message: msg });
      } else {
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 1;
      return;
    }

    // `--token` may bind to EITHER the login command (when written as
    // `tasks login --token <pat>`) or the root program's Bearer-auth flag (when
    // written as `tasks --token <pat> login`). Accept both so the manual-PAT
    // login path works regardless of where Commander attached it.
    const token: string | undefined =
      typeof opts.token === 'string' && opts.token.length > 0
        ? opts.token
        : (globalOpts['token'] as string | undefined);
    const hasToken = typeof token === 'string' && token.length > 0;

    // 2. Choose the login path (task #857):
    //   - manual-PAT when the user supplied a PAT, OR when browser SSO can't
    //     complete against this server (plain-http non-localhost — Google
    //     rejects the non-https OAuth redirect, so the device flow dead-ends).
    //   - device flow otherwise (the default for https / localhost servers).
    if (hasToken || !canUseBrowserSso(baseUrl)) {
      const result = await runManualPatLogin({
        baseUrl,
        ...(token !== undefined && { token }),
        isJson,
      });
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }

    const clientId: string = process.env['OIDC_CLIENT_ID'] ?? 'wft-cli';
    const hostname: string = os.hostname();

    // Delegate to the shared device-login core. Commander generates
    // `opts.browser = false` for --no-browser.
    const result = await runDeviceLogin({
      baseUrl,
      clientId,
      hostname,
      tokenName: opts.tokenName,
      openBrowser: opts.browser !== false,
      isJson,
    });

    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    // Implicit exit 0 — process.exitCode stays default.
  });
