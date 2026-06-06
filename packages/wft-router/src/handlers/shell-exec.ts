/**
 * Core action handler: `shell_exec` (task #430).
 *
 * Given a triggered rule, this handler SPAWNS a child process (NEVER a shell),
 * feeds the event payload to it on stdin, and reports a structured
 * {@link HandlerOutcome}. It is the THIRD of the three v1 core handlers and
 * REUSES the shared handler contract (`types.ts`) established by #428 — but it
 * does NOT use the shared HTTP transport (`http-client.ts`): the side-effect is
 * a subprocess invocation, not an HTTP round-trip.
 *
 * Lifecycle for ONE attempt (docs/event-router-design.md §"At-least-once
 * dispatch protocol"):
 *
 *   1. `store.claim(...)` — atomically write a PENDING row keyed on
 *      `(rule_name, event_id)`. If the result is NOT `CLAIMED` the side-effect
 *      is SUPPRESSED (no spawn) and we return a `suppressed` outcome — the
 *      "idempotent replay" guarantee.
 *   2. Read `command` / `argv` / `cwd` / `env` LITERALLY from the rule's `with:`
 *      block. Templating is NOT applied to any of these fields (see SECURITY
 *      §2 below) — the payload reaches the script ONLY via stdin.
 *   3. Build an EXPLICIT env-allowlist (see {@link DEFAULT_ENV_ALLOWLIST}); the
 *      parent `process.env` is NEVER spread wholesale into the child.
 *   4. `spawn(command, argv, { shell: false, cwd, env, stdio })`, write
 *      `JSON.stringify(ctx.event)` to the child's stdin, and end the stream.
 *   5. Wait for exit or timeout, then map to a terminal status + outcome:
 *        exit 0     → SUCCEEDED / { kind: 'succeeded' }
 *        exit != 0  → FAILED    / { kind: 'failed', retryable: true,  ... }
 *        timeout    → FAILED    / { kind: 'failed', retryable: true, 'timed out' }
 *        spawn ENOENT (program not on PATH) → PERMANENTLY_FAILED /
 *                     { kind: 'failed', retryable: false, ... }
 *
 *   Per docs/event-router-design.md §agent_session_dispatch ("non-zero =
 *   failure (triggers retry per max_retries)"), a non-zero exit is RETRYABLE —
 *   the dispatcher (#433) decides whether to actually retry. A spawn ENOENT is
 *   a terminal CONFIG error (the program does not exist); re-trying cannot make
 *   it appear, so it is marked PERMANENTLY_FAILED and reported non-retryable.
 *
 * SECURITY — the distinguishing logic (docs/event-router-design.md §"Subprocess
 * env", §"Threat surface", line 258). Each point is enforced below:
 *
 *   1. `shell: false` ALWAYS. We call `spawn(command, argv, { shell: false })`
 *      with a LITERAL program plus a LITERAL arg array. We NEVER build a
 *      command STRING, never invoke a shell, never use `exec`/`execSync`, and
 *      never concatenate event/task content into `command` or `argv`.
 *   2. NO TEMPLATING of `command` / `argv` / `cwd` / `env`. These are read
 *      verbatim from `ctx.withBlock` (or `ctx.renderedWith`). `renderWith` is
 *      intentionally NOT called on them. This is the injection boundary:
 *      untrusted task content reaches the child ONLY via stdin.
 *   3. EVENT JSON ON STDIN. `JSON.stringify(ctx.event)` is written to the
 *      child's stdin, then the stream is closed. This is the ONLY channel by
 *      which the payload reaches the script.
 *   4. ENV-ALLOWLIST SCRUB. The child env is built as an EXPLICIT object. We
 *      copy ONLY {@link DEFAULT_ENV_ALLOWLIST} entries that are present in the
 *      parent env, then layer the rule's declared `with.env` passthrough
 *      (literal key/values) and the rule's `token_env` (the single named
 *      parent var the rule asked to forward). Because the env is built from an
 *      allowlist — never from a `process.env` spread — `WFT_API_KEY` and every
 *      other rule's `*_token_env` are absent by construction.
 *   5. WORKING-DIR CONFINEMENT. `cwd` comes from `with.cwd` (literal). If unset
 *      it defaults to {@link DEFAULT_CWD} (`process.cwd()`). A non-string /
 *      empty value falls back to the default rather than handing `spawn` an
 *      unusable cwd.
 *
 * Logging: the child is fed verbatim on stdin (delivery is verbatim); only LOG
 * surfaces are redacted. We never log the event payload or child stdout/stderr
 * bodies — only the rule identity, exit code, and a short detail string.
 *
 * Standalone-package isolation: imports ONLY from within
 * `packages/wft-router/src/` plus the `node:child_process` builtin. No
 * root-`src/` reach-in.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file.
 */

import { spawn } from 'node:child_process';

import type { Handler, HandlerContext, HandlerOutcome, SpawnImpl } from './types.js';

/**
 * Default per-attempt timeout (ms) before the child is killed, if the context
 * does not pin `timeoutMs`. A subprocess that hangs past this is SIGTERM'd,
 * then SIGKILL'd after {@link KILL_GRACE_MS}.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Grace period (ms) between the SIGTERM and the follow-up SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/**
 * The DEFAULT env-allowlist: the ONLY parent-process variables copied into the
 * child unless the rule declares more. Documented + unit-tested (AC #3). A var
 * is copied ONLY if it is actually present in the parent env. Anything NOT in
 * this list (notably `WFT_API_KEY` and every other rule's `*_token_env`) is
 * absent from the child by construction — we never spread `process.env`.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TZ',
]);

/** Default working directory when the rule does not declare `with.cwd`. */
export const DEFAULT_CWD = process.cwd();

/**
 * Build the EXPLICIT child env. Never spreads the parent env. Order:
 *   1. allowlisted parent vars that are actually set,
 *   2. the rule's literal `with.env` passthrough (string-coerced),
 *   3. the rule's `token_env` (a single named parent var forwarded by name).
 *
 * `parentEnv` is injected so tests can pin a deterministic parent environment
 * (including sentinel secrets) without mutating the real `process.env`.
 */
export function buildChildEnv(
  renderedEnv: unknown,
  tokenEnv: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Allowlisted parent vars (copy only if present).
  for (const key of allowlist) {
    const value = parentEnv[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }

  // 2. Rule-declared literal passthrough (`with.env`). Coerce non-strings so a
  //    numeric literal still reaches the child.
  if (renderedEnv !== null && typeof renderedEnv === 'object' && !Array.isArray(renderedEnv)) {
    for (const [k, v] of Object.entries(renderedEnv as Record<string, unknown>)) {
      if (v === undefined || v === null) {
        continue;
      }
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }

  // 3. Rule's named token var — forward the PARENT value by name (if present).
  if (typeof tokenEnv === 'string' && tokenEnv.length > 0) {
    const value = parentEnv[tokenEnv];
    if (typeof value === 'string') {
      out[tokenEnv] = value;
    }
  }

  return out;
}

/** Read a literal string `cwd` from the rendered block, else the default. */
function resolveCwd(rendered: Record<string, unknown>): string {
  const value = rendered['cwd'];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return DEFAULT_CWD;
}

/**
 * Read the literal `argv` array from the rendered block as a string[]. Non-array
 * → empty. Non-string elements are string-coerced (defensive — argv MUST be
 * strings for `spawn`). NEVER concatenated into a command string.
 */
function resolveArgv(rendered: Record<string, unknown>): string[] {
  const value = rendered['argv'];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((v) => (typeof v === 'string' ? v : String(v)));
}

/**
 * The `shell_exec` handler. See module header for the full lifecycle +
 * security contract. One attempt, one {@link HandlerOutcome}.
 */
export const shellExec: Handler = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  const { store, logger, identity } = ctx;

  // --- 1. Resolve the rule block (literal — NOT templated for shell_exec). --
  // NOTE: unlike the HTTP handlers, we do NOT call `renderWith`. command/argv/
  // cwd/env reach the child LITERALLY; the payload reaches it only via stdin.
  let block: Record<string, unknown>;
  if (ctx.renderedWith !== undefined) {
    block = ctx.renderedWith;
  } else if (ctx.withBlock !== undefined) {
    block = ctx.withBlock;
  } else {
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id },
      'shell_exec_no_block',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: 'no with: block supplied',
    };
  }

  // The idempotency row persists the literal block JSON (the "rendered" slot;
  // for shell_exec there is no separate render step).
  const blockJson = JSON.stringify(block);

  // --- 2. Claim the dispatch (idempotency gate). ---------------------------
  const claim = store.claim({
    rule_name: identity.rule_name,
    event_id: identity.event_id,
    rendered_with_json: blockJson,
    task_id: identity.task_id,
    to_status: identity.to_status,
    emitted_at_ms: identity.emitted_at_ms,
  });

  if (claim.kind !== 'CLAIMED') {
    const reason = claim.kind === 'ALREADY_PENDING' ? 'already_pending' : 'already_done';
    logger.info(
      { rule_name: identity.rule_name, event_id: identity.event_id, claim: claim.kind },
      'shell_exec_suppressed',
    );
    return { kind: 'suppressed', reason };
  }

  // --- 3. Validate the literal program. ------------------------------------
  const command = block['command'];
  if (typeof command !== 'string' || command.length === 0) {
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id },
      'shell_exec_missing_command',
    );
    return { kind: 'failed', retryable: false, detail: 'with.command is missing or empty' };
  }

  const argv = resolveArgv(block);
  const cwd = resolveCwd(block);
  // Build the scrubbed, explicit child env. WFT_API_KEY / foreign *_token_env
  // are absent by construction (we never spread process.env).
  const env = buildChildEnv(block['env'], ctx.tokenEnv, process.env);

  const spawnFn: SpawnImpl = ctx.spawnImpl ?? spawn;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(ctx.event);

  // --- 4. Spawn + drive the child (one attempt). ---------------------------
  // `shell: false` is MANDATORY: command + argv are passed as a literal program
  // and a literal arg array — never a shell string.
  return await new Promise<HandlerOutcome>((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const clearTimers = (): void => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    };

    let child: ReturnType<SpawnImpl>;
    try {
      child = spawnFn(command, argv, {
        shell: false,
        cwd,
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch (err) {
      // Synchronous spawn throw (rare) — treat like a config error.
      store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
      logger.error(
        {
          rule_name: identity.rule_name,
          event_id: identity.event_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'shell_exec_spawn_threw',
      );
      resolve({ kind: 'failed', retryable: false, detail: 'spawn failed' });
      return;
    }

    const finishFailed = (
      status: 'FAILED' | 'PERMANENTLY_FAILED',
      retryable: boolean,
      detail: string,
      event: string,
      extra: Record<string, unknown> = {},
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      store.complete(identity.rule_name, identity.event_id, status);
      logger.warn({ rule_name: identity.rule_name, event_id: identity.event_id, ...extra }, event);
      resolve({ kind: 'failed', retryable, detail });
    };

    // Arm the timeout → SIGTERM, then SIGKILL after the grace window.
    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err: Error) => {
      // ENOENT (program not on PATH) is a terminal config error → non-retryable.
      const code = (err as NodeJS.ErrnoException).code;
      const terminal = code === 'ENOENT' || code === 'EACCES';
      finishFailed(
        terminal ? 'PERMANENTLY_FAILED' : 'FAILED',
        !terminal,
        terminal ? `spawn ${code ?? 'error'}` : 'spawn error',
        'shell_exec_spawn_error',
        { code: code ?? null },
      );
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        finishFailed('FAILED', true, 'timed out', 'shell_exec_timeout', {
          timeout_ms: timeoutMs,
          signal,
        });
        return;
      }
      clearTimers();
      if (exitCode === 0) {
        settled = true;
        store.complete(identity.rule_name, identity.event_id, 'SUCCEEDED');
        logger.info(
          { rule_name: identity.rule_name, event_id: identity.event_id, exit_code: 0 },
          'shell_exec_succeeded',
        );
        resolve({ kind: 'succeeded' });
        return;
      }
      // Non-zero exit → failure; RETRYABLE (dispatcher decides per max_retries).
      finishFailed(
        'FAILED',
        true,
        `exit code ${exitCode === null ? `signal ${String(signal)}` : String(exitCode)}`,
        'shell_exec_nonzero_exit',
        { exit_code: exitCode, signal },
      );
    });

    // --- Feed the event payload on stdin, then end the stream. -------------
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {
        /* child may exit before draining stdin; the close handler owns outcome. */
      });
      stdin.end(payload);
    }
  });
};
