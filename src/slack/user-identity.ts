import type { WebClient } from '@slack/web-api';

interface CacheEntry {
  displayName: string;
  expiresAt: number; // Date.now() ms
}

/** TTL for error fallback entries — brief to allow retry without hammering the API */
const ERROR_TTL_MS = 30_000;

/**
 * UserIdentityCache — resolves Slack user IDs to human-readable display names.
 *
 * Design:
 * - Takes a WebClient (not SlackService) for dependency inversion and testability.
 * - TTL-based in-memory Map cache prevents excessive users.info API calls.
 * - Fallback chain: display_name → real_name → name → userId (handles empty strings).
 * - On API error: caches userId itself with a short 30s TTL, returns userId gracefully.
 * - No logger dependency — keeps this class self-contained. Callers log if needed.
 *
 * Usage:
 *   const cache = new UserIdentityCache(app.client);
 *   const name = await cache.resolve('U0123ABC');
 *
 * Phase 25 constructs one instance per SlackService lifecycle and shares it across
 * slash command handlers. Do NOT construct per-request (defeats the cache).
 */
export class UserIdentityCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: WebClient,
    private readonly ttlMs: number = 5 * 60 * 1000, // 5 minutes
  ) {}

  /**
   * Resolve a Slack user ID to a display name.
   *
   * Returns cached value if still fresh. On cache miss or expiry, calls users.info.
   * Falls back through display_name → real_name → name → userId.
   * On any API error, returns userId and caches the fallback briefly.
   */
  async resolve(userId: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(userId);

    if (cached !== undefined && cached.expiresAt > now) {
      return cached.displayName;
    }

    try {
      const response = await this.client.users.info({ user: userId });
      const profile = response.user?.profile;
      const name = response.user?.name;

      // Fallback chain: display_name (trimmed, non-empty) → real_name (trimmed, non-empty)
      // → user.name → userId
      const displayName =
        profile?.display_name && profile.display_name.trim()
          ? profile.display_name.trim()
          : profile?.real_name && profile.real_name.trim()
            ? profile.real_name.trim()
            : (name ?? userId);

      this.cache.set(userId, { displayName, expiresAt: now + this.ttlMs });
      return displayName;
    } catch {
      // Graceful degradation: cache the userId itself briefly to avoid hammering API
      this.cache.set(userId, { displayName: userId, expiresAt: now + ERROR_TTL_MS });
      return userId;
    }
  }

  /**
   * Clear the full cache.
   * Useful for testing or forced-refresh scenarios.
   */
  clear(): void {
    this.cache.clear();
  }
}
