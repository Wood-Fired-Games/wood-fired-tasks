/**
 * Tests for the wft-router `agent_session_dispatch` handler (task #431).
 *
 * Coverage per the acceptance criteria (AC #1):
 *   - SUCCESS:            adapter exits 0 → succeeded; SUCCEEDED row; the
 *                         session id printed on stdout is captured + surfaced
 *                         in the outcome AND the structured log (AC #4).
 *   - ADAPTER-MISSING:    adapter not on the adapters-path (incl. the empty
 *                         default) → PERMANENTLY_FAILED, non-retryable.
 *   - ADAPTER-NONZERO:    adapter exits != 0 → failed, retryable:true,
 *                         FAILED row.
 *   - IDEMPOTENT-REPLAY:  a second call for the same (rule, event) suppresses
 *                         the spawn entirely.
 *
 * Plus supporting cases: bad adapter NAME + bad with: KEY → PERMANENTLY_FAILED;
 * path-separator / symlink-escape refusal; argv built as templated `key=value`
 * single elements (injection boundary); `shell:false` always; event JSON on
 * stdin; env scrub (WFT_API_KEY + foreign *_token_env absent).
 *
 * A REAL in-memory `IdempotencyStore` (`:memory:`) drives the PENDING→terminal
 * protocol. Real adapters are written into a temp dir and run via
 * `process.execPath` (vendor-neutral, cross-platform, no shell builtins); the
 * env-scrub / argv-shape cases use a recording fake `spawnImpl`.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IdempotencyStore, type DispatchStatus } from '../../dispatch/index.js';
import type { EventPayloadShape } from '../../dispatch/index.js';
import {
  agentSessionDispatch,
  buildAdapterArgv,
  resolveAdapter,
  resolveAdaptersPath,
} from '../agent-session-dispatch.js';
import type { HandlerContext, HandlerLogger, SpawnImpl } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg?: string;
}

function recordingLogger(): { logger: HandlerLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
    },
  };
}

function silentLogger(): HandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeStore(): IdempotencyStore {
  return new IdempotencyStore({ dbPath: ':memory:' });
}

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
    withBlock:
      'withBlock' in over ? over.withBlock : { adapter: 'local-command', target: 'my-project' },
    renderedWith: over.renderedWith,
    apiBaseUrl: over.apiBaseUrl ?? 'https://tasks.example.com',
    authToken: over.authToken ?? 'wft_pat_abc123',
    timeoutMs: over.timeoutMs,
    fetchImpl: over.fetchImpl,
    spawnImpl: over.spawnImpl,
    tokenEnv: over.tokenEnv,
    adaptersPath: over.adaptersPath,
  };
}

// ---------------------------------------------------------------------------
// Real adapters in a temp dir (vendor-neutral names; run via process.execPath)
// ---------------------------------------------------------------------------

let adaptersDir: string;

/**
 * Write a real adapter that runs `process.execPath <script>` via a tiny shim.
 * On POSIX we make a `#!`-style wrapper pointing at node; to stay
 * cross-platform AND shell-free, we instead resolve the adapter to the node
 * binary itself by symlinking... but the handler requires the file to live
 * directly in the dir. So we write a `.mjs` and run it as `node <file>` — but
 * the handler spawns the adapter directly. Therefore the adapter file IS a
 * native executable on POSIX (a wrapper script with a node shebang). To avoid
 * shebang portability issues we copy the node binary and pair it with a script
 * passed as argv[0]=script via WFT... — simplest portable approach: write a
 * shell-free Node script with an executable shebang on POSIX.
 */
function writeNodeAdapter(name: string, body: string): string {
  const file = path.join(adaptersDir, name);
  const shebang = `#!${process.execPath}\n`;
  fs.writeFileSync(file, shebang + body, { mode: 0o755 });
  return file;
}

beforeAll(() => {
  adaptersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-adapters-'));
  fs.chmodSync(adaptersDir, 0o755);
});

afterAll(() => {
  fs.rmSync(adaptersDir, { recursive: true, force: true });
});

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Recording fake spawn (env / argv / stdin shape, deterministic)
// ---------------------------------------------------------------------------

interface SpawnCall {
  command: string;
  argv: string[];
  env: Record<string, string>;
  shell: unknown;
  stdin: string;
}

function recordingSpawn(behavior: { exit?: number; stdout?: string }): {
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
    const stdout = new Readable({ read() {} });
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: Readable;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.kill = () => true;

    const call: SpawnCall = {
      command,
      argv: [...argv],
      env: options['env'] as Record<string, string>,
      shell: options['shell'],
      stdin: '',
    };
    calls.push(call);

    stdin.on('finish', () => {
      call.stdin = stdinBuf;
      if (behavior.stdout !== undefined) {
        stdout.push(behavior.stdout);
      }
      stdout.push(null);
      setImmediate(() => child.emit('close', behavior.exit ?? 0, null));
    });

    return child as unknown as ReturnType<SpawnImpl>;
  }) as unknown as SpawnImpl;

  return { spawnImpl, calls };
}

// ---------------------------------------------------------------------------
// resolveAdaptersPath / buildAdapterArgv units
// ---------------------------------------------------------------------------

describe('resolveAdaptersPath', () => {
  it('defaults to EMPTY when neither injected nor env var is set', () => {
    expect(resolveAdaptersPath(undefined, {})).toEqual([]);
  });

  it('prefers the injected list over the env var', () => {
    const env = { WFT_ROUTER_ADAPTERS_PATH: ['/from/env'].join(path.delimiter) };
    expect(resolveAdaptersPath(['/injected'], env)).toEqual(['/injected']);
  });

  it('splits the env var on the OS path delimiter and drops blanks', () => {
    const raw = ['/a', '', '/b'].join(path.delimiter);
    expect(resolveAdaptersPath(undefined, { WFT_ROUTER_ADAPTERS_PATH: raw })).toEqual(['/a', '/b']);
  });
});

describe('buildAdapterArgv', () => {
  it('emits one templated key=value element per non-adapter key', () => {
    const built = buildAdapterArgv({
      adapter: 'local-command',
      target: 'my-project',
      prompt: 'epic 42 closed',
    });
    expect(built).toEqual({ argv: ['target=my-project', 'prompt=epic 42 closed'] });
  });

  it('keeps a value with spaces/separators as a SINGLE argv element (injection boundary)', () => {
    const built = buildAdapterArgv({ adapter: 'a', prompt: 'a b; rm -rf / && echo x' });
    expect(built).toEqual({ argv: ['prompt=a b; rm -rf / && echo x'] });
    if ('argv' in built) expect(built.argv).toHaveLength(1);
  });

  it('rejects a with: key that violates the key regex', () => {
    const built = buildAdapterArgv({ adapter: 'a', 'Bad-Key': 'x' });
    expect(built).toEqual({ badKey: 'Bad-Key' });
  });
});

// ---------------------------------------------------------------------------
// resolveAdapter — path security
// ---------------------------------------------------------------------------

describe('resolveAdapter (path security)', () => {
  it('returns null when adapters-path is empty (opt-in default)', () => {
    expect(resolveAdapter('local-command', [])).toBeNull();
  });

  it('resolves a regular file living directly in an entry dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-res-'));
    fs.chmodSync(dir, 0o755);
    const f = path.join(dir, 'container-exec');
    fs.writeFileSync(f, '#!/bin/true\n', { mode: 0o755 });
    expect(resolveAdapter('container-exec', [dir])).toBe(fs.realpathSync(f));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a symlink whose target escapes the adapters dir', () => {
    if (isWindows) return; // symlink perms differ on Windows CI
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-esc-'));
    fs.chmodSync(dir, 0o755);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-out-'));
    const realTarget = path.join(outside, 'evil');
    fs.writeFileSync(realTarget, '#!/bin/true\n', { mode: 0o755 });
    fs.symlinkSync(realTarget, path.join(dir, 'ssh-channel'));
    expect(resolveAdapter('ssh-channel', [dir])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('skips a group/world-writable adapters dir (best-effort hardening)', () => {
    if (isWindows) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-ww-'));
    const f = path.join(dir, 'user-defined');
    fs.writeFileSync(f, '#!/bin/true\n', { mode: 0o755 });
    fs.chmodSync(dir, 0o777);
    expect(resolveAdapter('user-defined', [dir])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips an adapters dir not owned by the router uid (POSIX ownership hardening)', () => {
    if (isWindows || process.getuid === undefined) return; // POSIX-only behavior
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-owner-'));
    fs.chmodSync(dir, 0o755);
    const f = path.join(dir, 'user-defined');
    fs.writeFileSync(f, '#!/bin/true\n', { mode: 0o755 });
    // The temp dir is owned by the current (test) uid. Spoof getuid() to a
    // different uid so the ownership check treats it as foreign-owned.
    const realUid = process.getuid();
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
    try {
      expect(resolveAdapter('user-defined', [dir])).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // Sanity: with the true uid the same adapter resolves.
    expect(resolveAdapter('user-defined', [dir])).toBe(fs.realpathSync(f));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// agentSessionDispatch — real-child cases
// ---------------------------------------------------------------------------

describe('agentSessionDispatch (real adapter children)', () => {
  it('SUCCESS: adapter exits 0, prints session id → succeeded + sessionId surfaced + SUCCEEDED row', async () => {
    if (isWindows) return; // shebang-based adapter is POSIX-only; fake-spawn case covers Windows
    // Adapter reads the event on stdin, prints a session id on stdout, exits 0.
    writeNodeAdapter(
      'local-command',
      [
        'let buf = "";',
        'process.stdin.on("data", (c) => { buf += c; });',
        'process.stdin.on("end", () => {',
        '  const ev = JSON.parse(buf);',
        '  process.stdout.write("session-" + ev.task.id + "\\n");',
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    const store = makeStore();
    const { logger, entries } = recordingLogger();
    const ctx = baseContext({
      store,
      logger,
      adaptersPath: [adaptersDir],
      // Pure-substitution templating only (renderWith rejects mixed strings).
      withBlock: { adapter: 'local-command', target: 'my-project', prompt: '{{task.status}}' },
    });

    const outcome = await agentSessionDispatch(ctx);

    expect(outcome).toEqual({ kind: 'succeeded', sessionId: 'session-42' });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
    // AC #4: session id surfaced in the structured success log too.
    const ok = entries.find((e) => e.msg === 'agent_session_dispatch_succeeded');
    expect(ok?.obj.session_id).toBe('session-42');
  });

  it('ADAPTER-NONZERO: adapter exits 1 → failed, retryable:true, FAILED row', async () => {
    if (isWindows) return;
    writeNodeAdapter('container-exec', ['process.exit(3);'].join('\n'));
    const store = makeStore();
    const ctx = baseContext({
      store,
      adaptersPath: [adaptersDir],
      withBlock: { adapter: 'container-exec', target: 'x' },
    });

    const outcome = await agentSessionDispatch(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(true);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// agentSessionDispatch — config-error + replay + env/argv (fake or pure)
// ---------------------------------------------------------------------------

describe('agentSessionDispatch (config errors)', () => {
  it('ADAPTER-MISSING: empty adapters-path → PERMANENTLY_FAILED, non-retryable', async () => {
    const store = makeStore();
    const ctx = baseContext({
      store,
      adaptersPath: [],
      withBlock: { adapter: 'local-command', target: 'x' },
    });

    const outcome = await agentSessionDispatch(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(false);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('ADAPTER-MISSING: adapter not present in a real dir → PERMANENTLY_FAILED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-empty-'));
    fs.chmodSync(dir, 0o755);
    const store = makeStore();
    const ctx = baseContext({
      store,
      adaptersPath: [dir],
      withBlock: { adapter: 'does-not-exist', target: 'x' },
    });

    const outcome = await agentSessionDispatch(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bad adapter NAME (path separator) → PERMANENTLY_FAILED, non-retryable', async () => {
    const store = makeStore();
    const ctx = baseContext({
      store,
      adaptersPath: [adaptersDir],
      withBlock: { adapter: '../etc/passwd', target: 'x' },
    });
    const outcome = await agentSessionDispatch(ctx);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(false);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('bad with: KEY → PERMANENTLY_FAILED, non-retryable', async () => {
    const store = makeStore();
    const ctx = baseContext({
      store,
      adaptersPath: [adaptersDir],
      withBlock: { adapter: 'local-command', 'Bad-Key': 'x' },
    });
    const outcome = await agentSessionDispatch(ctx);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.retryable).toBe(false);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });
});

describe('agentSessionDispatch (idempotent replay)', () => {
  it('IDEMPOTENT-REPLAY: second call for same (rule,event) suppresses the spawn', async () => {
    const store = makeStore();
    const { spawnImpl, calls } = recordingSpawn({ exit: 0, stdout: 'sess-1\n' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-replay-'));
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'local-command'), 'x', { mode: 0o755 });

    const first = baseContext({
      store,
      spawnImpl,
      adaptersPath: [dir],
      withBlock: { adapter: 'local-command', target: 'x' },
    });
    const out1 = await agentSessionDispatch(first);
    expect(out1.kind).toBe('succeeded');
    expect(calls).toHaveLength(1);

    const second = baseContext({
      store,
      spawnImpl,
      adaptersPath: [dir],
      withBlock: { adapter: 'local-command', target: 'x' },
    });
    const out2 = await agentSessionDispatch(second);
    expect(out2).toEqual({ kind: 'suppressed', reason: 'already_done' });
    // No second spawn — the side-effect was suppressed.
    expect(calls).toHaveLength(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('agentSessionDispatch (spawn shape: env scrub, argv, stdin)', () => {
  it('shell:false; argv templated key=value singletons; event JSON on stdin; env scrubbed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-shape-'));
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'ssh-channel'), 'x', { mode: 0o755 });

    const { spawnImpl, calls } = recordingSpawn({ exit: 0, stdout: 'sid-7\n' });
    const event: EventPayloadShape = {
      type: 'task.created',
      task: { id: 7, project_id: 1, project_slug: 'p', status: 'open' },
    };
    const ctx = baseContext({
      store: makeStore(),
      event,
      spawnImpl,
      adaptersPath: [dir],
      tokenEnv: 'MY_RULE_TOKEN',
      // `id` is a pure substitution → rendered to the numeric value 7.
      withBlock: { adapter: 'ssh-channel', target: 'svc', id: '{{task.id}}' },
    });

    // Sentinels in the real parent env: forwarded token must pass, secrets must not.
    process.env.MY_RULE_TOKEN = 'tok-xyz';
    process.env.WFT_API_KEY = 'super-secret';
    process.env.OTHER_RULE_token_env = 'foreign';

    const outcome = await agentSessionDispatch(ctx);

    delete process.env.MY_RULE_TOKEN;
    delete process.env.WFT_API_KEY;
    delete process.env.OTHER_RULE_token_env;

    expect(outcome).toEqual({ kind: 'succeeded', sessionId: 'sid-7' });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.shell).toBe(false);
    expect(c.command).toBe(fs.realpathSync(path.join(dir, 'ssh-channel')));
    // Templated argv: `id` rendered to the numeric 7 (type-preserving render,
    // string-coerced into the value half), each a SINGLE element, no `adapter`.
    expect(c.argv).toEqual(['target=svc', 'id=7']);
    // Event JSON reached the child only on stdin.
    expect(JSON.parse(c.stdin)).toEqual(event);
    // Env scrub: token forwarded, secrets absent.
    expect(c.env.MY_RULE_TOKEN).toBe('tok-xyz');
    expect(c.env.WFT_API_KEY).toBeUndefined();
    expect(c.env.OTHER_RULE_token_env).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
