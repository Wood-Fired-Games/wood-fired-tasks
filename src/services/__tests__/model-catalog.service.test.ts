import { describe, it, expect, vi } from 'vitest';
import { createModelCatalogService, STATIC_FALLBACK_MODELS } from '../model-catalog.service.js';

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('model-catalog service', () => {
  it('parses a /v1/models payload (family inferred; stale:false)', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        data: [
          {
            id: 'claude-opus-4-8',
            display_name: 'Claude Opus 4.8',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const svc = createModelCatalogService({ apiKey: 'sk-test', fetchImpl, now: () => 0 });
    const cat = await svc.list();

    expect(cat.stale).toBe(false);
    expect(cat.models[0]).toMatchObject({
      id: 'claude-opus-4-8',
      display_name: 'Claude Opus 4.8',
      family: 'opus',
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('sends x-api-key + anthropic-version headers to the Models API', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }));
    const svc = createModelCatalogService({
      apiKey: 'sk-secret',
      fetchImpl,
      now: () => 0,
      baseUrl: 'https://example.test/v1/models',
    });
    await svc.list();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-secret',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('infers family for sonnet/haiku/unknown ids', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        data: [
          { id: 'claude-sonnet-4-6' },
          { id: 'claude-haiku-4-5' },
          { id: 'some-future-model' },
        ],
      }),
    );
    const svc = createModelCatalogService({ apiKey: 'sk', fetchImpl, now: () => 0 });
    const cat = await svc.list();

    expect(cat.models.map((m) => m.family)).toEqual(['sonnet', 'haiku', 'future']);
    // display_name falls back to id when absent.
    expect(cat.models[0]?.display_name).toBe('claude-sonnet-4-6');
  });

  it('returns the static fallback (stale) when no api key, never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const svc = createModelCatalogService({ apiKey: undefined, fetchImpl, now: () => 0 });
    const cat = await svc.list();

    expect(cat.stale).toBe(true);
    expect(cat.models).toEqual(STATIC_FALLBACK_MODELS);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back (stale) and never throws on network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const svc = createModelCatalogService({ apiKey: 'sk', fetchImpl, now: () => 0 });

    const cat = await svc.list();
    expect(cat.stale).toBe(true);
    expect(cat.models).toEqual(STATIC_FALLBACK_MODELS);
    expect(cat.models.length).toBeGreaterThan(0);
  });

  it('falls back (stale) on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const svc = createModelCatalogService({ apiKey: 'sk', fetchImpl, now: () => 0 });

    const cat = await svc.list();
    expect(cat.stale).toBe(true);
    expect(cat.models).toEqual(STATIC_FALLBACK_MODELS);
  });

  it('caches within the TTL window, refetches after TTL elapses', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }));
    let t = 0;
    const svc = createModelCatalogService({
      apiKey: 'sk',
      fetchImpl,
      now: () => t,
      ttlMs: 1000,
    });

    await svc.list();
    t = 500;
    await svc.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    t = 2000;
    await svc.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refresh() busts the cache and refetches immediately', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }));
    const svc = createModelCatalogService({
      apiKey: 'sk',
      fetchImpl,
      now: () => 0,
      ttlMs: 1_000_000,
    });

    await svc.list();
    await svc.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached

    const cat = await svc.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // cache busted
    expect(cat.stale).toBe(false);
  });
});
