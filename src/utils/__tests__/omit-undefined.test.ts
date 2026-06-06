import { describe, it, expect } from 'vitest';
import { omitUndefined } from '../omit-undefined.js';

describe('omitUndefined', () => {
  it('drops keys whose value is exactly undefined', () => {
    const result = omitUndefined({ a: 1, b: undefined, c: 'x' });
    expect(result).toEqual({ a: 1, c: 'x' });
    expect('b' in result).toBe(false);
  });

  it('preserves explicit null (the "clear" state) verbatim', () => {
    // The Create/Update DTO three-state convention encodes:
    //   absent → leave untouched, null → clear, value → set.
    // omitUndefined must NOT collapse null into "absent".
    const result = omitUndefined({ description: null, assignee: undefined });
    expect(result).toEqual({ description: null });
    expect('description' in result).toBe(true);
    expect('assignee' in result).toBe(false);
  });

  it('preserves falsy-but-defined values (0, empty string, false)', () => {
    const result = omitUndefined({ zero: 0, empty: '', flag: false, gone: undefined });
    expect(result).toEqual({ zero: 0, empty: '', flag: false });
  });

  it('leaves an already-absent key absent (no key materialized)', () => {
    const input: { a: number; b?: number } = { a: 1 };
    const result = omitUndefined(input);
    expect('b' in result).toBe(false);
    expect(result).toEqual({ a: 1 });
  });

  it('returns a new object and does not mutate the input', () => {
    const input = { a: 1, b: undefined };
    const result = omitUndefined(input);
    expect(result).not.toBe(input);
    expect('b' in input).toBe(true); // input untouched
  });

  it('is shallow — nested undefined values are not stripped', () => {
    const result = omitUndefined({ top: undefined, nested: { inner: undefined } });
    expect('top' in result).toBe(false);
    expect(result.nested).toEqual({ inner: undefined });
  });

  it('returns an empty object for an all-undefined input', () => {
    expect(omitUndefined({ a: undefined, b: undefined })).toEqual({});
  });
});
