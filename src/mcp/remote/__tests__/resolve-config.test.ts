import { describe, it, expect } from 'vitest';
import { resolveRemoteConfig } from '../index.js';

describe('resolveRemoteConfig (remote MCP fail-fast env validation)', () => {
  it('returns apiUrl and apiKey when both env vars are set', () => {
    const result = resolveRemoteConfig({
      WFB_API_URL: 'http://localhost:3000',
      WFB_API_KEY: 'abc123',
    });
    expect(result).toEqual({
      apiUrl: 'http://localhost:3000',
      apiKey: 'abc123',
    });
  });

  it('throws a readable error when WFB_API_URL is unset', () => {
    expect(() =>
      resolveRemoteConfig({ WFB_API_KEY: 'abc123' })
    ).toThrowError(/WFB_API_URL must be set/);
  });

  it('throws a readable error when WFB_API_URL is empty string', () => {
    expect(() =>
      resolveRemoteConfig({ WFB_API_URL: '', WFB_API_KEY: 'abc123' })
    ).toThrowError(/WFB_API_URL must be set/);
  });

  it('throws a readable error when WFB_API_URL is only whitespace', () => {
    expect(() =>
      resolveRemoteConfig({ WFB_API_URL: '   ', WFB_API_KEY: 'abc123' })
    ).toThrowError(/WFB_API_URL must be set/);
  });

  it('does NOT silently default to any host when WFB_API_URL is unset', () => {
    // Regression guard: previously fell back to a hardcoded internal LAN IP.
    // The error message must mention WFB_API_URL — no default hostname leaks.
    try {
      resolveRemoteConfig({ WFB_API_KEY: 'abc123' });
      throw new Error('expected resolveRemoteConfig to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/192\.168\.\d+\.\d+/);
      expect(msg).toMatch(/WFB_API_URL/);
    }
  });

  it('throws a readable error when WFB_API_KEY is unset', () => {
    expect(() =>
      resolveRemoteConfig({ WFB_API_URL: 'http://localhost:3000' })
    ).toThrowError(/WFB_API_KEY must be set/);
  });

  it('throws a readable error when WFB_API_KEY is empty string', () => {
    expect(() =>
      resolveRemoteConfig({ WFB_API_URL: 'http://localhost:3000', WFB_API_KEY: '' })
    ).toThrowError(/WFB_API_KEY must be set/);
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
