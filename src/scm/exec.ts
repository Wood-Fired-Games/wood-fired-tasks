/**
 * `exec.ts` — the repo's FIRST `child_process` wrapper, and the single place
 * SCM subprocesses are spawned (§6.1 of the pluggable-SCM design spec). Every
 * adapter (`git-adapter.ts`, `perforce-adapter.ts`, …) routes its shell-outs
 * through {@link execScm}; nothing else in the codebase spawns `git`/`p4`/`gh`.
 *
 * Because it is a new attack/bug surface, the §6.1 safety contract is enforced
 * here, not left to callers:
 *
 * - **argv-array only** — `spawn(..., { shell: false })`. Args ride as discrete
 *   entries; there is no code path that concatenates caller text into a shell
 *   string, so hostile filenames (`$(rm -rf).txt`, `--not-a-flag`) pass through
 *   literally and are never evaluated.
 * - **Binary allowlist** — only `git`, `p4`, `gh`. `argv[0]` containing a path
 *   separator is rejected (no `/usr/bin/git`, no `./git`).
 * - **cwd pinned** — every call MUST supply the resolved repo root.
 * - **Timeouts** — default 60s (submit/push callers pass 300s). On expiry the
 *   child gets SIGTERM, then SIGKILL after a grace window; the call rejects with
 *   `ScmError('TIMEOUT', …)` which the CLI maps to exit 124.
 * - **Output caps** — stdout/stderr capture is bounded (default 10 MB); an
 *   overflowing command is killed and the call fails cleanly rather than OOMing.
 * - **Env hygiene** — child env = parent env minus {@link ENV_DENYLIST}
 *   (`P4PASSWD`); no env var is interpolated into argv, and `P4PASSWD=` patterns
 *   are scrubbed from all captured output / error messages before they leave.
 * - **Non-interactive** — stdin is `ignore`d; a prompting command hits the
 *   timeout instead of hanging the loop.
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md` §6.1.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ScmError } from './types.js';

/** The only binaries {@link execScm} will spawn (§6.1 binary allowlist). */
export const ALLOWED_BINARIES = ['git', 'p4', 'gh'] as const;
export type ScmBinary = (typeof ALLOWED_BINARIES)[number];

/** Default per-command timeout (§6.1). Submit/push call-sites override to 300s. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Default combined stdout/stderr capture ceiling (§6.1). */
export const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL when a command is force-killed (§6.1). */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Env vars removed from the child environment before spawn (§6.1 env hygiene).
 * `P4PASSWD` must never reach a child process nor be logged; matching is
 * case-insensitive so a lower-cased shadow can't sneak the secret through.
 */
export const ENV_DENYLIST = ['P4PASSWD'] as const;

const PATH_SEPARATOR_RE = /[/\\]/;
const SECRET_SCRUB_RE = /P4PASSWD=\S*/gi;

/**
 * Mask `P4PASSWD=<value>` occurrences before any captured output or error
 * message leaves the wrapper (§6.1). The value is never legitimate parseable
 * output, so masking the fixed token is always safe.
 */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET_SCRUB_RE, 'P4PASSWD=***');
}

/**
 * Build the child environment: the parent env minus {@link ENV_DENYLIST}
 * (§6.1). No value is ever interpolated into argv — this is the only channel
 * by which parent env reaches the child, and the denylist is applied here.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const deny = new Set(ENV_DENYLIST.map((k) => k.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (deny.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Escalate a kill: SIGTERM immediately, then SIGKILL after `graceMs` if the
 * child has not exited (§6.1). Exported so the escalation ladder can be
 * exercised in isolation against a process that ignores SIGTERM — testing this
 * helper directly does NOT route through {@link execScm}'s allowlist, so it
 * opens no production hole.
 */
export function escalateKill(child: ChildProcess, graceMs: number = DEFAULT_KILL_GRACE_MS): void {
  let exited = false;
  let timer: NodeJS.Timeout;
  child.once('exit', () => {
    exited = true;
    clearTimeout(timer);
  });
  child.kill('SIGTERM');
  timer = setTimeout(() => {
    if (!exited) child.kill('SIGKILL');
  }, graceMs);
  timer.unref?.();
}

export interface ExecScmOptions {
  /** Pinned repo root — every call runs from here (§6.1 cwd-pinned). Required. */
  cwd: string;
  /** Per-command timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Combined stdout/stderr cap in bytes. Defaults to {@link DEFAULT_MAX_BUFFER_BYTES}. */
  maxBufferBytes?: number;
  /** SIGTERM→SIGKILL grace in ms. Defaults to {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
  /**
   * Optional buffer piped to the child's stdin, then the stdin stream is
   * closed. Scoped for p4 form-piping (`p4 change -o | p4 change -i`, task
   * #1555) — NOT a general interactive-prompting escape hatch: the write is
   * finite and stdin closes immediately after, so a command that tries to
   * prompt for more input past this buffer still hits the timeout instead of
   * hanging. When omitted, stdin stays `'ignore'` — byte-identical to the
   * pre-existing behavior (§6.1 non-interactive contract).
   */
  stdinData?: string;
}

/**
 * Structured outcome of a completed (possibly non-zero) command. A non-zero
 * exit is NOT thrown — it is surfaced here so the adapter can map it to the
 * appropriate {@link ScmError} with verb context. Only wrapper-contract
 * violations (timeout, output overflow, spawn failure, allowlist rejection)
 * reject the returned promise.
 */
export interface ExecScmResult {
  binary: ScmBinary;
  args: readonly string[];
  /** Process exit code, or `null` when terminated by a signal. */
  code: number | null;
  /** Terminating signal, or `null` on a normal exit. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn an allowlisted SCM binary with the full §6.1 safety contract enforced.
 *
 * Resolves with an {@link ExecScmResult} for any command that runs to
 * completion (including non-zero exits). Rejects with:
 * - `ScmError('TIMEOUT', …)` when the command exceeds `timeoutMs`,
 * - `ScmError('BACKEND_UNAVAILABLE', …)` when the binary is missing from PATH,
 * - a plain `Error` for output-cap overflow, allowlist rejection, or a
 *   path-like `argv[0]`.
 */
export function execScm(
  binary: string,
  args: readonly string[],
  opts: ExecScmOptions,
): Promise<ExecScmResult> {
  if (PATH_SEPARATOR_RE.test(binary)) {
    return Promise.reject(
      new Error(`execScm: binary must be a bare name, got path-like "${binary}"`),
    );
  }
  if (!(ALLOWED_BINARIES as readonly string[]).includes(binary)) {
    return Promise.reject(
      new Error(`execScm: "${binary}" is not in the allowlist [${ALLOWED_BINARIES.join(', ')}]`),
    );
  }
  if (!opts || !opts.cwd) {
    return Promise.reject(new Error('execScm: opts.cwd (pinned repo root) is required'));
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<ExecScmResult>((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: buildChildEnv(),
      // stdin is 'ignore' unless opts.stdinData is set, in which case it is
      // 'pipe' so the buffer below can be written and the stream closed. A
      // prompting command still hits the timeout instead of hanging, since
      // no further input ever arrives either way.
      stdio: opts.stdinData === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // Own process group so a force-kill reaches grandchildren (e.g. a git
      // editor/credential helper). Otherwise an orphaned grandchild keeps the
      // stdio pipes open and delays `close` past the timeout deadline.
      detached: process.platform !== 'win32',
    };

    const child = spawn(binary, [...args], spawnOpts);

    if (opts.stdinData !== undefined) {
      child.stdin?.end(opts.stdinData);
    }

    /**
     * Signal the child's whole process group when possible so grandchildren
     * die with it; fall back to a direct kill if the group is already gone or
     * group signalling is unsupported (Windows).
     */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // Group already reaped — fall through to a direct kill.
      }
      child.kill(signal);
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      graceTimer = setTimeout(() => killTree('SIGKILL'), killGraceMs);
      graceTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxBufferBytes) {
        overflow = true;
        killTree('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stderrLen += chunk.length;
      if (stderrLen > maxBufferBytes) {
        overflow = true;
        killTree('SIGKILL');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const msg = scrubSecrets(err.message);
      if (err.code === 'ENOENT') {
        reject(
          new ScmError(
            'BACKEND_UNAVAILABLE',
            `${binary} binary not found on PATH: ${msg}`,
            `Install ${binary} or ensure it is on PATH.`,
          ),
        );
        return;
      }
      reject(new Error(`execScm: failed to spawn ${binary}: ${msg}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (timedOut) {
        reject(
          new ScmError(
            'TIMEOUT',
            `${binary} exceeded the ${timeoutMs}ms timeout and was terminated`,
            'Raise the per-call timeout or check for an interactive prompt (login, credential helper).',
          ),
        );
        return;
      }
      if (overflow) {
        reject(
          new Error(
            `execScm: ${binary} output exceeded the ${maxBufferBytes}-byte cap and was terminated`,
          ),
        );
        return;
      }

      resolve({
        binary: binary as ScmBinary,
        args,
        code,
        signal,
        stdout: scrubSecrets(Buffer.concat(stdoutChunks).toString('utf8')),
        stderr: scrubSecrets(Buffer.concat(stderrChunks).toString('utf8')),
      });
    });
  });
}
