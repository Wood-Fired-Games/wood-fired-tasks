/**
 * Regression guard for wood-fired-tasks #334.
 *
 * `src/cli/bin/tasks.ts` exports `program` so that tests can drive
 * `program.parseAsync(...)` themselves. The module's bottom `if (isMain(...))`
 * guard must keep auto-parse from firing during import (otherwise the test
 * harness itself would race with whatever args vitest was invoked with).
 *
 * We rely on Commander's behavior: if `parseAsync` ran on import, the
 * program's `args` / `_optionValues` would already be populated. We check
 * that they are not, then explicitly call `parseAsync` ourselves and
 * confirm it works end-to-end (no crash on a benign flag).
 */
import { describe, it, expect } from 'vitest';

describe('bin/tasks.ts side-effect guard', () => {
  it('does not auto-parse argv on import (isMain returns false in vitest)', async () => {
    const { program } = await import('../bin/tasks.js');

    // Commander populates `args` (positional) after `parseAsync`. Before any
    // explicit parse, it must be empty — proving the bottom guard fired
    // false and parseAsync was NOT invoked during the import side-effect.
    expect(program.args).toEqual([]);

    // And the suite of subcommands should still be registered (sanity:
    // the module's top-level setup did execute, only the parse was skipped).
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames.length).toBeGreaterThanOrEqual(10);
    expect(commandNames).toContain('create');
    expect(commandNames).toContain('list');
  });

  it('lets a test driver invoke parseAsync explicitly without prior side effects', async () => {
    const { program } = await import('../bin/tasks.js');

    // Configure Commander to throw instead of calling process.exit so that
    // `--version` is observable from the test. Without this, Commander
    // would terminate the test runner.
    program.exitOverride();

    let versionOut = '';
    program.configureOutput({
      writeOut: (s) => {
        versionOut += s;
      },
      writeErr: () => {},
    });

    // Commander throws a CommanderError with code `commander.version` on
    // --version when exitOverride is set. We swallow it; the assertion is
    // on the captured output.
    try {
      await program.parseAsync(['node', 'tasks', '--version']);
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code).toBe('commander.version');
    }

    expect(versionOut.trim()).toBe('1.11.0');
  });
});
