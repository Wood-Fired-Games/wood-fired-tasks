import { describe, it, expect } from 'vitest';
import { hashKey, precomputeHashedEntries } from '../keys.js';
import type { ApiKeyEntry } from '../../../../config/env.js';

/**
 * Coverage for `precomputeHashedEntries`, relocated to `keys.ts` from the
 * (now-removed) legacy X-API-Key strategy during the v2.0 auth cutover
 * (Phase 0, task #799). The MCP boot path still depends on this helper.
 */
describe('precomputeHashedEntries', () => {
  it('produces one { hash, label } record per entry with sha256 hash matching hashKey', () => {
    const entries: ApiKeyEntry[] = [
      { key: 'k1', label: 'lbl1' },
      { key: 'k2', label: 'lbl2' },
    ];
    const out = precomputeHashedEntries(entries);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ hash: hashKey('k1'), label: 'lbl1' });
    expect(out[1]).toEqual({ hash: hashKey('k2'), label: 'lbl2' });
  });

  it('returns an empty array for no entries', () => {
    expect(precomputeHashedEntries([])).toEqual([]);
  });
});
