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
    for (const shard of shards) {
      const excluded = new Set(
        shard.globsExclude ? files(shard.globsExclude.replaceAll('!', '')) : [],
      );
      for (const file of files(shard.globs)) {
        if (!excluded.has(file)) owners.set(file, [...(owners.get(file) ?? []), shard.id]);
      }
    }
    expect([...owners.keys()].sort()).toEqual(expected.sort());
    for (const [file, ids] of owners) expect(ids, file).toHaveLength(1);
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
