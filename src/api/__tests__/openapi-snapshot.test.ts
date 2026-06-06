import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';

// Configure API keys for tests
process.env.API_KEYS = 'test-key';

/**
 * OpenAPI contract drift detection.
 *
 * Task 207: snapshot the generated OpenAPI spec so that PRs which add,
 * remove, or change endpoints / schemas surface as a snapshot diff in code
 * review. The snapshot lives under `__snapshots__/` (vitest default) and is
 * committed to the repo.
 *
 * If this test fails, inspect the diff:
 *   - Intentional API change?  →  Re-run with `vitest --update` and commit
 *     the updated snapshot in the same PR as the API change.
 *   - Unintentional drift?     →  Fix the code; do NOT blindly update the
 *     snapshot.
 *
 * The spec is normalized before snapshotting (paths sorted, schema keys
 * sorted, version strings pinned) so that incidental, non-semantic
 * reordering by `@fastify/swagger` does not cause spurious diffs between
 * environments or Fastify versions.
 */

/**
 * Recursively sort object keys so the JSON serialization is stable
 * regardless of insertion order. Arrays are left in document order (their
 * order is semantically meaningful in OpenAPI — e.g. parameters list,
 * security requirements).
 */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeys) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Normalize fields that legitimately vary between runs / environments so
 * they do not contaminate the snapshot. Currently this is only
 * `info.version` and the `servers` block (host/port may differ in CI vs.
 * local), but the function is the central place to add future
 * normalizations.
 */
function normalize(spec: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;

  if (clone.info && typeof clone.info === 'object') {
    const info = clone.info as Record<string, unknown>;
    // Pin the version so version bumps in package.json / swagger.ts do not
    // require a snapshot update on every release.
    info.version = '<pinned>';
  }

  // Pin server URLs — they include localhost:PORT and are environment-
  // dependent. The list of server entries is still snapshotted so that
  // *adding* or *removing* a server surfaces as a diff.
  if (Array.isArray(clone.servers)) {
    clone.servers = (clone.servers as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      url: '<pinned>',
    }));
  }

  return sortKeys(clone);
}

describe('OpenAPI snapshot (contract drift detection)', () => {
  let server: FastifyInstance;
  let app: App;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  it('matches the committed OpenAPI snapshot', async () => {
    // Prefer the in-process accessor — `app.swagger()` is the @fastify/swagger
    // API and is available regardless of whether the Swagger UI / `/docs`
    // route is exposed (which is gated in production).
    const swaggerFn = (server as unknown as { swagger?: () => unknown }).swagger;
    expect(typeof swaggerFn).toBe('function');
    const rawSpec = (swaggerFn as () => Record<string, unknown>).call(server);

    const normalized = normalize(rawSpec);

    expect(normalized).toMatchSnapshot();
  });
});
