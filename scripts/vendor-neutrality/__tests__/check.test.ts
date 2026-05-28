import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/vendor-neutrality/check.mjs');
const FIXTURE = 'scripts/vendor-neutrality/__fixtures__/fail-fixture.ts';

function run(args: string[]) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('vendor-neutrality gate', () => {
  it('passes on the current production tree (default --target)', () => {
    const { status, stdout } = run([]);
    expect(stdout).toContain('vendor-neutrality gate PASS');
    expect(status).toBe(0);
  });

  it('fails on a deliberately-violating fixture file', () => {
    const { status, stdout } = run(['--target', FIXTURE]);
    expect(status).toBe(1);
    expect(stdout).toContain('vendor-neutrality gate FAIL');
    // The output must name both the forbidden token (the denylist source
    // line) and the file:line that contained it.
    expect(stdout).toMatch(/scripts\/vendor-neutrality\/__fixtures__\/fail-fixture\.ts:\d+:/);
    expect(stdout.toLowerCase()).toContain('slack');
  });
});
