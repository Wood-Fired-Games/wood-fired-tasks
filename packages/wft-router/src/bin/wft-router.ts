#!/usr/bin/env node
/**
 * wft-router stub entry point.
 *
 * Task #421 lands the package scaffold; downstream tasks implement the
 * actual router flags (--config, --endpoint, --token, --validate,
 * --dry-run, --once, --metrics-port, --metrics-bind, --rebuild-idempotency)
 * per docs/event-router-design.md §Contract.
 *
 * Task #434 adds the optional Prometheus `--metrics-port <n>` /
 * `--metrics-bind <addr>` flags: when `--metrics-port` is given, the bin
 * constructs a {@link MetricsRegistry}, threads it into the daemon deps, and
 * starts a loopback-default `node:http` metrics server (binds 127.0.0.1
 * unless `--metrics-bind` widens it; no built-in auth). Disabled by default.
 *
 * Task #422 adds the `--validate <path>` flag: reads the file, runs the
 * triggers.yaml zod schema + templating-safety pass, prints
 * `triggers.yaml validation OK.` on success and exits 0, or prints the
 * formatted error list on failure and exits 78 (sysexits EX_CONFIG).
 * Error formatting mirrors `src/config/env.ts:199-216`.
 *
 * Everything else still prints a one-line "not yet implemented" pointer
 * and exits 0 — so smoke probes and integration scaffolding can link
 * against a working entry point before the real logic lands.
 *
 * Vendor-neutral by design (see docs/event-router-design.md §Vendor-neutral
 * guardrails): no provider, AI, chat, or CI name appears in this file.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EX_CONFIG, loadAndValidateTriggers } from '../config/triggers-schema.js';
import { IdempotencyStore } from '../dispatch/index.js';
import {
  DEFAULT_HANDLER_REGISTRY,
  WftRouterDaemon,
  type DaemonDeps,
} from '../daemon.js';
import { getLogger } from '../logging/index.js';
import {
  MetricsRegistry,
  startMetricsServer,
  type MetricsServerHandle,
} from '../metrics.js';
import { getPaths } from '../paths/index.js';
import { runSSEClient, type SSEClientOptions } from '../sse/index.js';

interface PackageJsonShape {
  version?: unknown;
}

function readOwnVersion(): string {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkgPath = fileURLToPath(pkgUrl);
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageJsonShape;
  if (typeof parsed.version === 'string' && parsed.version.length > 0) {
    return parsed.version;
  }
  return '0.0.0';
}

/**
 * Minimal flag parser: pulls a single `--validate <path>` pair out of argv
 * and ignores everything else. Intentionally NOT a real arg-parser — the
 * full surface lands across downstream tasks.
 */
function readValidateFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--validate');
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (typeof next !== 'string' || next.startsWith('--')) {
    return undefined;
  }
  return next;
}

/** Pull a `--flag <value>` pair out of argv. Returns undefined if absent. */
function readStringFlag(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (typeof next !== 'string' || next.startsWith('--')) {
    return undefined;
  }
  return next;
}

/**
 * Pull a `--flag <int>` pair out of argv. Returns undefined if absent or not
 * a positive integer. Used for `--metrics-port`.
 */
function readIntFlag(argv: readonly string[], flag: string): number | undefined {
  const raw = readStringFlag(argv, flag);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== raw) {
    return undefined;
  }
  return n;
}

/**
 * Options for booting the daemon. Exposed so AC #4's integration test can
 * drive the no-flag entry path against a stubbed API by injecting a fake
 * SSE source + fetch without going through the side-effecting `main()`.
 */
export interface RunDaemonOptions {
  /** Resolved path to triggers.yaml. */
  configPath: string;
  /** API base URL (the `--endpoint`). */
  endpoint: string;
  /** API key (the `--token`). */
  apiKey: string;
  /** Optional event-type filter for the SSE subscription. */
  eventTypes?: readonly string[];
  /** State dir override (where idempotency.sqlite lives). Default: resolved paths. */
  stateDir?: string;
  /** Test seam — overrides the SSE source factory (default: real `runSSEClient`). */
  sseSourceFactory?: DaemonDeps['sseSource'];
  /** Test seam — fetch impl threaded to the SSE client + handlers. */
  fetchImpl?: typeof fetch;
  /** Test seam — pre-built idempotency store (e.g. `:memory:`). */
  store?: DaemonDeps['store'];
  /** Test seam — handler registry override. Default: the four real handlers. */
  handlers?: DaemonDeps['handlers'];
  /**
   * Optional Prometheus metrics registry (task #434). When present it is
   * threaded into the daemon deps so the pipeline increments it. The bin
   * `main()` constructs one only when `--metrics-port` is given.
   */
  metrics?: MetricsRegistry;
}

/**
 * Construct a fully-wired {@link WftRouterDaemon} from boot options. Loads +
 * validates the triggers config, resolves the idempotency store path, and
 * assembles the real dependency set (or test seams when provided). Returns
 * the daemon plus the loaded config so the caller can `start()`/`stop()` it.
 *
 * Importable by tests (AC #4) so the no-flag boot path can be exercised
 * against a stubbed API without invoking the process-exiting `main()`.
 */
export async function createDaemon(
  opts: RunDaemonOptions,
): Promise<WftRouterDaemon> {
  const loaded = await loadAndValidateTriggers(opts.configPath);
  if (!loaded.ok) {
    const err = new Error(
      `triggers.yaml validation failed:\n${loaded.errors.join('\n')}`,
    );
    (err as Error & { exitCode?: number }).exitCode = EX_CONFIG;
    throw err;
  }

  const stateDir = opts.stateDir ?? getPaths().state;
  // Ensure the state dir exists before opening the sqlite file.
  mkdirSync(stateDir, { recursive: true });
  const store =
    opts.store ?? new IdempotencyStore({ dbPath: join(stateDir, 'idempotency.sqlite') });

  const logger = getLogger();

  const sseSource: DaemonDeps['sseSource'] =
    opts.sseSourceFactory ??
    ((signal) => {
      const sseOpts: SSEClientOptions = {
        endpoint: opts.endpoint,
        apiKey: opts.apiKey,
        eventTypes: opts.eventTypes,
        fetchImpl: opts.fetchImpl,
      };
      return runSSEClient(sseOpts, signal);
    });

  const deps: DaemonDeps = {
    config: loaded.config,
    store,
    sseSource,
    handlers: opts.handlers ?? DEFAULT_HANDLER_REGISTRY,
    logger,
    apiBaseUrl: opts.endpoint,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    metrics: opts.metrics,
  };

  return new WftRouterDaemon(deps);
}

/**
 * Boot the daemon for the no-flag entry path: build it, install
 * SIGTERM/SIGINT → `stop()`, `start()` it, and await the consume loop.
 * Resolves with the daemon exit code.
 */
export async function runDaemon(opts: RunDaemonOptions): Promise<number> {
  const daemon = await createDaemon(opts);

  const onSignal = (): void => {
    void daemon.stop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  daemon.start();
  const code = await daemon.wait();
  // Ensure drain runs even when the SSE source returned on its own.
  await daemon.stop();
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  return code;
}

async function runValidate(path: string): Promise<never> {
  const result = await loadAndValidateTriggers(path);
  if (result.ok) {
    console.log('triggers.yaml validation OK.');
    process.exit(0);
  }
  console.error('triggers.yaml validation failed:');
  console.error(result.errors.join('\n'));
  process.exit(EX_CONFIG);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = readOwnVersion();

  if (argv.includes('--version') || argv.includes('-V')) {
    console.log(version);
    process.exit(0);
  }

  const validatePath = readValidateFlag(argv);
  if (validatePath !== undefined) {
    await runValidate(validatePath);
  }
  if (argv.includes('--validate')) {
    // `--validate` was given but with no usable path arg.
    console.error('triggers.yaml validation failed:');
    console.error('  - <args>: --validate requires a path argument');
    process.exit(EX_CONFIG);
  }

  // No flag → boot the daemon: resolve config + endpoint + token, construct
  // the daemon with real deps, start it, and install SIGTERM/SIGINT → stop().
  const paths = getPaths();
  const configPath =
    readStringFlag(argv, '--config') ?? join(paths.config, 'triggers.yaml');
  const endpoint =
    readStringFlag(argv, '--endpoint') ?? process.env.WFT_ROUTER_ENDPOINT ?? '';
  const apiKey =
    readStringFlag(argv, '--token') ?? process.env.WFT_ROUTER_TOKEN ?? '';

  if (endpoint.length === 0) {
    console.error('wft-router: --endpoint (or WFT_ROUTER_ENDPOINT) is required');
    process.exit(EX_CONFIG);
  }
  if (apiKey.length === 0) {
    console.error('wft-router: --token (or WFT_ROUTER_TOKEN) is required');
    process.exit(EX_CONFIG);
  }

  // Optional metrics endpoint: DISABLED unless `--metrics-port <n>` is given.
  // Binds 127.0.0.1 unless `--metrics-bind <addr>` widens it. No auth here —
  // the operator's reverse proxy owns that (docs §Observability / §Threat).
  const metricsPort = readIntFlag(argv, '--metrics-port');
  const metricsBind = readStringFlag(argv, '--metrics-bind') ?? '127.0.0.1';
  let metrics: MetricsRegistry | undefined;
  let metricsServer: MetricsServerHandle | undefined;
  if (metricsPort !== undefined) {
    metrics = new MetricsRegistry();
    metricsServer = await startMetricsServer({
      port: metricsPort,
      bind: metricsBind,
      registry: metrics,
    });
  }

  try {
    const code = await runDaemon({ configPath, endpoint, apiKey, metrics });
    await metricsServer?.close();
    process.exit(code);
  } catch (err) {
    await metricsServer?.close();
    const exitCode = (err as Error & { exitCode?: number }).exitCode;
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(typeof exitCode === 'number' ? exitCode : 1);
  }
}

/**
 * Only auto-run `main()` when this file is the process entry point. When the
 * module is imported (e.g. by AC #4's integration test, which exercises
 * `createDaemon`/`runDaemon` directly), the side-effecting CLI bootstrap must
 * NOT fire. `import.meta.url` vs the invoked `argv[1]` is the standard ESM
 * "is this the main module?" check.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href || fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('wft-router crashed:', message);
    process.exit(1);
  });
}
