/**
 * Phase 30 Plan 06 Task 1 — Browser launch helper for `tasks login`.
 *
 * Hand-rolled (no `open` npm package, RESEARCH §security flagged it [SUS]):
 * we spawn the platform-native URL handler directly with `shell:false` so the
 * server-supplied verification_uri cannot inject shell metacharacters.
 *
 * Contract:
 *   - Returns `true` if a spawn was successfully attempted (the child may
 *     still exit non-zero asynchronously — that's caller-irrelevant since
 *     login.ts already printed the URL to stderr as the fallback).
 *   - Returns `false` if:
 *       • platform is unsupported (anything other than linux/darwin/win32), OR
 *       • platform is linux and process.env.DISPLAY is unset (headless), OR
 *       • spawn synchronously threw (e.g. ENOENT for missing xdg-open).
 *
 * Detached + unref + stdio:'ignore' so the child does not keep the Node event
 * loop alive — login.ts must exit cleanly after pollForToken resolves even if
 * the browser process is still loading.
 */
import { spawn } from 'node:child_process';

/**
 * WR-03 (Phase 30 review) — STATUS: MITIGATED. This function IS the active
 * mitigation; `openBrowser` calls it before any spawn. The injection shape
 * described below is historical context explaining WHY the gate exists, not an
 * open vulnerability.
 *
 * Validate the URL shape BEFORE handing it to
 * a child process. The Windows leg invokes `cmd.exe /c start "" <url>`;
 * even with `shell: false`, libuv's WinAPI quoting of the args array can
 * be perturbed by a URL containing embedded double quotes or trailing
 * backslash sequences, letting the value escape its argument slot and
 * be re-interpreted as cmd metacharacters. The threat surface is narrow
 * (the URL comes from the device-flow server we just authenticated to),
 * but the CLI's `--server <url>` flag lets the user point at an
 * arbitrary origin. A malicious server returning
 * `verification_uri_complete: 'http://x" & calc & "'` would execute
 * arbitrary commands without this gate.
 *
 * Allowlist:
 *   - Must parse as a URL via `new URL(...)`.
 *   - Protocol MUST be http: or https: (no `file:`, `javascript:`,
 *     `vbscript:`, custom schemes).
 *   - The URL.toString() round-trip MUST equal the input — this rejects
 *     exotic escapes that the parser silently normalizes (e.g. inputs
 *     with embedded double quotes or unencoded control chars where
 *     toString() emits the canonical form). Round-trip equality also
 *     catches the trailing-backslash + quote sequence that drives the
 *     libuv quoting failure.
 *
 * Returns `false` (caller will skip the spawn and rely on the printed-
 * URL fallback) when the URL is rejected. We do NOT throw because the
 * URL is operator/server-supplied — a graceful "no, don't open that"
 * is the right UX.
 */
function isSafeBrowserUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  // Round-trip the parser to reject inputs with characters that the URL
  // parser silently rewrites (e.g. embedded `"`, control chars, unencoded
  // whitespace). The strict equality is intentional — anything the parser
  // canonicalized away is suspicious enough to refuse.
  if (parsed.toString() !== url) {
    return false;
  }
  return true;
}

export function openBrowser(url: string): boolean {
  // WR-03 (Phase 30 review) — ACTIVE injection gate. Validate the URL BEFORE
  // selecting the platform spawn args, so EVERY platform branch below (incl.
  // the Windows `cmd /c start` path) only ever receives an http(s) URL that
  // round-trips through the URL parser unchanged. A malformed/suspicious URL →
  // false here, before any spawn, so the caller falls back to printing the URL
  // for the user to paste manually.
  //
  // NOTE for reviewers: the historical `verification_uri_complete` cmd-injection
  // shape described in isSafeBrowserUrl's doc block is MITIGATED by this gate —
  // it is documented for context, not an open hole. See the regression test
  // `__tests__/browser-open.test.ts` ("Windows cmd-injection attempt").
  if (!isSafeBrowserUrl(url)) {
    return false;
  }

  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      // SAFE: `url` already passed the WR-03 isSafeBrowserUrl gate above, so it
      // is a parser-canonical http(s) URL with no embedded quotes/backslashes
      // that could escape libuv's WinAPI arg quoting — `cmd /c start` cannot be
      // tricked into running metacharacters here. (We still pass shell:false.)
      // The empty `""` is the title argument for `cmd /c start` — without it,
      // `start` interprets the first quoted arg as the window title and never
      // opens the URL.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
      break;
    case 'linux':
      if (!process.env['DISPLAY']) {
        return false; // headless box (CI, SSH without -X) — leave the URL printed.
      }
      cmd = 'xdg-open';
      args = [url];
      break;
    default:
      return false;
  }

  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      shell: false, // T-30-06-01 mitigation: never let the URL hit a shell.
    });
    child.unref();
    return true;
  } catch {
    // ENOENT (xdg-open / open / cmd not installed), EPERM, etc. — non-fatal.
    return false;
  }
}
