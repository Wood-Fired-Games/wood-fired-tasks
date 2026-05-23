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

export function openBrowser(url: string): boolean {
  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      // The empty `""` is the title argument for `cmd /c start` — without it,
      // `start` interprets the first quoted arg as the window title and never
      // opens the URL.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
      break;
    case 'linux':
      if (!process.env.DISPLAY) {
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
