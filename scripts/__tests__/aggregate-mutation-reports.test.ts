import { describe, it, expect } from 'vitest';
import {
  aggregateReports,
  formatSummary,
  parseArgs,
  type StrykerReport,
} from '../aggregate-mutation-reports.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function shard(
  files: Record<string, Array<{ status: string }>>,
): StrykerReport {
  const entries = Object.entries(files).map(([path, mutants]) => [
    path,
    {
      mutants: mutants.map((m, i) => ({
        id: `${path}#${i}`,
        status: m.status,
      })),
    },
  ]);
  return {
    schemaVersion: '2',
    files: Object.fromEntries(entries),
  } as StrykerReport;
}

// ---------------------------------------------------------------------------
// aggregateReports
// ---------------------------------------------------------------------------

describe('aggregateReports', () => {
  it('computes 100% score when every mutant is killed', () => {
    const r = aggregateReports([
      shard({ 'src/a.ts': [{ status: 'Killed' }, { status: 'Killed' }] }),
    ]);
    expect(r.score).toBe(100);
    expect(r.killed).toBe(2);
    expect(r.totalCovered).toBe(2);
    expect(r.fileCount).toBe(1);
  });

  it('treats Timeout as detected', () => {
    const r = aggregateReports([
      shard({
        'src/a.ts': [
          { status: 'Killed' },
          { status: 'Timeout' },
          { status: 'Survived' },
        ],
      }),
    ]);
    expect(r.score).toBeCloseTo(66.6667, 3);
    expect(r.totalDetected).toBe(2);
    expect(r.totalUndetected).toBe(1);
  });

  it('treats NoCoverage as undetected (penalizes score)', () => {
    const r = aggregateReports([
      shard({
        'src/a.ts': [{ status: 'Killed' }, { status: 'NoCoverage' }],
      }),
    ]);
    expect(r.score).toBe(50);
    expect(r.noCoverage).toBe(1);
  });

  it('excludes Ignored / CompileError / RuntimeError / Pending from the denominator', () => {
    const r = aggregateReports([
      shard({
        'src/a.ts': [
          { status: 'Killed' },
          { status: 'Ignored' },
          { status: 'CompileError' },
          { status: 'RuntimeError' },
          { status: 'Pending' },
        ],
      }),
    ]);
    expect(r.score).toBe(100); // 1/1 covered, all others excluded
    expect(r.totalCovered).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.ignored).toBe(1);
    expect(r.compileError).toBe(1);
    expect(r.runtimeError).toBe(1);
    expect(r.pending).toBe(1);
  });

  it('merges multiple shards into a unified score', () => {
    // Shard A: 3 killed, 1 survived  → would be 75% in isolation
    // Shard B: 1 killed, 1 survived  → would be 50% in isolation
    // Combined: 4 killed / 6 covered → 66.67%
    const r = aggregateReports([
      shard({
        'src/cli/a.ts': [
          { status: 'Killed' },
          { status: 'Killed' },
          { status: 'Killed' },
          { status: 'Survived' },
        ],
      }),
      shard({
        'src/api/b.ts': [{ status: 'Killed' }, { status: 'Survived' }],
      }),
    ]);
    expect(r.score).toBeCloseTo(66.6667, 3);
    expect(r.killed).toBe(4);
    expect(r.survived).toBe(2);
    expect(r.shardCount).toBe(2);
    expect(r.fileCount).toBe(2);
  });

  it('returns score=0 when there are no covered mutants', () => {
    const r = aggregateReports([
      shard({ 'src/a.ts': [{ status: 'Ignored' }, { status: 'CompileError' }] }),
    ]);
    expect(r.score).toBe(0);
    expect(r.totalCovered).toBe(0);
  });

  it('silently skips unknown statuses (forward-compat)', () => {
    const r = aggregateReports([
      shard({
        'src/a.ts': [
          { status: 'Killed' },
          { status: 'FutureStatus' as 'Killed' },
        ],
      }),
    ]);
    expect(r.killed).toBe(1);
    expect(r.totalCovered).toBe(1);
    expect(r.score).toBe(100);
  });

  it('throws on missing "files" object', () => {
    expect(() =>
      aggregateReports([{} as StrykerReport]),
    ).toThrow(/missing "files" object/);
  });

  it('handles empty shards (no files) without crashing', () => {
    const r = aggregateReports([shard({})]);
    expect(r.score).toBe(0);
    expect(r.fileCount).toBe(0);
    expect(r.shardCount).toBe(1);
  });

  it('matches the realistic ~86% sample score case', () => {
    // Realistic distribution mirroring task #250 partial-run evidence:
    // 6000 killed, 100 timeout, 800 survived, 200 noCoverage.
    // detected = 6100, covered = 7100, score = 85.92%
    const mutants = [
      ...Array.from({ length: 6000 }, () => ({ status: 'Killed' })),
      ...Array.from({ length: 100 }, () => ({ status: 'Timeout' })),
      ...Array.from({ length: 800 }, () => ({ status: 'Survived' })),
      ...Array.from({ length: 200 }, () => ({ status: 'NoCoverage' })),
    ];
    const r = aggregateReports([shard({ 'src/big.ts': mutants })]);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.score).toBeLessThan(87);
  });
});

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

describe('formatSummary', () => {
  it('includes PASS when score meets threshold', () => {
    const r = aggregateReports([
      shard({ 'src/a.ts': [{ status: 'Killed' }] }),
    ]);
    const out = formatSummary(r, 75);
    expect(out).toContain('Threshold:        75%');
    expect(out).toContain('(PASS)');
    expect(out).toContain('Score:            100.00%');
  });

  it('includes FAIL when score is below threshold', () => {
    const r = aggregateReports([
      shard({
        'src/a.ts': [{ status: 'Killed' }, { status: 'Survived' }],
      }),
    ]);
    const out = formatSummary(r, 75);
    expect(out).toContain('(FAIL)');
  });

  it('omits threshold line when threshold is null', () => {
    const r = aggregateReports([
      shard({ 'src/a.ts': [{ status: 'Killed' }] }),
    ]);
    const out = formatSummary(r, null);
    expect(out).not.toContain('Threshold:');
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses positional inputs', () => {
    const a = parseArgs(['a.json', 'b.json']);
    expect(a.inputs).toEqual(['a.json', 'b.json']);
    expect(a.threshold).toBeNull();
    expect(a.output).toBeNull();
  });

  it('parses --threshold', () => {
    const a = parseArgs(['--threshold', '75', 'a.json']);
    expect(a.threshold).toBe(75);
    expect(a.inputs).toEqual(['a.json']);
  });

  it('parses -t shorthand', () => {
    const a = parseArgs(['-t', '60', 'a.json']);
    expect(a.threshold).toBe(60);
  });

  it('parses --output', () => {
    const a = parseArgs(['--output', 'out.json', 'a.json']);
    expect(a.output).toBe('out.json');
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--bogus', 'a.json'])).toThrow(/Unknown option/);
  });

  it('rejects non-numeric threshold', () => {
    expect(() => parseArgs(['--threshold', 'high', 'a.json'])).toThrow(
      /must be numeric/,
    );
  });

  it('rejects --threshold without a value', () => {
    expect(() => parseArgs(['--threshold'])).toThrow(/requires a value/);
  });
});
