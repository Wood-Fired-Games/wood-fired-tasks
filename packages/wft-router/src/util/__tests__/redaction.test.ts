/**
 * Tests for the sensitive-key redaction utility (task #426).
 *
 * Coverage matches the acceptance criterion "sensitive-key redaction
 * reuses the same key list as the logger redaction paths" — the regex
 * and the deep-walk function are co-located so #427 imports both without
 * re-deriving the key list.
 */

import { describe, expect, it } from 'vitest';

import {
  SENSITIVE_KEY_RE,
  isSensitiveKey,
  redactForLogging,
} from '../redaction.js';

describe('SENSITIVE_KEY_RE', () => {
  it('matches the canonical key names (lower-case)', () => {
    expect(SENSITIVE_KEY_RE.test('token')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('secret')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('password')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('authorization')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('cookie')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(SENSITIVE_KEY_RE.test('Token')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('TOKEN')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('Authorization')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('PASSWORD')).toBe(true);
  });

  it('matches all three api-key spellings', () => {
    expect(SENSITIVE_KEY_RE.test('api_key')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('api-key')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('apikey')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('apiKey')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('API_KEY')).toBe(true);
  });

  it('does NOT match substrings or typos (anchors are load-bearing)', () => {
    expect(SENSITIVE_KEY_RE.test('tokenized')).toBe(false);
    expect(SENSITIVE_KEY_RE.test('mytoken')).toBe(false);
    expect(SENSITIVE_KEY_RE.test('authrorization')).toBe(false);
    expect(SENSITIVE_KEY_RE.test('apikkey')).toBe(false);
    expect(SENSITIVE_KEY_RE.test('access_token')).toBe(false); // intentional — guard rail
    expect(SENSITIVE_KEY_RE.test('cookies')).toBe(false);
  });
});

describe('isSensitiveKey', () => {
  it('delegates to SENSITIVE_KEY_RE', () => {
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('username')).toBe(false);
  });
});

describe('redactForLogging', () => {
  it('redacts a top-level sensitive field', () => {
    const input = { token: 'Bearer xyz', name: 'webhook' };
    expect(redactForLogging(input)).toEqual({ token: '***', name: 'webhook' });
  });

  it('redacts a deeply-nested sensitive field', () => {
    const input = {
      url: 'https://example.test/hook',
      headers: {
        Authorization: 'Bearer xyz',
        'content-type': 'application/json',
      },
    };
    expect(redactForLogging(input)).toEqual({
      url: 'https://example.test/hook',
      headers: {
        Authorization: '***',
        'content-type': 'application/json',
      },
    });
  });

  it('preserves non-sensitive structure exactly', () => {
    const input = {
      a: 1,
      b: 'two',
      c: [true, false, null],
      d: { nested: { e: 'leaf' } },
    };
    expect(redactForLogging(input)).toEqual(input);
  });

  it('handles arrays of objects', () => {
    const input = [
      { secret: 's1', label: 'one' },
      { secret: 's2', label: 'two' },
    ];
    expect(redactForLogging(input)).toEqual([
      { secret: '***', label: 'one' },
      { secret: '***', label: 'two' },
    ]);
  });

  it('redacts regardless of the original value type', () => {
    const input = {
      token: 12345,
      password: { complex: { object: true } },
      cookie: ['arr', 'value'],
    };
    expect(redactForLogging(input)).toEqual({
      token: '***',
      password: '***',
      cookie: '***',
    });
  });

  it('returns primitives and null inputs unchanged', () => {
    expect(redactForLogging(null)).toBeNull();
    expect(redactForLogging(undefined)).toBeUndefined();
    expect(redactForLogging(42)).toBe(42);
    expect(redactForLogging('plain')).toBe('plain');
    expect(redactForLogging(true)).toBe(true);
  });

  it('does NOT mutate the input', () => {
    const input = { token: 'real', nested: { secret: 'real2' } };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    redactForLogging(input);
    expect(input).toEqual(snapshot);
  });

  it('handles circular references with [CIRCULAR] marker', () => {
    const cyc: Record<string, unknown> = { name: 'root' };
    cyc.self = cyc;
    const out = redactForLogging(cyc) as Record<string, unknown>;
    expect(out.name).toBe('root');
    expect(out.self).toBe('[CIRCULAR]');
  });

  it('handles cycles via arrays', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const out = redactForLogging(arr) as unknown[];
    expect(out[0]).toBe('[CIRCULAR]');
  });
});
