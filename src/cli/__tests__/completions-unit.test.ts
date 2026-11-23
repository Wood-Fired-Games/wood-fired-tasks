/**
 * Unit tests for src/cli/commands/completions.ts (task #249).
 *
 * The pre-existing `completions.test.ts` spawns the real CLI binary and asserts
 * subprocess output — but vitest's v8 coverage instrumentation does not follow
 * child processes, so the completions command counted as 0 % covered. This
 * suite drives the command in-process via Commander so coverage attributes the
 * code to the right file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { createCompletionsCommand } from '../commands/completions.js';
import { scmCommand } from '../commands/scm.js';
import { listCommand } from '../commands/list.js';
import { projectArchiveCommand } from '../commands/project-archive.js';
import { dbCommand } from '../commands/db.js';

/** True when a `zsh` binary is on PATH. */
function hasZsh(): boolean {
  return spawnSync('zsh', ['-c', 'exit 0']).status === 0;
}

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
    // The real `list` and `project-archive` commands, so the per-command flag
    // lists come from their actual options (WFT #2551).
    program.addCommand(listCommand);
    program
      .command('update')
      .description('Update a task')
      .action(() => {});
    // Register the real `scm` dispatcher (task #1536) so the derived command
    // list proves `scm` is a completion-visible subcommand.
    program.addCommand(scmCommand);
    program.addCommand(projectArchiveCommand);
    // The real `db` command: its flags live on nested subcommands
    // (`db mint-token`, `db migrate-identities`), WFT #2552 point 7.
    program.addCommand(dbCommand);
    program.option('--json', 'Output as JSON');
    program.option('--token <token>', 'Use the given PAT');
    program.addCommand(createCompletionsCommand(program));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('completes the archived project flags in bash and zsh (WFT #2478)', async () => {
    await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
    const bash = consoleLogSpy.mock.calls[0][0] as string;
    for (const flag of ['--include-archived', '--archived-only', '--reason', '--with-unfinished']) {
      expect(bash).toContain(flag);
    }

    consoleLogSpy.mockClear();
    await program.parseAsync(['node', 'tasks', 'completions', 'zsh']);
    const zsh = consoleLogSpy.mock.calls[0][0] as string;
    expect(zsh).toMatch(/list\)[\s\S]*?'--include-archived\[[^\]]+\]'[\s\S]*?;;/);
    expect(zsh).toMatch(/project-list\)[\s\S]*?'--archived-only\[[^\]]+\]'[\s\S]*?;;/);
    expect(zsh).toMatch(/project-archive\)[\s\S]*?'--reason\[[^\]]+\]:reason:'[\s\S]*?;;/);
    expect(zsh).toMatch(/project-archive\)[\s\S]*?'--with-unfinished\[[^\]]+\]'[\s\S]*?;;/);
    // The archive override is --with-unfinished; project-archive offers no
    // --force of its own (the global --force only skips prompts).
    const archiveCase = /project-archive\)([\s\S]*?);;/.exec(zsh)?.[1] ?? '';
    expect(archiveCase).not.toContain("'--force[");
  });

  // WFT #2477 regression (verifier on PR #171): a lost space in
  // `--"${cur}"` made compgen fail with "invalid option", so bash flag
  // completion returned nothing although every flag string was present.
  // These run the generated script in a real bash, not a string match.
  describe('the generated bash completion actually completes (WFT #2477)', () => {
    async function bashScript(): Promise<string> {
      consoleLogSpy.mockClear();
      await program.parseAsync(['node', 'tasks', 'completions', 'bash']);
      return consoleLogSpy.mock.calls[0][0] as string;
    }

    /**
     * Source the script, run _tasks_completions for `words`, return COMPREPLY
     * + stderr. Asserts bash exited 0 (WFT #2551): a script that errors out
     * mid-function must fail here even if it printed nothing to stderr.
     */
    function complete(script: string, words: string[]): { reply: string[]; stderr: string } {
      const dir = mkdtempSync(join(tmpdir(), 'tasks-completion-'));
      const file = join(dir, 'tasks-completion.bash');
      try {
        writeFileSync(file, script);
        // `set -e`/`-u`/pipefail: an unset variable or a failing command in
        // the completion function makes bash exit non-zero.
        const driver = [
          'set -euo pipefail',
          'source "$1"; shift',
          'COMP_WORDS=("$@")',
          'COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))',
          'COMPREPLY=()',
          '_tasks_completions',
          'if (( ${#COMPREPLY[@]} > 0 )); then printf "%s\\n" "${COMPREPLY[@]}"; fi',
        ].join('\n');
        const result = spawnSync(
          'bash',
          ['--norc', '--noprofile', '-c', driver, 'bash', file, ...words],
          {
            encoding: 'utf8',
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, `bash exited ${String(result.status)}: ${result.stderr}`).toBe(0);
        return {
          reply: result.stdout.split('\n').filter((line) => line.length > 0),
          stderr: result.stderr,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('completes project-archive --wi to --with-unfinished', async () => {
      const { reply, stderr } = complete(await bashScript(), [
        'tasks',
        'project-archive',
        '7',
        '--wi',
      ]);
      expect(stderr).toBe('');
      expect(reply).toEqual(['--with-unfinished']);
    });

    it('completes --status values, shells and command names without compgen errors', async () => {
      const script = await bashScript();
      const status = complete(script, ['tasks', 'list', '--status', 'in_']);
      expect(status.stderr).toBe('');
      expect(status.reply).toEqual(['in_progress']);
      const shells = complete(script, ['tasks', 'completions', 'z']);
      expect(shells.reply).toEqual(['zsh']);
      const commands = complete(script, ['tasks', 'cre']);
      expect(commands.reply).toEqual(['create']);
    });

    // WFT #2551: bash offers only the flags the command accepts (plus the
    // program's global flags), read from each command's own options.
    describe('flags per command (WFT #2551)', () => {
      it('list offers its own flags and the global ones, not project-archive flags', async () => {
        const { reply, stderr } = complete(await bashScript(), ['tasks', 'list', '--']);
        expect(stderr).toBe('');
        for (const flag of [
          '--status',
          '--include-archived',
          '--archived-only',
          '--due-before',
          '--json',
          '--help',
        ]) {
          expect(reply).toContain(flag);
        }
        expect(reply).not.toContain('--reason');
        expect(reply).not.toContain('--with-unfinished');
      });

      it('project-archive offers --reason and --with-unfinished, not list filters', async () => {
        const { reply } = complete(await bashScript(), ['tasks', 'project-archive', '7', '--']);
        expect(reply).toContain('--reason');
        expect(reply).toContain('--with-unfinished');
        expect(reply).toContain('--json');
        expect(reply).not.toContain('--status');
        expect(reply).not.toContain('--include-archived');
      });

      it('a command with no options of its own offers only the global flags', async () => {
        const { reply } = complete(await bashScript(), ['tasks', 'update', '--']);
        expect(reply).toContain('--json');
        expect(reply).not.toContain('--status');
        expect(reply).not.toContain('--reason');
      });

      it('finds the command after global flags, including one that takes a value', async () => {
        const script = await bashScript();
        const afterJson = complete(script, ['tasks', '--json', 'list', '--inc']);
        expect(afterJson.reply).toEqual(['--include-archived']);
        const afterToken = complete(script, ['tasks', '--token', 'abc', 'project-archive', '--wi']);
        expect(afterToken.reply).toEqual(['--with-unfinished']);
        const commandAfterJson = complete(script, ['tasks', '--json', 'cre']);
        expect(commandAfterJson.reply).toEqual(['create']);
      });

      // WFT #2552 point 7: commands with nested subcommands (db, docs,
      // service, models) declare their flags on the subcommand.
      describe('nested subcommands (WFT #2552 point 7)', () => {
        it('after a command with subcommands, a word completes to its subcommand names', async () => {
          const { reply, stderr } = complete(await bashScript(), ['tasks', 'db', '']);
          expect(stderr).toBe('');
          expect(reply.sort()).toEqual(['migrate-identities', 'mint-token']);
          const prefixed = complete(await bashScript(), ['tasks', 'db', 'mi']);
          expect(prefixed.reply.sort()).toEqual(['migrate-identities', 'mint-token']);
        });

        it('a nested subcommand offers its own flags, not its sibling’s', async () => {
          const script = await bashScript();
          const mint = complete(script, ['tasks', 'db', 'mint-token', '--']);
          for (const flag of ['--name', '--expires-at', '--json']) {
            expect(mint.reply).toContain(flag);
          }
          expect(mint.reply).not.toContain('--commit');
          const migrate = complete(script, ['tasks', '--json', 'db', 'migrate-identities', '--co']);
          expect(migrate.reply).toEqual(['--commit']);
        });

        it('a word after the subcommand completes to nothing, not to the subcommands again', async () => {
          const { reply } = complete(await bashScript(), ['tasks', 'db', 'mint-token', '']);
          expect(reply).toEqual([]);
        });
      });

      it('before any command, a flag completes to the global flags only', async () => {
        const { reply } = complete(await bashScript(), ['tasks', '--']);
        expect(reply).toContain('--json');
        expect(reply).toContain('--token');
        expect(reply).not.toContain('--status');
        expect(reply).not.toContain('--with-unfinished');
      });
    });

    it('every compgen call ends its options with `-- "${cur}"`', async () => {
      const lines = (await bashScript()).split('\n').filter((line) => line.includes('compgen'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, line.trim()).toMatch(/" -- "\$\{cur\}"\) \)$/);
      }
    });
  });

  // WFT #2551: the zsh script is executed, not only string-matched. zsh is not
  // on every developer host, so this runs where zsh exists; CI installs zsh
  // and sets WFT_REQUIRE_ZSH=1, which makes a missing zsh a failure there
  // instead of a silent skip.
  describe.runIf(hasZsh() || process.env.WFT_REQUIRE_ZSH === '1')(
    'the generated zsh completion runs in a real zsh (WFT #2551)',
    () => {
      /**
       * Source the script with `_arguments` / `_describe` stubbed to print
       * their specs, and `words` set as compsys would after the command
       * word. Returns the printed specs; asserts zsh exited 0.
       */
      async function zshSpecs(words: string[]): Promise<string[]> {
        consoleLogSpy.mockClear();
        await program.parseAsync(['node', 'tasks', 'completions', 'zsh']);
        const script = consoleLogSpy.mock.calls[0][0] as string;
        const dir = mkdtempSync(join(tmpdir(), 'tasks-completion-zsh-'));
        const file = join(dir, '_tasks');
        try {
          writeFileSync(file, script);
          const driver = [
            'setopt err_exit no_unset',
            'file="$1"; shift',
            'words=("$@")',
            'state=',
            '_arguments() { if [[ "$1" == "-C" ]]; then state=args; return 0; fi; print -rl -- "$@"; }',
            '_describe() { print -rl -- "${(@P)2}"; }',
            'source "$file"',
          ].join('\n');
          const result = spawnSync('zsh', ['-f', '-c', driver, 'zsh', file, ...words], {
            encoding: 'utf8',
          });
          expect(result.error).toBeUndefined();
          expect(result.status, `zsh exited ${String(result.status)}: ${result.stderr}`).toBe(0);
          expect(result.stderr).toBe('');
          return result.stdout.split('\n').filter((line) => line.length > 0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      it('list offers the archived filters and no archive flags', async () => {
        const specs = await zshSpecs(['list', '--']);
        expect(specs.some((s) => s.startsWith('--include-archived['))).toBe(true);
        expect(specs.some((s) => s.startsWith('--status['))).toBe(true);
        expect(specs.some((s) => s.startsWith('--json['))).toBe(true);
        expect(specs.some((s) => s.startsWith('--reason['))).toBe(false);
        expect(specs.some((s) => s.startsWith('--with-unfinished['))).toBe(false);
      });

      it('project-archive offers --reason and --with-unfinished', async () => {
        const specs = await zshSpecs(['project-archive', '7', '--']);
        expect(specs.some((s) => s.startsWith('--reason['))).toBe(true);
        expect(specs.some((s) => s.startsWith('--with-unfinished['))).toBe(true);
        expect(specs.some((s) => s.startsWith('--include-archived['))).toBe(false);
      });
    },
  );

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
