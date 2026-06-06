import { describe, it, expect } from 'vitest';
import { isEvenLtsMajor, parseNodeMajor, warnIfNotEvenLts } from '../node-version.js';

describe('isEvenLtsMajor', () => {
  it('treats even majors as LTS lines', () => {
    expect(isEvenLtsMajor(22)).toBe(true);
    expect(isEvenLtsMajor(24)).toBe(true);
    expect(isEvenLtsMajor(26)).toBe(true);
  });

  it('treats odd majors as non-LTS ("Current")', () => {
    expect(isEvenLtsMajor(23)).toBe(false);
    expect(isEvenLtsMajor(25)).toBe(false);
  });

  it('rejects non-positive / non-integer input', () => {
    expect(isEvenLtsMajor(0)).toBe(false);
    expect(isEvenLtsMajor(-22)).toBe(false);
    expect(isEvenLtsMajor(22.5)).toBe(false);
    expect(isEvenLtsMajor(Number.NaN)).toBe(false);
  });
});

describe('parseNodeMajor', () => {
  it('parses a v-prefixed version string', () => {
    expect(parseNodeMajor('v23.4.0')).toBe(23);
    expect(parseNodeMajor('v22.11.0')).toBe(22);
  });

  it('parses a bare version string', () => {
    expect(parseNodeMajor('24.0.1')).toBe(24);
  });

  it('returns null for an unparseable string', () => {
    expect(parseNodeMajor('not-a-version')).toBeNull();
    expect(parseNodeMajor('')).toBeNull();
  });
});

describe('warnIfNotEvenLts', () => {
  it('warns (returns true) on an odd "Current" major', () => {
    const lines: string[] = [];
    const warned = warnIfNotEvenLts({
      version: 'v23.4.0',
      warn: (l) => lines.push(l),
    });
    expect(warned).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].toLowerCase()).toContain('non-lts');
    expect(lines[0]).toContain('v23.4.0');
  });

  it('stays silent (returns false) on an even LTS major', () => {
    const lines: string[] = [];
    const warned = warnIfNotEvenLts({
      version: 'v22.11.0',
      warn: (l) => lines.push(l),
    });
    expect(warned).toBe(false);
    expect(lines).toEqual([]);
  });

  it('stays silent on an unparseable version (no false positive)', () => {
    const lines: string[] = [];
    const warned = warnIfNotEvenLts({
      version: 'garbage',
      warn: (l) => lines.push(l),
    });
    expect(warned).toBe(false);
    expect(lines).toEqual([]);
  });

  it('is non-fatal: never throws, never exits', () => {
    // No warn sink override -> default console.warn; must not throw/exit.
    expect(() => warnIfNotEvenLts({ version: 'v23.0.0' })).not.toThrow();
  });
});
