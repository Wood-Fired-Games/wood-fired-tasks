import { describe, it, expect } from 'vitest';
import { resolveRemoteConfig } from '../index.js';

describe('resolveRemoteConfig (remote MCP fail-fast env validation)', () => {
  // No-credentials-file stub. Injected into the URL-validation + token-missing
  // tests so they never depend on the host's real on-disk credentials file
  // (#810 added a file-fallback to the token resolution path).
  const noCredsFile = (): string | null => null;

  it('returns apiUrl and apiKey when both env vars are set', () => {
    const result = resolveRemoteConfig({
      WFT_API_URL: 'http://localhost:3000',
      WFT_API_KEY: 'abc123',
    });
    expect(result).toEqual({
      apiUrl: 'http://localhost:3000',
      apiKey: 'abc123',
    });
  });

  // ── #810 — token precedence ladder: env → credentials file → fail ────────
  describe('bearer token precedence (#810)', () => {
    const URL = 'http://localhost:3000';

    it('env-set: returns the env WFT_API_KEY and NEVER reads the credentials file', () => {
      let credsRead = false;
      const readCreds = (): string | null => {
        credsRead = true;
        return 'wft_pat_FROM_FILE';
      };
      const result = resolveRemoteConfig(
        { WFT_API_URL: URL, WFT_API_KEY: 'wft_pat_FROM_ENV' },
        readCreds,
      );
      expect(result).toEqual({ apiUrl: URL, apiKey: 'wft_pat_FROM_ENV' });
      // env wins → the file reader is never consulted.
      expect(credsRead).toBe(false);
    });

    it('env-unset + file-set: falls back to the credentials-file token', () => {
      const result = resolveRemoteConfig({ WFT_API_URL: URL }, () => 'wft_pat_FROM_FILE');
      expect(result).toEqual({ apiUrl: URL, apiKey: 'wft_pat_FROM_FILE' });
    });

    it('env empty/whitespace + file-set: still falls back to the file token', () => {
      const result = resolveRemoteConfig(
        { WFT_API_URL: URL, WFT_API_KEY: '   ' },
        () => 'wft_pat_FROM_FILE',
      );
      expect(result).toEqual({ apiUrl: URL, apiKey: 'wft_pat_FROM_FILE' });
    });

    it('neither-set: fails clearly (no env token, no credentials file)', () => {
      expect(() => resolveRemoteConfig({ WFT_API_URL: URL }, noCredsFile)).toThrowError(
        /No API token found/,
      );
    });

    it('neither-set: the error mentions both WFT_API_KEY and `tasks login`', () => {
      try {
        resolveRemoteConfig({ WFT_API_URL: URL }, noCredsFile);
        throw new Error('expected resolveRemoteConfig to throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/WFT_API_KEY/);
        expect(msg).toMatch(/tasks login/);
      }
    });
  });

  it('throws a readable error when WFT_API_URL is unset', () => {
    expect(() => resolveRemoteConfig({ WFT_API_KEY: 'abc123' })).toThrowError(
      /WFT_API_URL must be set/,
    );
  });

  it('throws a readable error when WFT_API_URL is empty string', () => {
    expect(() => resolveRemoteConfig({ WFT_API_URL: '', WFT_API_KEY: 'abc123' })).toThrowError(
      /WFT_API_URL must be set/,
    );
  });

  it('throws a readable error when WFT_API_URL is only whitespace', () => {
    expect(() => resolveRemoteConfig({ WFT_API_URL: '   ', WFT_API_KEY: 'abc123' })).toThrowError(
      /WFT_API_URL must be set/,
    );
  });

  it('does NOT silently default to any host when WFT_API_URL is unset', () => {
    // Regression guard: previously fell back to a hardcoded internal LAN IP.
    // The error message must mention WFT_API_URL — no default hostname leaks.
    try {
      resolveRemoteConfig({ WFT_API_KEY: 'abc123' });
      throw new Error('expected resolveRemoteConfig to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/192\.168\.\d+\.\d+/);
      expect(msg).toMatch(/WFT_API_URL/);
    }
  });

  it('throws a readable error when no token is found (env unset, no creds file)', () => {
    expect(() =>
      resolveRemoteConfig({ WFT_API_URL: 'http://localhost:3000' }, noCredsFile),
    ).toThrowError(/No API token found/);
  });

  it('throws a readable error when WFT_API_KEY is empty string and no creds file', () => {
    expect(() =>
      resolveRemoteConfig({ WFT_API_URL: 'http://localhost:3000', WFT_API_KEY: '' }, noCredsFile),
    ).toThrowError(/No API token found/);
  });

  it('error messages are plain strings, not stack traces', () => {
    try {
      resolveRemoteConfig({});
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      // Should be a single readable sentence, not a stack dump
      expect(msg).not.toContain('at ');
      expect(msg.length).toBeLessThan(500);
    }
  });
});
