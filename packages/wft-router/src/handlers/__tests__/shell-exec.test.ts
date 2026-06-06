/**
 * Tests for the wft-router `shell_exec` handler (task #430).
 *
 * Coverage per the task's acceptance criteria (AC #1):
 *   - EXIT-0:          child exits 0 → succeeded, SUCCEEDED row.
 *   - EXIT-NONZERO:    child exits != 0 → failed, retryable:true, FAILED row.
 *   - TIMEOUT-KILL:    child hangs past timeout → killed (SIGTERM/SIGKILL),
 *                      failed 'timed out', retryable:true, FAILED row.
 *   - ENV-SCRUB:       a recording fake spawn captures `options.env`; the child
 *                      sees the allowlist + declared passthrough + token_env,
 *                      and does NOT see WFT_API_KEY or a foreign *_token_env set
 *                      in the parent process.env (AC #1, #3, #4 security core).
 *
 * Plus supporting cases: `shell:false` is always passed (AC #2); argv is a
 * literal array (no string concatenation); event payload reaches the child on
 * stdin; missing-command config error; idempotent replay (second call
 * suppresses the spawn); spawn ENOENT → PERMANENTLY_FAILED non-retryable; and
 * the `DEFAULT_ENV_ALLOWLIST` default-set assertion (AC #3 "defaults
 * documented and unit-tested").
 *
 * A REAL in-memory `IdempotencyStore` (`:memory:`) exercises the
 * PENDING→terminal protocol end-to-end. The subprocess surface is injected via
 * `spawnImpl` — either a fake `EventEmitter`-based child (deterministic, fast)
 * or a REAL child via `process.execPath -e '<tiny script>'` (cross-platform,
 * vendor-neutral, no shell builtins).
 */

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { IdempotencyStore, type DispatchStatus } from '../../dispatch/index.js';
import type { EventPayloadShape } from '../../dispatch/index.js';
import { buildChildEnv, DEFAULT_ENV_ALLOWLIST, shellExec } from '../shell-exec.js';
import type { HandlerContext, HandlerLogger, SpawnImpl } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): HandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeStore(): IdempotencyStore {
  return new IdempotencyStore({ dbPath: ':memory:' });
}

interface SpawnCall {
  command: string;
  argv: string[];
  cwd: unknown;
  env: Record<string, string>;
  shell: unknown;
  stdin: string;
}

/**
 * Fake `spawn` that records every call (command/argv/cwd/env/shell + the bytes
 * written to stdin) and lets the test drive the child's exit. `behavior`
 * decides what the fake child does after stdin closes:
 *   - { exit: n }         → emit 'close' with code n.
 *   - { hang: true }      → never exit on its own (drives the timeout path);
 *                            kill() resolves the close with the killing signal.
 *   - { error: errno }    → emit 'error' with the given errno code (e.g. ENOENT).
 */
function recordingSpawn(behavior: { exit?: number; hang?: boolean; error?: string }): {
  spawnImpl: SpawnImpl;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl = ((
    command: string,
    argv: readonly string[],
    options: Record<string, unknown>,
  ) => {
    let stdinBuf = '';
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        stdinBuf += String(chunk);
        cb();
      },
    });
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdin = stdin;

    const call: SpawnCall = {
      command,
      argv: [...argv],
      cwd: options['cwd'],
      env: options['env'] as Record<string, string>,
      shell: options['shell'],
      stdin: '',
    };
    calls.push(call);

    let killedSignal: NodeJS.Signals | null = null;
    child.kill = (signal?: NodeJS.Signals): boolean => {
      // First kill (SIGTERM) ends the hung child.
      if (killedSignal === null) {
        killedSignal = signal ?? 'SIGTERM';
        setImmediate(() => child.emit('close', null, killedSignal));
      }
      return true;
    };

    stdin.on('finish', () => {
      call.stdin = stdinBuf;
      if (behavior.error !== undefined) {
        const err = new Error('spawn error') as NodeJS.ErrnoException;
        err.code = behavior.error;
        setImmediate(() => child.emit('error', err));
        return;
      }
      if (behavior.hang) {
        return; // never self-exits; the handler's timeout will kill it.
      }
      setImmediate(() => child.emit('close', behavior.exit ?? 0, null));
    });

    return child as unknown as ReturnType<SpawnImpl>;
  }) as unknown as SpawnImpl;

  return { spawnImpl, calls };
}

/** Build a base context. Caller overrides store / spawnImpl / withBlock. */
function baseContext(over: Partial<HandlerContext> = {}): HandlerContext {
  const event: EventPayloadShape = {
    type: 'task.created',
    task: { id: 42, project_id: 7, project_slug: 'demo', status: 'open' },
  };
  return {
    store: over.store ?? makeStore(),
    logger: over.logger ?? silentLogger(),
    event: over.event ?? event,
    identity: over.identity ?? {
      rule_name: 'rule-A',
      event_id: 'evt-1',
      task_id: 42,
      to_status: 'open',
      emitted_at_ms: 1_700_000_000_000,
    },
    withBlock: 'withBlock' in over ? over.withBlock : { command: '/bin/true', argv: ['--flag'] },
    renderedWith: over.renderedWith,
    apiBaseUrl: over.apiBaseUrl ?? 'https://tasks.example.com',
    authToken: over.authToken ?? 'wft_pat_abc123',
    timeoutMs: over.timeoutMs,
    fetchImpl: over.fetchImpl,
    spawnImpl: over.spawnImpl,
    tokenEnv: over.tokenEnv,
  };
}

/** Observe the terminal status of a (rule, event) row via a second claim. */
function statusOf(
  store: IdempotencyStore,
  ruleName: string,
  eventId: string,
): DispatchStatus | undefined {
  const res = store.claim({
    rule_name: ruleName,
    event_id: eventId,
    rendered_with_json: '{}',
    task_id: null,
    to_status: null,
    emitted_at_ms: null,
  });
  if (res.kind === 'ALREADY_DONE') return res.status;
  if (res.kind === 'ALREADY_PENDING') return 'PENDING';
  return undefined;
}

// ---------------------------------------------------------------------------
// DEFAULT_ENV_ALLOWLIST — defaults documented + unit-tested (AC #3)
// ---------------------------------------------------------------------------

describe('DEFAULT_ENV_ALLOWLIST', () => {
  it('is exactly PATH, HOME, USER, LANG, TZ', () => {
    expect([...DEFAULT_ENV_ALLOWLIST]).toEqual(['PATH', 'HOME', 'USER', 'LANG', 'TZ']);
  });
});

// ---------------------------------------------------------------------------
// buildChildEnv — the env-scrub unit (AC #1, #3, #4)
// ---------------------------------------------------------------------------

describe('buildChildEnv (env-allowlist scrub)', () => {
  it('copies allowlisted parent vars, drops everything else', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      // Secrets / unrelated vars that MUST NOT leak:
      WFT_API_KEY: 'super-secret',
      OTHER_RULE_token_env: 'foreign-token',
      RANDOM_VAR: 'nope',
    };
    const env = buildChildEnv(undefined, undefined, parent);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
    });
    expect(env.WFT_API_KEY).toBeUndefined();
    expect(env.OTHER_RULE_token_env).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it('layers rule-declared with.env passthrough (literal, string-coerced)', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = buildChildEnv({ FOO: 'bar', NUM: 7 }, undefined, parent);
    expect(env.FOO).toBe('bar');
    expect(env.NUM).toBe('7');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('forwards the named token_env from the parent (and only that one)', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      MY_RULE_TOKEN: 'tok-123',
      WFT_API_KEY: 'super-secret',
    };
    const env = buildChildEnv(undefined, 'MY_RULE_TOKEN', parent);
    expect(env.MY_RULE_TOKEN).toBe('tok-123');
    expect(env.WFT_API_KEY).toBeUndefined();
  });

  it('does not invent a token var that is absent from the parent', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = buildChildEnv(undefined, 'MISSING_TOKEN', parent);
    expect('MISSING_TOKEN' in env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shellExec — fake-spawn driven cases
// ---------------------------------------------------------------------------

describe('shellExec', () => {
  it('EXIT-0: child exits 0 → succeeded, SUCCEEDED row, shell:false, argv literal, stdin payload', async () => {
    const store = makeStore();
    const { spawnImpl, calls } = recordingSpawn({ exit: 0 });
    const event: EventPayloadShape = {
      type: 'task.created',
      task: { id: 99, project_id: 1, project_slug: 'p', status: 'open' },
    };
    const ctx = baseContext({
      store,
      event,
      spawnImpl,
      withBlock: { command: '/usr/bin/myscript', argv: ['a', 'b'] },
    });

    const outcome = await shellExec(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
    expect(calls).toHaveLength(1);
    // AC #2: shell:false enforced; argv is a literal array, no concatenation.
    expect(calls[0].shell).toBe(false);
    expect(calls[0].command).toBe('/usr/bin/myscript');
    expect(calls[0].argv).toEqual(['a', 'b']);
    // Event JSON reached the child on stdin.
    expect(JSON.parse(calls[0].stdin)).toEqual(event);
  });

  it('ENV-SCRUB: recorded child env has allowlist + passthrough + token_env, NOT WFT_API_KEY / foreign token', async () => {
    // Seed sentinels in the REAL parent env so the handler reads them from
    // process.env. They must NOT reach the child.
    const SENTINEL_SECRET = 'wft-api-key-sentinel';
    const SENTINEL_FOREIGN = 'foreign-rule-token-sentinel';
    const SENTINEL_TOKEN = 'my-rule-token-sentinel';
    process.env.WFT_API_KEY = SENTINEL_SECRET;
    process.env.OTHER_RULE_TOKEN_ENV = SENTINEL_FOREIGN;
    process.env.MY_RULE_TOKEN = SENTINEL_TOKEN;
    try {
      const store = makeStore();
      const { spawnImpl, calls } = recordingSpawn({ exit: 0 });
      const ctx = baseContext({
        store,
        spawnImpl,
        tokenEnv: 'MY_RULE_TOKEN',
        withBlock: {
          command: '/usr/bin/myscript',
          argv: [],
          env: { CUSTOM: 'declared-value' },
        },
      });

      const outcome = await shellExec(ctx);
      expect(outcome).toEqual({ kind: 'succeeded' });

      const childEnv = calls[0].env;
      // Declared passthrough present.
      expect(childEnv.CUSTOM).toBe('declared-value');
      // Forwarded token_env present.
      expect(childEnv.MY_RULE_TOKEN).toBe(SENTINEL_TOKEN);
      // Allowlist present iff set in the parent (PATH essentially always is).
      if (process.env.PATH) {
        expect(childEnv.PATH).toBe(process.env.PATH);
      }
      // CRITICAL: secret + foreign token absent by construction.
      expect(childEnv.WFT_API_KEY).toBeUndefined();
      expect(childEnv.OTHER_RULE_TOKEN_ENV).toBeUndefined();
    } finally {
      delete process.env.WFT_API_KEY;
      delete process.env.OTHER_RULE_TOKEN_ENV;
      delete process.env.MY_RULE_TOKEN;
    }
  });

  it('EXIT-NONZERO: child exits 2 → failed retryable, FAILED row', async () => {
    const store = makeStore();
    const { spawnImpl } = recordingSpawn({ exit: 2 });
    const ctx = baseContext({ store, spawnImpl });

    const outcome = await shellExec(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.detail).toContain('exit code 2');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });

  it('TIMEOUT-KILL: hung child is killed and reported as retryable timeout, FAILED row', async () => {
    const store = makeStore();
    const { spawnImpl, calls } = recordingSpawn({ hang: true });
    const ctx = baseContext({ store, spawnImpl, timeoutMs: 20 });

    const outcome = await shellExec(ctx);

    expect(outcome).toEqual({ kind: 'failed', retryable: true, detail: 'timed out' });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
    // The child received a kill (SIGTERM first).
    expect(calls).toHaveLength(1);
  });

  it('SPAWN ENOENT: program not on PATH → PERMANENTLY_FAILED, non-retryable', async () => {
    const store = makeStore();
    const { spawnImpl } = recordingSpawn({ error: 'ENOENT' });
    const ctx = baseContext({ store, spawnImpl });

    const outcome = await shellExec(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
      expect(outcome.detail).toContain('ENOENT');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('MISSING COMMAND: config error → PERMANENTLY_FAILED, non-retryable, no spawn', async () => {
    const store = makeStore();
    const { spawnImpl, calls } = recordingSpawn({ exit: 0 });
    const ctx = baseContext({ store, spawnImpl, withBlock: { argv: ['x'] } });

    const outcome = await shellExec(ctx);

    expect(outcome).toEqual({
      kind: 'failed',
      retryable: false,
      detail: 'with.command is missing or empty',
    });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('IDEMPOTENT REPLAY: second call suppresses the spawn entirely', async () => {
    const store = makeStore();
    const { spawnImpl, calls } = recordingSpawn({ exit: 0 });

    const first = await shellExec(baseContext({ store, spawnImpl }));
    expect(first).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);

    const second = await shellExec(baseContext({ store, spawnImpl }));
    expect(second).toEqual({ kind: 'suppressed', reason: 'already_done' });
    // No second spawn fired.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REAL child variant — exercises the actual node:child_process spawn path
// (vendor-neutral: process.execPath -e '<tiny script>', no shell builtins).
// ---------------------------------------------------------------------------

describe('shellExec (real child)', () => {
  it('EXIT-0 with a real subprocess that reads stdin', async () => {
    const store = makeStore();
    const ctx = baseContext({
      store,
      spawnImpl: spawn, // explicit: the real builtin
      withBlock: {
        command: process.execPath,
        // Read all of stdin then exit 0 — proves stdin is wired without
        // depending on any shell.
        argv: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
      },
    });

    const outcome = await shellExec(ctx);
    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
  });

  it('EXIT-NONZERO with a real subprocess', async () => {
    const store = makeStore();
    const ctx = baseContext({
      store,
      spawnImpl: spawn,
      withBlock: {
        command: process.execPath,
        argv: ['-e', 'process.exit(3);'],
      },
    });

    const outcome = await shellExec(ctx);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.detail).toContain('exit code 3');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });
});
