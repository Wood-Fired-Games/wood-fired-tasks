import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

describe('Shell completions', () => {
  const execOpts = {
    encoding: 'utf-8' as const,
    env: { ...process.env, TASKS_API_KEY: 'test-key', TASKS_API_URL: 'http://localhost:3000' },
  };

  describe('bash completions', () => {
    it('generates valid bash completion script', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions bash', execOpts);
      expect(output).toContain('_tasks_completions');
      expect(output).toContain('complete -F _tasks_completions tasks');
    });

    it('includes all main commands', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions bash', execOpts);
      expect(output).toContain('create');
      expect(output).toContain('list');
      expect(output).toContain('update');
      expect(output).toContain('delete');
      expect(output).toContain('show');
      expect(output).toContain('claim');
      expect(output).toContain('health');
      expect(output).toContain('backup');
      expect(output).toContain('doctor');
      expect(output).toContain('stats');
      expect(output).toContain('completed');
      expect(output).toContain('db-check');
      expect(output).toContain('completions');
    });

    it('command list stays in sync with Commander registry (task #247)', () => {
      // Completions must derive from the same Commander program that
      // bin/tasks.ts registers — no parallel hardcoded list.
      const completionOutput = execSync(
        'npx tsx src/cli/bin/tasks.ts completions bash',
        execOpts,
      );
      const helpOutput = execSync('npx tsx src/cli/bin/tasks.ts --help', execOpts);

      const match = completionOutput.match(/commands="([^"]+)"/);
      expect(match).not.toBeNull();
      const completionCommands = match![1].split(/\s+/).filter(Boolean).sort();

      const helpLines = helpOutput.split('\n');
      const cmdSectionStart = helpLines.findIndex((l) => l.trim() === 'Commands:');
      expect(cmdSectionStart).toBeGreaterThan(-1);
      const helpCommands = helpLines
        .slice(cmdSectionStart + 1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => l.split(/\s+/)[0])
        .filter((name) => name !== 'help'); // Commander's built-in help isn't a real command.
      helpCommands.sort();

      expect(completionCommands).toEqual(helpCommands);
    });

    it('includes status enum values', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions bash', execOpts);
      expect(output).toContain('open');
      expect(output).toContain('in_progress');
      expect(output).toContain('done');
      expect(output).toContain('closed');
      expect(output).toContain('blocked');
      expect(output).toContain('backlogged');
    });

    it('includes priority enum values', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions bash', execOpts);
      expect(output).toContain('low');
      expect(output).toContain('medium');
      expect(output).toContain('high');
      expect(output).toContain('urgent');
    });

    it('includes flag completions', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions bash', execOpts);
      expect(output).toContain('--json');
      expect(output).toContain('--force');
      expect(output).toContain('--status');
      expect(output).toContain('--priority');
    });
  });

  describe('zsh completions', () => {
    it('generates valid zsh completion script', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions zsh', execOpts);
      expect(output).toContain('#compdef tasks');
      expect(output).toContain('_tasks');
    });

    it('includes command descriptions', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions zsh', execOpts);
      expect(output).toContain('create');
      expect(output).toContain('list');
      expect(output).toContain('update');
    });

    it('includes subcommand-specific completions', () => {
      const output = execSync('npx tsx src/cli/bin/tasks.ts completions zsh', execOpts);
      expect(output).toContain('--status');
      expect(output).toContain('--priority');
      expect(output).toContain('Filter by status');
    });
  });

  describe('unsupported shell', () => {
    it('exits with error for unknown shell', () => {
      expect(() => {
        execSync('npx tsx src/cli/bin/tasks.ts completions fish', {
          ...execOpts,
          stdio: 'pipe',
        });
      }).toThrow();
    });
  });
});
