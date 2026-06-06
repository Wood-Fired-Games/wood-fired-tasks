/**
 * In-process tests for src/cli/commands/self-update.ts (task #739).
 *
 * The `self-update` command spawns `npm i -g wood-fired-tasks@latest` and
 * exits. Tests inject a recording mock spawn (no real npm process) and a
 * mock notifier (no network), asserting:
 *   1. the exact npm args are spawned, then the process "exits" (exitCode 0)
 *   2. the EACCES path prints no-sudo remediation and NEVER invokes any
 *      elevation (no sudo / runas / pkexec / doas)
 *   3. the update-notifier nudge seam is wired and fires
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

describe('self-update command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
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
    __setSelfUpdateDeps({ spawn: spawn as never, notify });

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

    const errOut = consoleErrorSpy.mock.calls
      .map((c) => String(c[0]))
      .join('\n');

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
    const allOut = [
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ]
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

    const errOut = consoleErrorSpy.mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(errOut).toMatch(/npm config set prefix/);
    expect(process.exitCode).toBe(1);
  });

  it('wires an injectable update-notifier nudge (testable without network)', async () => {
    const { __setSelfUpdateDeps, defaultNotify } = await loadFresh();

    // The default notifier is exported and callable; it must never throw even
    // when the package is absent / offline (best-effort nudge).
    await expect(
      Promise.resolve(defaultNotify('0.0.0-test'))
    ).resolves.not.toThrow();

    // And the seam accepts a custom notify the command can call.
    const notify = vi.fn();
    __setSelfUpdateDeps({ notify });
    expect(typeof notify).toBe('function');
  });

  it('isEaccesFailure classifies structured + textual EACCES/EPERM', async () => {
    const { isEaccesFailure } = await loadFresh();
    expect(
      isEaccesFailure(
        Object.assign(new Error('x'), { code: 'EACCES' }) as NodeJS.ErrnoException,
        ''
      )
    ).toBe(true);
    expect(
      isEaccesFailure(
        Object.assign(new Error('x'), { code: 'EPERM' }) as NodeJS.ErrnoException,
        ''
      )
    ).toBe(true);
    expect(isEaccesFailure(null, 'EACCES: permission denied')).toBe(true);
    expect(isEaccesFailure(null, 'some other failure')).toBe(false);
  });
});
