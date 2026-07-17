/**
 * Unit tests for src/cli/commands/completions.ts (task #249).
 *
 * The pre-existing `completions.test.ts` spawns the real CLI binary and asserts
 * subprocess output — but vitest's v8 coverage instrumentation does not follow
 * child processes, so the completions command counted as 0 % covered. This
 * suite drives the command in-process via Commander so coverage attributes the
 * code to the right file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { createCompletionsCommand } from '../commands/completions.js';
import { scmCommand } from '../commands/scm.js';

describe('createCompletionsCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Process.exit must not actually terminate the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    program = new Command();
    // Register a handful of dummy subcommands so the script reflects a real
    // program shape.
    program
      .command('create')
      .description('Create a task')
      .action(() => {});
    program
      .command('list')
      .description('List tasks')
      .action(() => {});
    program
      .command('update')
      .description('Update a task')
      .action(() => {});
    // Register the real `scm` dispatcher (task #1536) so the derived command
    // list proves `scm` is a completion-visible subcommand.
    program.addCommand(scmCommand);
    program.addCommand(createCompletionsCommand(program));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('emits a bash completion script containing all registered subcommands', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('_tasks_completions');
    expect(out).toContain('complete -F _tasks_completions tasks');
    expect(out).toMatch(/commands="[^"]*create[^"]*list[^"]*update[^"]*"/);
    // The pluggable-SCM dispatcher (task #1536) is completion-visible.
    expect(out).toMatch(/commands="[^"]*\bscm\b[^"]*"/);
  });

  it('bash script includes status and priority enum values', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('open');
    expect(out).toContain('in_progress');
    expect(out).toContain('done');
    expect(out).toContain('closed');
    expect(out).toContain('blocked');
    expect(out).toContain('backlogged');
    expect(out).toContain('low');
    expect(out).toContain('medium');
    expect(out).toContain('high');
    expect(out).toContain('urgent');
  });

  it('bash script includes global flags', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('--json');
    expect(out).toContain('--no-input');
    expect(out).toContain('--force');
    expect(out).toContain('--help');
    expect(out).toContain('--version');
  });

  it('emits a zsh completion script with #compdef header', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'zsh']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('#compdef tasks');
    expect(out).toContain('_tasks()');
    // Each command appears with a description label.
    expect(out).toContain("'create:");
    expect(out).toContain("'list:");
    expect(out).toContain("'update:");
  });

  it('zsh script includes per-subcommand argument completions', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'zsh']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('--status[Filter by status]');
    expect(out).toContain('--priority[Filter by priority]');
    expect(out).toContain('--title[Task title]');
    expect(out).toContain('--title[New title]');
    expect(out).toContain('1:shell:(bash zsh)');
  });

  it('exits with error message for unsupported shell', async () => {
    await expect(program.parseAsync(['node', 'tasks', 'completions', 'fish'])).rejects.toThrow(
      /process\.exit\(1\)/,
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported shell: fish'),
    );
  });

  it('case-insensitive shell argument is accepted', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'BASH']);
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain('_tasks_completions');
  });

  it('excludes Commander built-in "help" from the command list', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    const match = out.match(/commands="([^"]+)"/);
    expect(match).not.toBeNull();
    const commands = match![1].split(/\s+/).filter(Boolean);
    expect(commands).not.toContain('help');
  });

  it('uses fallback description when subcommand has none', async () => {
    // Add a subcommand with no description; the completion script should fall
    // back to "<name> command".
    const bareProgram = new Command();
    bareProgram.command('bare').action(() => {});
    bareProgram.addCommand(createCompletionsCommand(bareProgram));
    await bareProgram.parseAsync(['node', 'tasks', 'completions', 'zsh']);
    const out = consoleLogSpy.mock.calls[0][0] as string;
    expect(out).toContain("'bare:bare command'");
  });
});
