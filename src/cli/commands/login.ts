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
import { requestDeviceCode, pollForToken } from '../auth/device-flow.js';

/** Emit one newline-separated JSON envelope on stdout (used in --json mode). */
function emitJsonEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

export const loginCommand = new Command('login')
  .description('Authenticate with the WFT server via OAuth device flow')
  .option(
    '--token-name <name>',
    'Name for the minted PAT (currently advisory; reserved for v1.7 explicit naming)',
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

    const clientId: string = process.env['OIDC_CLIENT_ID'] ?? 'wft-cli';
    const hostname: string = os.hostname();

    // 2. Request a device_code from the server.
    let codeResponse;
    try {
      codeResponse = await requestDeviceCode({
        baseUrl,
        clientId,
        hostname,
        tokenName: opts.tokenName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson) {
        emitJsonEvent({ event: 'failed', error: 'request_failed', message });
      } else {
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
      return;
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

    // 4. Best-effort browser launch (skipped if --no-browser).
    // Commander generates `opts.browser = false` for --no-browser.
    if (opts.browser !== false) {
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
      process.exitCode = 1;
      return;
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
      process.exitCode = 1;
      return;
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
    // Implicit exit 0 — process.exitCode stays default.
  });
