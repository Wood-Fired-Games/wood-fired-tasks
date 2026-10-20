import { globSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('mutation workflow partition and completeness', () => {
  it('covers each previously configured source once and requires every report', () => {
    const workflow = parse(readFileSync('.github/workflows/mutation.yml', 'utf8'));
    const shards = workflow.jobs.shard.strategy.matrix.shard as {
      id: number;
      globs: string;
      globsExclude?: string;
    }[];
    const files = (patterns: string) =>
      [
        ...globSync(patterns.split(/\s+/), {
          exclude: ['**/__tests__/**', '**/*.test.ts', 'src/db/migrate.ts', 'src/cli/bin/tasks.ts'],
        }),
      ].map((file) => file.replaceAll('\\', '/'));
    const expected = files(
      'src/cli/**/*.ts src/api/**/*.ts src/mcp/**/*.ts src/services/**/*.ts src/db/**/*.ts src/repositories/**/*.ts src/slack/**/*.ts src/schemas/**/*.ts src/events/**/*.ts src/utils/**/*.ts src/types/**/*.ts src/config/**/*.ts src/index.ts',
    );
    const owners = new Map<string, number[]>();
    // Stryker mutation ranges (`file:start-end`) split one heavy file across shards.
    const ranges = new Map<string, { start: number; end: number }[]>();
    for (const shard of shards) {
      const excluded = new Set(
        shard.globsExclude ? files(shard.globsExclude.replaceAll('!', '')) : [],
      );
      const globs: string[] = [];
      for (const pattern of shard.globs.split(/\s+/)) {
        const range = /^(.*):(\d+)-(\d+)$/.exec(pattern);
        if (!range) {
          globs.push(pattern);
          continue;
        }
        const [, file, start, end] = range as unknown as [string, string, string, string];
        // Stryker applies `!` negations after includes, which would drop the range.
        expect(excluded.has(file), pattern).toBe(false);
        ranges.set(file, [...(ranges.get(file) ?? []), { start: +start, end: +end }]);
        owners.set(file, [...(owners.get(file) ?? []), shard.id]);
      }
      for (const file of files(globs.join(' '))) {
        if (!excluded.has(file)) owners.set(file, [...(owners.get(file) ?? []), shard.id]);
      }
    }
    expect([...owners.keys()].sort()).toEqual(expected.sort());
    for (const [file, ids] of owners) {
      const fileRanges = ranges.get(file);
      if (!fileRanges) {
        expect(ids, file).toHaveLength(1);
        continue;
      }
      // Ranged files: every owner is ranged and the ranges tile the whole file.
      expect(fileRanges, file).toHaveLength(ids.length);
      const lines = readFileSync(file, 'utf8').split('\n');
      const sorted = fileRanges.toSorted((a, b) => a.start - b.start);
      expect(sorted[0]?.start, file).toBe(1);
      expect(sorted.at(-1)?.end ?? 0, file).toBeGreaterThanOrEqual(lines.length);
      for (const [i, r] of sorted.slice(1).entries()) {
        expect(r.start, file).toBe((sorted[i]?.end ?? 0) + 1);
        // Stryker only mutates nodes wholly inside a range, so each boundary must
        // fall between top-level statements: a blank line, then an unindented one.
        expect(lines[r.start - 2], `${file}:${r.start - 1}`).toBe('');
        expect(lines[r.start - 1], `${file}:${r.start}`).toMatch(/^\S/);
      }
    }
    const steps = workflow.jobs.aggregate.steps as {
      name?: string;
      run?: string;
      env?: Record<string, string>;
    }[];
    expect(
      steps.find((s) => s.name === 'Require every mutation shard to succeed')?.env?.SHARD_RESULT,
    ).toBe('${{ needs.shard.result }}');
    expect(
      steps.find((s) => s.name === 'Aggregate shard reports and enforce break threshold')?.run,
    ).toContain(`--expected-reports ${shards.length}`);
  });
});
