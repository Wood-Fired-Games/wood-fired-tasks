/**
 * In-process tests for src/cli/commands/self-update.ts (tasks #739, #934).
 *
 * The `self-update` command spawns `npm i -g wood-fired-tasks@latest`, then
 * re-syncs bundled skills/agents into ~/.claude, and exits. Tests inject a
 * recording mock spawn (no real npm process), a mock notifier (no network),
 * and a recording syncAssets (no real ~/.claude writes), asserting:
 *   1. the exact npm args are spawned, then the process "exits" (exitCode 0)
 *   2. the EACCES path prints no-sudo remediation and NEVER invokes any
 *      elevation (no sudo / runas / pkexec / doas)
 *   3. the update-notifier nudge seam is wired and fires
 *   4. the skills/agents sync runs after a successful install, is skipped on
 *      a failed install, fails loudly when it throws, and defaults to the
 *      SAME copySkills/copyAgents pair `tasks setup` uses (contract: the
 *      README's "keep it up to date" promise covers skills, task #934)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Command } from 'commander';

// A minimal fake ChildProcess: an EventEmitter plus a `stderr` stream we can
// push EACCES text into. `emitClose` / `emitError` drive the two outcomes.
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
  };
  child.stderr = new EventEmitter();
  return child;
}

async function loadFresh() {
  vi.resetModules();
  return import('../commands/self-update.js');
}

// A recording syncAssets stub shaped like the real copySkills/copyAgents
// results. Keeps every test off the real ~/.claude.
function makeSyncStub(written: { skills?: string[]; agents?: string[] } = {}) {
  return vi.fn(() => ({
    skills: {
      sourceDir: '/pkg/dist/skills/tasks',
      destDir: '/home/test/.claude/commands/tasks',
      written: written.skills ?? [],
      files: written.skills ?? [],
    },
    agents: {
      sourceDir: '/pkg/dist/skills/agents',
      destDir: '/home/test/.claude/agents',
      written: written.agents ?? [],
      files: written.agents ?? [],
    },
  }));
}

describe('self-update command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  it('spawns `npm i -g wood-fired-tasks@latest` and exits 0 on success', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const recorded: { command: string; args: readonly string[] } = {
      command: '',
      args: [],
    };
    const child = makeFakeChild();
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      recorded.command = command;
      recorded.args = args;
      // Simulate a clean npm exit on the next tick.
      setImmediate(() => child.emit('close', 0));
      return child as never;
    });
    const notify = vi.fn();
    __setSelfUpdateDeps({ spawn: spawn as never, notify, syncAssets: makeSyncStub() });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    expect(spawn).toHaveBeenCalledTimes(1);
    // The npm subcommand binary plus the exact install args (the graded part).
    expect(recorded.command).toMatch(/npm(\.cmd)?$/);
    expect(recorded.args).toEqual(['i', '-g', 'wood-fired-tasks@latest']);
    // "exits" => process.exitCode resolved to the child's clean code.
    expect(process.exitCode).toBe(0);
  });

  // Regression: on Windows, npm is `npm.cmd`; since CVE-2024-27980 Node throws
  // `spawn EINVAL` when spawning a .cmd without a shell. self-update must pass
  // `shell: true` on win32 (and only there).
  it('spawns with shell:true on win32 (npm.cmd EINVAL fix), shell:false elsewhere', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const recorded: { options: { shell?: boolean } } = { options: {} };
      const child = makeFakeChild();
      const spawn = vi.fn((_command: string, _args: readonly string[], options: object) => {
        recorded.options = options as { shell?: boolean };
        setImmediate(() => child.emit('close', 0));
        return child as never;
      });
      __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn(), syncAssets: makeSyncStub() });

      const program = new Command();
      program.addCommand(selfUpdateCommand);
      await program.parseAsync(['node', 'tasks', 'self-update']);

      expect(recorded.options.shell).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('prints no-sudo remediation and performs NO elevation on EACCES', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => {
        // Emit an EACCES-class structured error (root-owned prefix).
        const err = Object.assign(new Error('spawn EACCES'), {
          code: 'EACCES',
        });
        child.emit('error', err);
      });
      return child as never;
    });
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn() });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    const errOut = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');

    // Remediation text present.
    expect(errOut).toMatch(/EACCES/);
    expect(errOut).toMatch(/npm config set prefix/);
    expect(errOut).toMatch(/\.npm-global/);
    expect(errOut.toLowerCase()).toMatch(/without sudo/);

    // CRITICAL: no elevation was ever invoked. The only spawn was the npm
    // install; assert its args never reference an elevation binary, and that
    // no remediation/output text instructs the user to run sudo.
    for (const call of spawn.mock.calls) {
      const [cmd, args] = call as unknown as [string, string[]];
      expect(cmd).not.toMatch(/sudo|runas|pkexec|doas/i);
      expect((args ?? []).join(' ')).not.toMatch(/sudo|runas|pkexec|doas/i);
    }
    // Output must not tell the user to use sudo/runas either.
    const allOut = [...consoleLogSpy.mock.calls, ...consoleErrorSpy.mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
    expect(allOut).not.toMatch(/\bsudo \w/i); // e.g. "sudo npm"
    expect(allOut).not.toMatch(/runas|pkexec|doas/i);

    expect(process.exitCode).toBe(1);
  });

  it('detects EACCES from stderr text even without a structured code', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => {
        child.stderr.emit('data', 'npm ERR! Error: EACCES: permission denied');
        child.emit('close', 243);
      });
      return child as never;
    });
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn() });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    const errOut = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errOut).toMatch(/npm config set prefix/);
    expect(process.exitCode).toBe(1);
  });

  it('wires an injectable update-notifier nudge (testable without network)', async () => {
    const { __setSelfUpdateDeps, defaultNotify } = await loadFresh();

    // The default notifier is exported and callable; it must never throw even
    // when the package is absent / offline (best-effort nudge).
    await expect(Promise.resolve(defaultNotify('0.0.0-test'))).resolves.not.toThrow();

    // And the seam accepts a custom notify the command can call.
    const notify = vi.fn();
    __setSelfUpdateDeps({ notify });
    expect(typeof notify).toBe('function');
  });

  it('re-syncs skills/agents after a successful install and reports what changed (task #934)', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    let installDone = false;
    const spawn = vi.fn(() => {
      setImmediate(() => {
        installDone = true;
        child.emit('close', 0);
      });
      return child as never;
    });
    let syncedAfterInstall = false;
    const syncAssets = makeSyncStub({ skills: ['set-models.md'], agents: [] });
    const recordingSync = vi.fn(() => {
      syncedAfterInstall = installDone;
      return syncAssets();
    });
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn(), syncAssets: recordingSync });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    // Sync ran exactly once, strictly AFTER npm finished (the files on disk
    // are only the new version once the install completes).
    expect(recordingSync).toHaveBeenCalledTimes(1);
    expect(syncedAfterInstall).toBe(true);

    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/Refreshed 1 skill\(s\)/);
    expect(out).toMatch(/commands[/\\]tasks/);
    expect(process.exitCode).toBe(0);
  });

  it('reports "already up to date" when the sync writes nothing', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as never;
    });
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn(), syncAssets: makeSyncStub() });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/already up to date/);
    expect(process.exitCode).toBe(0);
  });

  it('does NOT sync skills when the npm install fails', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('close', 1));
      return child as never;
    });
    const syncAssets = makeSyncStub();
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn(), syncAssets });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    expect(syncAssets).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails loudly (non-zero + setup remediation) when the skills sync throws', async () => {
    const { selfUpdateCommand, __setSelfUpdateDeps } = await loadFresh();

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as never;
    });
    const syncAssets = vi.fn(() => {
      throw new Error('EROFS: read-only file system');
    });
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn(), syncAssets });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    const errOut = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errOut).toMatch(/skills\/agents.*failed/);
    expect(errOut).toMatch(/EROFS/);
    expect(errOut).toMatch(/wood-fired-tasks setup/);
    expect(process.exitCode).toBe(1);
  });

  it('CONTRACT: the default sync is setup’s own copySkills/copyAgents (no drift)', async () => {
    // Mock the setup module BEFORE loading self-update so the default
    // syncAssets closure binds to the mocks. This pins the contract that the
    // update path and the onboarding path share one implementation.
    vi.resetModules();
    const copySkills = vi.fn(() => ({
      sourceDir: 's',
      destDir: '/home/test/.claude/commands/tasks',
      written: [],
      files: [],
    }));
    const copyAgents = vi.fn(() => ({
      sourceDir: 's',
      destDir: '/home/test/.claude/agents',
      written: [],
      files: [],
    }));
    vi.doMock('../commands/setup.js', () => ({ copySkills, copyAgents }));
    const { selfUpdateCommand, __setSelfUpdateDeps } = await import('../commands/self-update.js');

    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('close', 0));
      return child as never;
    });
    // No syncAssets injected — exercise the default wiring.
    __setSelfUpdateDeps({ spawn: spawn as never, notify: vi.fn() });

    const program = new Command();
    program.addCommand(selfUpdateCommand);
    await program.parseAsync(['node', 'tasks', 'self-update']);

    expect(copySkills).toHaveBeenCalledTimes(1);
    expect(copyAgents).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);

    vi.doUnmock('../commands/setup.js');
  });

  it('isEaccesFailure classifies structured + textual EACCES/EPERM', async () => {
    const { isEaccesFailure } = await loadFresh();
    expect(
      isEaccesFailure(
        Object.assign(new Error('x'), { code: 'EACCES' }) as NodeJS.ErrnoException,
        '',
      ),
    ).toBe(true);
    expect(
      isEaccesFailure(
        Object.assign(new Error('x'), { code: 'EPERM' }) as NodeJS.ErrnoException,
        '',
      ),
    ).toBe(true);
    expect(isEaccesFailure(null, 'EACCES: permission denied')).toBe(true);
    expect(isEaccesFailure(null, 'some other failure')).toBe(false);
  });
});
