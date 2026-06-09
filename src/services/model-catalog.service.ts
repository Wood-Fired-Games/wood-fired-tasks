/**
 * Task 8 (project "Configurable Task Models") — model-catalog.service.
 *
 * Runtime discovery of the available Claude model catalog via the Anthropic
 * Models API (`GET https://api.anthropic.com/v1/models`), with an in-process
 * TTL cache and a graceful static fallback.
 *
 * Degrade contract (§9/§13.1 of the design): this service NEVER throws from
 * `list()` or `refresh()`. When there is no API key, the HTTP response is not
 * OK, or the network call rejects, it returns `STATIC_FALLBACK_MODELS` with
 * `stale: true`. A successful live fetch returns the parsed catalog with
 * `stale: false`.
 *
 * All side-effecting dependencies (`fetchImpl`, `now`, `ttlMs`, `apiKey`,
 * `baseUrl`) are injectable so the unit tests can run hermetically with a fake
 * clock and a fake fetch — no real network access.
 */

/** A single discovered model, normalised to the fields downstream code needs. */
export interface ModelCatalogEntry {
  id: string;
  display_name: string;
  family: string;
  created_at: string;
}

/** The result of a catalog lookup. `stale` is true when served from fallback. */
export interface ModelCatalog {
  models: ModelCatalogEntry[];
  stale: boolean;
}

/**
 * Static, hand-maintained fallback catalog. Used whenever live discovery is
 * unavailable (no key / non-OK response / network error). Ordered newest-power
 * first (opus → sonnet → haiku) to mirror the family power ladder.
 */
export const STATIC_FALLBACK_MODELS: ModelCatalogEntry[] = [
  {
    id: 'claude-opus-4-8',
    display_name: 'Claude Opus 4.8',
    family: 'opus',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'claude-sonnet-4-6',
    display_name: 'Claude Sonnet 4.6',
    family: 'sonnet',
    created_at: '2025-09-01T00:00:00Z',
  },
  {
    id: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5',
    family: 'haiku',
    created_at: '2025-10-01T00:00:00Z',
  },
];

/**
 * Infer a model's family from its id. Prefers a known family token
 * (`opus`/`sonnet`/`haiku`) appearing anywhere in the id; otherwise falls back
 * to the second hyphen-delimited segment (e.g. `claude-<family>-...`), and
 * finally to `'unknown'` so the field is always a non-empty string.
 */
const familyOf = (id: string): string =>
  ['opus', 'sonnet', 'haiku'].find((f) => id.includes(f)) ?? id.split('-')[1] ?? 'unknown';

/** Injectable dependencies for {@link createModelCatalogService}. */
export interface CatalogDeps {
  /** Anthropic API key. When undefined, the service serves the static fallback. */
  apiKey: string | undefined;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Monotonic clock in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Cache time-to-live in ms. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Models API endpoint. Defaults to the public Anthropic Models API. */
  baseUrl?: string;
}

/** Shape of the `/v1/models` response body we consume (defensively typed). */
interface ModelsApiResponse {
  data?: Array<{ id: string; display_name?: string; created_at?: string }>;
}

/**
 * Create a model-catalog service instance with the supplied dependencies.
 *
 * @returns An object exposing `list()` (TTL-cached) and `refresh()` (busts the
 *   cache then re-lists). Neither method ever throws.
 */
export function createModelCatalogService(deps: CatalogDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
  const baseUrl = deps.baseUrl ?? 'https://api.anthropic.com/v1/models';

  let cache: { at: number; value: ModelCatalog } | null = null;

  const fallback = (): ModelCatalog => ({ models: STATIC_FALLBACK_MODELS, stale: true });

  async function fetchLive(): Promise<ModelCatalog> {
    if (!deps.apiKey) return fallback();
    try {
      const res = await fetchImpl(baseUrl, {
        headers: {
          'x-api-key': deps.apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) return fallback();
      const body = (await res.json()) as ModelsApiResponse;
      const models = (body.data ?? []).map(
        (m): ModelCatalogEntry => ({
          id: m.id,
          display_name: m.display_name ?? m.id,
          family: familyOf(m.id),
          created_at: m.created_at ?? '',
        }),
      );
      return { models, stale: false };
    } catch {
      // Network error, malformed JSON, etc. — degrade, never throw.
      return fallback();
    }
  }

  return {
    /** Return the catalog, served from cache when within the TTL window. */
    async list(): Promise<ModelCatalog> {
      if (cache && now() - cache.at < ttlMs) return cache.value;
      const value = await fetchLive();
      cache = { at: now(), value };
      return value;
    },
    /** Bust the cache and re-fetch the catalog. */
    async refresh(): Promise<ModelCatalog> {
      cache = null;
      return this.list();
    },
  };
}

/** Public type of a constructed model-catalog service. */
export type ModelCatalogService = ReturnType<typeof createModelCatalogService>;
