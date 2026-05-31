/**
 * Core action handler: `agent_session_dispatch` (task #431).
 *
 * The FOURTH v1 core handler. Where `shell_exec` (#430) spawns an
 * operator-declared program verbatim, `agent_session_dispatch` is a
 * VENDOR-NEUTRAL session dispatcher: it invokes a user-supplied **adapter
 * executable** — resolved by basename from a configured adapters-path — and
 * lets that adapter bridge the event onto whatever runtime sits behind it (a
 * persistent local session, an `ssh`/`container-exec` push, a control socket,
 * a scheduled-task trigger, …). The handler is AGNOSTIC to that runtime; it
 * speaks only the adapter contract below.
 *
 * It REUSES the shared handler contract (`types.ts`, #428) and the subprocess
 * machinery established by `shell_exec` (#430) — notably the exported
 * {@link buildChildEnv} env-scrub and the `spawn(..., {shell:false})` +
 * stdin-feed + timeout-kill pattern. It does NOT use the HTTP transport.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADAPTER CONTRACT (docs/event-router-design.md §"agent_session_dispatch —
 * extension contract"). Implemented EXACTLY here; AC #3 lives in this header.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. ADAPTER SELECTION + RESOLUTION.
 *    - `with.adapter` (a string) names the adapter and MUST match
 *      {@link ADAPTER_NAME_RE} (`^[a-z][a-z0-9_-]*$`). The regex forbids `/`,
 *      `\`, `.` and `..`, so an adapter name can NEVER contain a path
 *      separator or traverse out of an adapters dir. A non-matching name is a
 *      TERMINAL config error → PERMANENTLY_FAILED, non-retryable.
 *    - The adapter is resolved by BASENAME against the entries of the
 *      adapters-path. The adapters-path comes from `ctx.adaptersPath` (an
 *      injected list, used by tests) if present, otherwise from the
 *      `$WFT_ROUTER_ADAPTERS_PATH` env var split on the OS path-list
 *      separator (`path.delimiter`). The DEFAULT is EMPTY — adapters must be
 *      explicitly opted in. An empty adapters-path means NO adapter resolves,
 *      so every dispatch terminates as "adapter not found / not opted in"
 *      (PERMANENTLY_FAILED, non-retryable).
 *    - PATH SECURITY. For each adapters-path entry the candidate is
 *      `join(entry, adapter)`. The candidate must (a) exist as a regular
 *      file, and (b) after `fs.realpathSync` its real location MUST still live
 *      DIRECTLY inside the (realpath'd) entry — a symlink whose target escapes
 *      the adapters dir is REFUSED. The first entry that yields a valid file
 *      wins. If none do → PERMANENTLY_FAILED, non-retryable.
 *    - DIRECTORY HARDENING. Each adapters-path entry SHOULD be a directory
 *      owned by the router user with mode ≤ 0755. We perform a cheap
 *      `fs.statSync` and SKIP an entry that is (a) world/group-writable
 *      (mode & 0o022) or (b) NOT owned by the router process uid, so a dir
 *      planted by another user cannot supply an adapter even if its mode looks
 *      benign. The ownership skip is POSIX-only: `process.getuid` is absent on
 *      Windows (ACL-based; `st.uid` is not meaningful), so there we keep the
 *      mode-only posture and ownership stays a documented deployment
 *      requirement.
 *
 * 2. ARGV (TEMPLATED — this differs from `shell_exec`).
 *    - The rule's `with:` block is rendered via `renderWith` (untrusted task
 *      content IS substituted into the VALUES here, unlike `shell_exec`).
 *    - For EVERY rendered `with:` key OTHER than `adapter`, ONE argv element of
 *      the form `key=value` is passed, where `value` is the rendered template
 *      result (string-coerced). Key names MUST match {@link WITH_KEY_RE}
 *      (`^[a-z][a-z0-9_]*$`); a bad key is a TERMINAL config error.
 *    - Because each pair is a SINGLE argv element (never split on whitespace,
 *      never concatenated into a command string), a malicious rendered value
 *      can NOT inject extra argv entries. THAT is the injection boundary.
 *      Example: `with: {adapter: local-command, target: my-project,
 *      prompt: "epic {{task.id}} closed"}` with `task.id === 42`
 *      → argv `['target=my-project', 'prompt=epic 42 closed']`.
 *
 * 3. STDIN. `JSON.stringify(ctx.event)` is written to the child's stdin, then
 *    the stream is ended. The event payload reaches the adapter ONLY via
 *    stdin — never via command-substitution into argv.
 *
 * 4. ENV. Scrubbed via the shared {@link buildChildEnv}: the default
 *    allowlist (PATH/HOME/USER/LANG/TZ) plus the rule's `token_env` plus the
 *    rule's explicit `with.env` passthrough. `WFT_API_KEY` and every other
 *    rule's `*_token_env` are ABSENT by construction (the env is built from an
 *    allowlist, never a `process.env` spread).
 *
 * 5. OUTPUT / EXIT CONTRACT.
 *    - exit 0  → SUCCESS. SUCCEEDED row. The adapter MAY print a SESSION
 *      IDENTIFIER on stdout; the handler captures it (trimmed, first line,
 *      capped at {@link MAX_SESSION_ID_LEN}) and surfaces it — see AC #4.
 *    - exit != 0 → FAILURE → complete(FAILED), RETRYABLE (the dispatcher #433
 *      owns retry per `max_retries`).
 *    - Adapter-missing / bad-adapter-name / bad-with-key / path-escape →
 *      TERMINAL config error → complete(PERMANENTLY_FAILED), non-retryable.
 *    - timeout → child is SIGTERM'd then SIGKILL'd → complete(FAILED),
 *      retryable.
 *
 * AC #4 — "session id round-trips through the idempotency store". The
 * IdempotencyStore schema is SHARED + shipped (#424/#425) and MUST NOT change.
 * The session id is only known AFTER the adapter exits (it is printed on
 * stdout), whereas `store.claim(...)` runs BEFORE the spawn — so it cannot go
 * into the claimed row without a schema change. The chosen non-breaking
 * interpretation: capture the adapter's stdout session id and surface it (a) in
 * the additive, optional `HandlerOutcome.sessionId` field and (b) in the
 * structured (redacted) success log. The store round-trip itself is the
 * existing claim→complete lifecycle: the (rule, event) row transitions
 * PENDING→SUCCEEDED, and the session id rides alongside that terminal outcome.
 * The test asserts both surfaces AND the SUCCEEDED store row.
 *
 * SECURITY summary: `shell: false` ALWAYS; no `exec`/`execSync`; argv built
 * ONLY as `key=value` elements; adapter resolution rejects path separators
 * (regex) + symlink escapes (realpath confinement); the child env is an
 * explicit allowlist, never a `process.env` spread; the event reaches the
 * adapter only on stdin. Adapters themselves MUST NOT `eval` argv, MUST treat
 * argv values as untrusted, MUST NOT expand env-vars from event content, and
 * SHOULD validate length/charset before use (documented adapter requirement).
 *
 * Standalone-package isolation: imports ONLY from within
 * `packages/wft-router/src/` plus `node:` builtins. No root-`src/` reach-in.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { renderWith } from '../dispatch/index.js';
import { redactForLogging } from '../util/redaction.js';
import { buildChildEnv } from './shell-exec.js';
import type {
  Handler,
  HandlerContext,
  HandlerOutcome,
  SpawnImpl,
} from './types.js';

/** Default per-attempt timeout (ms) before the adapter child is killed. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Grace period (ms) between the SIGTERM and the follow-up SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/** UTF-8 char cap on a captured session id (defensive; adapters are untrusted). */
export const MAX_SESSION_ID_LEN = 512;

/**
 * Allowed adapter NAME shape. Forbids `/`, `\`, `.`, `..` and uppercase —
 * which means an adapter name can never contain a path separator or traverse.
 */
export const ADAPTER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Allowed `with:` KEY shape for the argv `key=value` pairs. */
export const WITH_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** The env var holding the OS-path-list of adapter directories (default empty). */
export const ADAPTERS_PATH_ENV = 'WFT_ROUTER_ADAPTERS_PATH';

/**
 * Resolve the adapters-path entries. Precedence: injected `ctx.adaptersPath`
 * (used by tests) over `$WFT_ROUTER_ADAPTERS_PATH`. Default: EMPTY — adapters
 * are opt-in. Empty/blank entries are dropped.
 */
export function resolveAdaptersPath(
  injected: readonly string[] | undefined,
  parentEnv: NodeJS.ProcessEnv,
): string[] {
  if (injected !== undefined) {
    return injected.filter((e) => typeof e === 'string' && e.length > 0);
  }
  const raw = parentEnv[ADAPTERS_PATH_ENV];
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  return raw.split(path.delimiter).filter((e) => e.length > 0);
}

/**
 * Resolve an adapter NAME to an absolute executable path, enforcing the
 * path-security contract (basename-only, regular file, realpath confinement,
 * best-effort dir-mode hardening). Returns `null` when no entry yields a valid
 * adapter (adapter-not-found / not-opted-in / escapes its dir).
 */
export function resolveAdapter(
  adapter: string,
  entries: readonly string[],
): string | null {
  for (const entry of entries) {
    let entryReal: string;
    try {
      const st = fs.statSync(entry);
      if (!st.isDirectory()) {
        continue;
      }
      // Hardening: skip a group/world-writable adapters dir.
      if ((st.mode & 0o022) !== 0) {
        continue;
      }
      // Hardening (POSIX only): skip a dir not owned by the router uid so a
      // dir planted by another user cannot supply an adapter. `getuid` is
      // undefined on Windows, where st.uid is not meaningful — fall back to
      // the mode-only check there.
      const routerUid = process.getuid?.();
      if (routerUid !== undefined && st.uid !== routerUid) {
        continue;
      }
      entryReal = fs.realpathSync(entry);
    } catch {
      continue;
    }

    const candidate = path.join(entry, adapter);
    let candidateReal: string;
    let isFile: boolean;
    try {
      candidateReal = fs.realpathSync(candidate);
      isFile = fs.statSync(candidateReal).isFile();
    } catch {
      continue;
    }
    if (!isFile) {
      continue;
    }
    // Confinement: the resolved file MUST live DIRECTLY inside the entry dir.
    // A symlink whose target escapes the adapters dir is refused.
    if (path.dirname(candidateReal) !== entryReal) {
      continue;
    }
    return candidateReal;
  }
  return null;
}

/**
 * Build the templated argv: one `key=value` element per rendered `with:` key
 * other than `adapter`. Returns either the argv array or a `badKey` describing
 * the first key that violates {@link WITH_KEY_RE}.
 */
export function buildAdapterArgv(
  rendered: Record<string, unknown>,
): { argv: string[] } | { badKey: string } {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(rendered)) {
    if (key === 'adapter') {
      continue;
    }
    if (!WITH_KEY_RE.test(key)) {
      return { badKey: key };
    }
    // value is the RENDERED template result; coerce to a string. The pair is a
    // SINGLE argv element — never split, never concatenated into a command.
    const v = value === undefined || value === null ? '' : String(value);
    argv.push(`${key}=${v}`);
  }
  return { argv };
}

/** Capture a session id from the adapter's stdout: first line, trimmed, capped. */
function captureSessionId(stdout: string): string | undefined {
  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, MAX_SESSION_ID_LEN);
}

/**
 * The `agent_session_dispatch` handler. See module header for the full
 * adapter contract. One attempt, one {@link HandlerOutcome}.
 */
export const agentSessionDispatch: Handler = async (
  ctx: HandlerContext,
): Promise<HandlerOutcome> => {
  const { store, logger, identity } = ctx;

  // --- 1. Resolve the rule block (rendered — argv values ARE templated). ----
  let rendered: Record<string, unknown>;
  if (ctx.renderedWith !== undefined) {
    rendered = ctx.renderedWith;
  } else if (ctx.withBlock !== undefined) {
    rendered = renderWith(ctx.withBlock, ctx.event);
  } else {
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id },
      'agent_session_dispatch_no_block',
    );
    return { kind: 'failed', retryable: false, detail: 'no with: block supplied' };
  }

  const blockJson = JSON.stringify(rendered);

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
      'agent_session_dispatch_suppressed',
    );
    return { kind: 'suppressed', reason };
  }

  const failConfig = (detail: string, event: string, extra: Record<string, unknown> = {}): HandlerOutcome => {
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id, ...extra },
      event,
    );
    return { kind: 'failed', retryable: false, detail };
  };

  // --- 3. Validate the adapter NAME (terminal config errors). --------------
  const adapter = rendered['adapter'];
  if (typeof adapter !== 'string' || !ADAPTER_NAME_RE.test(adapter)) {
    return failConfig('with.adapter is missing or malformed', 'agent_session_dispatch_bad_adapter');
  }

  // --- 4. Build the templated argv (rejects bad with: keys). ---------------
  const built = buildAdapterArgv(rendered);
  if ('badKey' in built) {
    return failConfig(
      `with key "${built.badKey}" does not match ${WITH_KEY_RE.source}`,
      'agent_session_dispatch_bad_with_key',
      { bad_key: redactForLogging(built.badKey) },
    );
  }
  const argv = built.argv;

  // --- 5. Resolve the adapter by basename (path-security guard). -----------
  const entries = resolveAdaptersPath(ctx.adaptersPath, process.env);
  const adapterPath = resolveAdapter(adapter, entries);
  if (adapterPath === null) {
    return failConfig(
      'adapter not found / not opted in',
      'agent_session_dispatch_adapter_not_found',
      { adapter, adapters_path_entries: entries.length },
    );
  }

  // --- 6. Scrubbed child env (WFT_API_KEY / foreign *_token_env absent). ----
  const env = buildChildEnv(rendered['env'], ctx.tokenEnv, process.env);
  const spawnFn: SpawnImpl = ctx.spawnImpl ?? spawn;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(ctx.event);

  // --- 7. Spawn + drive the child (one attempt). ---------------------------
  // `shell: false` is MANDATORY: adapterPath + argv are a literal program and a
  // literal arg array. stdout is captured (session id); stderr is ignored.
  return await new Promise<HandlerOutcome>((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let stdoutBuf = '';

    const clearTimers = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };

    let child: ReturnType<SpawnImpl>;
    try {
      child = spawnFn(adapterPath, argv, {
        shell: false,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
      logger.error(
        {
          rule_name: identity.rule_name,
          event_id: identity.event_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'agent_session_dispatch_spawn_threw',
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
      if (settled) return;
      settled = true;
      clearTimers();
      store.complete(identity.rule_name, identity.event_id, status);
      logger.warn(
        { rule_name: identity.rule_name, event_id: identity.event_id, ...extra },
        event,
      );
      resolve({ kind: 'failed', retryable, detail });
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const stdout = child.stdout;
    if (stdout) {
      stdout.on('data', (chunk: Buffer | string) => {
        if (stdoutBuf.length < MAX_SESSION_ID_LEN * 4) {
          stdoutBuf += String(chunk);
        }
      });
      stdout.on('error', () => {
        /* child may close stdout early; the close handler owns outcome. */
      });
    }

    child.on('error', (err: Error) => {
      // ENOENT/EACCES at spawn time → terminal config error → non-retryable.
      const code = (err as NodeJS.ErrnoException).code;
      const terminal = code === 'ENOENT' || code === 'EACCES';
      finishFailed(
        terminal ? 'PERMANENTLY_FAILED' : 'FAILED',
        !terminal,
        terminal ? `spawn ${code ?? 'error'}` : 'spawn error',
        'agent_session_dispatch_spawn_error',
        { code: code ?? null },
      );
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (timedOut) {
        finishFailed('FAILED', true, 'timed out', 'agent_session_dispatch_timeout', {
          timeout_ms: timeoutMs,
          signal,
        });
        return;
      }
      clearTimers();
      if (exitCode === 0) {
        settled = true;
        store.complete(identity.rule_name, identity.event_id, 'SUCCEEDED');
        const sessionId = captureSessionId(stdoutBuf);
        logger.info(
          {
            rule_name: identity.rule_name,
            event_id: identity.event_id,
            adapter,
            exit_code: 0,
            // Session id is adapter-emitted (untrusted) → redact before logging.
            session_id: sessionId === undefined ? null : redactForLogging(sessionId),
          },
          'agent_session_dispatch_succeeded',
        );
        resolve(sessionId === undefined ? { kind: 'succeeded' } : { kind: 'succeeded', sessionId });
        return;
      }
      // Non-zero exit → failure; RETRYABLE (dispatcher decides per max_retries).
      finishFailed(
        'FAILED',
        true,
        `exit code ${exitCode === null ? `signal ${String(signal)}` : String(exitCode)}`,
        'agent_session_dispatch_nonzero_exit',
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
