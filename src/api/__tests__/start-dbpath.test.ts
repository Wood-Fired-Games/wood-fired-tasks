import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Task #703 regression test — the production API entry point (`start.ts`)
 * MUST thread the validated `config.DATABASE_PATH` into `createServer`, rather
 * than calling `createServer()` with no arguments (which makes `createApp`
 * fall back to its hard-coded `./data/tasks.db` default).
 *
 * Strategy: mock `../server.js` so `createServer` is a spy returning a stub
 * server/app, and mock `../../config/env.js` so `config.DATABASE_PATH` is a
 * known sentinel. Importing `start.ts` runs its top-level `main()`; we then
 * assert the spy was invoked with `{ dbPath: <DATABASE_PATH> }`.
 *
 * FAILS on the old behavior: when `start.ts` calls `createServer()` (no args),
 * the spy receives `undefined`, so the `toHaveBeenCalledWith({ dbPath: ... })`
 * assertion fails. PASSES once the entry point forwards config.DATABASE_PATH.
 */

const EXPECTED_DB_PATH = '/tmp/example.db';

// Track listeners registered via process.on so we can detach them afterwards
// (start.ts registers SIGTERM/SIGINT/uncaughtException/unhandledRejection
// handlers at module load; leaving them attached would leak across tests).
const realProcessOn = process.on.bind(process);

// Stub Fastify server returned by the mocked createServer. Provides only the
// surface main() touches: log.*, listen(), close(), and an app.db with the
// pragma/close methods used by the WAL-checkpoint + shutdown paths.
function makeStubServerAndApp() {
  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    warn: vi.fn(),
  };
  const server = {
    log,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const app = {
    db: {
      pragma: vi.fn(),
      close: vi.fn(),
    },
  };
  return { server, app };
}

const createServerMock = vi.fn();

vi.mock('../server.js', () => ({
  createServer: (...args: unknown[]) => createServerMock(...args),
}));

vi.mock('../../config/env.js', () => ({
  // Minimal config surface main() reads.
  config: {
    DATABASE_PATH: EXPECTED_DB_PATH,
    PORT: 0,
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    WAL_CHECKPOINT_INTERVAL_MS: 900000,
  },
  // loadConfig is called twice (module top-level + inside main); no-op stub.
  loadConfig: vi.fn(),
  ExitCodes: { EX_OK: 0, EX_SOFTWARE: 70 },
}));

describe('Task #703 — start.ts honors config.DATABASE_PATH', () => {
  let detachListeners: Array<() => void> = [];

  beforeEach(() => {
    createServerMock.mockReset();
    const { server, app } = makeStubServerAndApp();
    createServerMock.mockResolvedValue({ server, app });

    // Capture every process.on registration during the start.ts import so we
    // can remove exactly those handlers afterwards.
    detachListeners = [];
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...a: unknown[]) => void,
    ) => {
      realProcessOn(event as never, handler as never);
      detachListeners.push(() => process.off(event, handler));
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    for (const off of detachListeners) off();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('passes { dbPath: config.DATABASE_PATH } to createServer (not undefined)', async () => {
    // Importing start.ts runs its top-level main().
    await import('../start.js');
    // Let the awaited main() chain settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(createServerMock).toHaveBeenCalledWith({ dbPath: EXPECTED_DB_PATH });

    // Explicit guard against the old behavior (called with no args).
    const callArgs = createServerMock.mock.calls[0];
    expect(callArgs.length).toBeGreaterThan(0);
    expect(callArgs[0]).toBeDefined();
  });
});
