/**
 * Unit tests for src/cli/commands/link-project.ts (project 29, task #595).
 *
 * Invokes the command's action against a per-test tmpdir `cwd` and asserts the
 * `.wft/project` marker contents directly. Covers:
 *   - marker creation (numeric id + name forms)
 *   - idempotent overwrite on re-run (no throw)
 *   - --json single-envelope output
 *   - format round-trips through the #593 resolver
 *
 * The action reads `process.cwd()` and writes to stdout, so each test chdir's
 * into the tmpdir and captures `process.stdout.write`. The original cwd is
 * restored in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMainThread } from 'node:worker_threads';
import { Command } from 'commander';
import { linkProjectCommand } from '../commands/link-project.js';
import { resolveProjectFromCwd } from '../statusline/resolve-project.js';

/**
 * Run the command's action with the given argv-ish args under `cwd`, capturing
 * everything written to stdout.
 *
 * `--json` is a GLOBAL option (defined on the root `program`, read via
 * `parent.optsWithGlobals()`), so we mount `linkProjectCommand` under a fresh
 * parent that declares it — mirroring the real bin wiring (registration is task
 * #598). Args targeting the subcommand are prefixed with `link-project`.
 */
async function runLinkProject(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number | undefined }> {
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;

  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // Intercept stdout.write so the JSON envelope / confirmation line is captured
  // instead of polluting test output.
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const program = new Command('tasks');
  program.option('--json', 'Output as JSON (machine-readable)');
  program.addCommand(linkProjectCommand);

  process.chdir(cwd);
  try {
    await program.parseAsync(['node', 'tasks', ...args]);
  } finally {
    process.stdout.write = origWrite;
    process.chdir(prevCwd);
  }

  const exitCode = process.exitCode;
  process.exitCode = prevExitCode;
  return { stdout: chunks.join(''), exitCode };
}

/** Read the payload line (first non-empty, non-comment) from the marker. */
function readMarkerPayload(cwd: string): string | undefined {
  const markerPath = join(cwd, '.wft', 'project');
  if (!existsSync(markerPath)) return undefined;
  return readFileSync(markerPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
}

// The command under test reads process.cwd(), so every test chdir's into a
// tmpdir (see runLinkProject). process.chdir() throws inside worker_threads,
// and Stryker's vitest runner forces pool:'threads' for its mutation dry run
// (task #823) — so this whole suite skips there and runs fully under normal
// `npm test` (forks pool / main thread), preserving its value in CI.
describe.skipIf(!isMainThread)('link-project command', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'wft-link-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates .wft/project containing a numeric project id', async () => {
    const { exitCode } = await runLinkProject(['link-project', '42'], cwd);

    expect(exitCode).toBeUndefined();
    expect(readMarkerPayload(cwd)).toBe('42');
  });

  it('creates .wft/project containing a project name', async () => {
    const { exitCode } = await runLinkProject(['link-project', 'my-cool-project'], cwd);

    expect(exitCode).toBeUndefined();
    expect(readMarkerPayload(cwd)).toBe('my-cool-project');
  });

  it('is idempotent: re-running overwrites the marker without error', async () => {
    await runLinkProject(['link-project', '10'], cwd);
    expect(readMarkerPayload(cwd)).toBe('10');

    // Re-run with a different identifier — must overwrite in place, no throw.
    const { exitCode } = await runLinkProject(['link-project', '20'], cwd);
    expect(exitCode).toBeUndefined();
    expect(readMarkerPayload(cwd)).toBe('20');

    // Exactly one marker file remains (no leftover .tmp siblings).
    const wftEntries = readdirSync(join(cwd, '.wft'));
    expect(wftEntries).toEqual(['project']);
  });

  it('--json emits a single envelope describing the written marker', async () => {
    const { stdout, exitCode } = await runLinkProject(['--json', 'link-project', '7'], cwd);

    expect(exitCode).toBeUndefined();

    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    const envelope = JSON.parse(lines[0]);
    expect(envelope).toMatchObject({
      event: 'linked',
      identifier: '7',
      projectId: 7,
      marker: join(cwd, '.wft', 'project'),
    });
    expect(readMarkerPayload(cwd)).toBe('7');
  });

  it('writes a marker the #593 resolver reads back (numeric id)', async () => {
    await runLinkProject(['link-project', '123'], cwd);

    const res = await resolveProjectFromCwd(cwd, { listProjects: async () => [] });
    expect(res).toEqual({ resolved: true, source: 'wft_marker', projectId: 123 });
  });

  it('writes a marker the #593 resolver reads back (name)', async () => {
    await runLinkProject(['link-project', 'some-repo'], cwd);

    const res = await resolveProjectFromCwd(cwd, { listProjects: async () => [] });
    expect(res).toEqual({ resolved: true, source: 'wft_marker', repoName: 'some-repo' });
  });
});
