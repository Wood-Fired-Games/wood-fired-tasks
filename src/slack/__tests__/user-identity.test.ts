import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { UserIdentityCache } from '../user-identity.js';

// Create a mock WebClient — plain object cast as WebClient for dependency inversion
// No vi.mock() needed — we pass the mock directly to the constructor
function makeMockClient(usersInfoImpl?: () => Promise<unknown>): WebClient {
  return {
    users: {
      info: vi.fn(usersInfoImpl ?? (() => Promise.resolve({ ok: true, user: undefined }))),
    },
  } as unknown as WebClient;
}

function makeSuccessResponse(opts: {
  display_name?: string;
  real_name?: string;
  name?: string;
}) {
  return {
    ok: true,
    user: {
      profile: {
        display_name: opts.display_name ?? '',
        real_name: opts.real_name ?? '',
      },
      name: opts.name,
    },
  };
}

describe('UserIdentityCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('resolve() calls users.info with correct userId', () => {
    it('should call users.info with the given userId', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(makeSuccessResponse({ display_name: 'Alice' }))
      );
      const cache = new UserIdentityCache(mockClient);

      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledWith({ user: 'U123' });
    });
  });

  describe('Fallback chain', () => {
    it('should return display_name when present', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(
          makeSuccessResponse({ display_name: 'Alice', real_name: 'Alice M', name: 'alice' })
        )
      );
      const cache = new UserIdentityCache(mockClient);

      const result = await cache.resolve('U123');

      expect(result).toBe('Alice');
    });

    it('should return real_name when display_name is empty', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(
          makeSuccessResponse({ display_name: '', real_name: 'Alice M', name: 'alice' })
        )
      );
      const cache = new UserIdentityCache(mockClient);

      const result = await cache.resolve('U123');

      expect(result).toBe('Alice M');
    });

    it('should return name when display_name and real_name are empty', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(
          makeSuccessResponse({ display_name: '', real_name: '', name: 'alice' })
        )
      );
      const cache = new UserIdentityCache(mockClient);

      const result = await cache.resolve('U123');

      expect(result).toBe('alice');
    });

    it('should return userId when display_name, real_name are empty and name is missing', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve({
          ok: true,
          user: {
            profile: {
              display_name: '',
              real_name: '',
            },
            // no name field
          },
        })
      );
      const cache = new UserIdentityCache(mockClient);

      const result = await cache.resolve('U123');

      expect(result).toBe('U123');
    });
  });

  describe('Caching', () => {
    it('should use cached value on second resolve() call — users.info called once', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(makeSuccessResponse({ display_name: 'Alice' }))
      );
      const cache = new UserIdentityCache(mockClient);

      await cache.resolve('U123');
      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('TTL expiry', () => {
    it('should call users.info again after TTL expires', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(makeSuccessResponse({ display_name: 'Alice' }))
      );
      // 100ms TTL for testing
      const cache = new UserIdentityCache(mockClient, 100);

      await cache.resolve('U123');
      // Advance past the 100ms TTL
      vi.advanceTimersByTime(150);
      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error handling', () => {
    it('should return userId when users.info throws', async () => {
      const mockClient = makeMockClient(() => Promise.reject(new Error('API error')));
      const cache = new UserIdentityCache(mockClient);

      const result = await cache.resolve('U123');

      expect(result).toBe('U123');
    });

    it('should not throw when users.info rejects', async () => {
      const mockClient = makeMockClient(() => Promise.reject(new Error('API error')));
      const cache = new UserIdentityCache(mockClient);

      await expect(cache.resolve('U123')).resolves.toBe('U123');
    });

    it('should cache error result — second resolve() does not call users.info again', async () => {
      const mockClient = makeMockClient(() => Promise.reject(new Error('API error')));
      const cache = new UserIdentityCache(mockClient);

      await cache.resolve('U123');
      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledTimes(1);
    });

    it('should call users.info again after 30s error TTL expires', async () => {
      const mockClient = makeMockClient(() => Promise.reject(new Error('API error')));
      const cache = new UserIdentityCache(mockClient);

      await cache.resolve('U123');
      // Advance past the 30s error TTL
      vi.advanceTimersByTime(30_001);
      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledTimes(2);
    });
  });

  describe('clear()', () => {
    it('should empty cache so next resolve() calls users.info again', async () => {
      const mockClient = makeMockClient(() =>
        Promise.resolve(makeSuccessResponse({ display_name: 'Alice' }))
      );
      const cache = new UserIdentityCache(mockClient);

      await cache.resolve('U123');
      cache.clear();
      await cache.resolve('U123');

      expect(mockClient.users.info).toHaveBeenCalledTimes(2);
    });
  });
});
