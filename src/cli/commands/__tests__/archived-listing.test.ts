/**
 * WFT #2478 (A17) — `--include-archived` / `--archived-only` on
 * `tasks project-list` and `tasks list`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return {
    ...actual,
    listProjects: vi.fn(),
    listTasks: vi.fn(),
    withApiSpinner: vi.fn((_message: string, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../config/env.js', () => ({
  env: { API_BASE_URL: 'http://localhost:3000', API_KEY: 'test-key' },
}));

vi.mock('../../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
}));

describe('archived listing flags (WFT #2478)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
    vi.resetModules();
    const { projectListCommand } = await import('../project-list.js');
    const { listCommand } = await import('../list.js');
    program = new Command();
    program.exitOverride();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.addCommand(projectListCommand);
    program.addCommand(listCommand);
    const client = await import('../../api/client.js');
    vi.mocked(client.listProjects).mockResolvedValue([]);
    vi.mocked(client.listTasks).mockResolvedValue([]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  });

  async function run(...args: string[]): Promise<void> {
    await program.parseAsync(['node', 'tasks', ...args]);
  }

  describe('project-list', () => {
    it.each([
      [[], undefined],
      [['--include-archived'], 'include'],
      [['--archived-only'], 'only'],
    ])('%j sends archived=%s', async (flags, archived) => {
      const { listProjects } = await import('../../api/client.js');

      await run('project-list', ...(flags as string[]));

      const params = vi.mocked(listProjects).mock.calls[0]?.[0] ?? {};
      expect(params.archived).toBe(archived);
      expect(process.exitCode).toBe(0);
    });

    it('both flags together are a usage error and call nothing', async () => {
      const { listProjects } = await import('../../api/client.js');

      await run('project-list', '--include-archived', '--archived-only');

      expect(listProjects).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not both'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('list', () => {
    it.each([
      [[], undefined],
      [['--include-archived'], 'include'],
      [['--archived-only'], 'only'],
    ])('%j sends archived=%s', async (flags, archived) => {
      const { listTasks } = await import('../../api/client.js');

      await run('list', ...(flags as string[]));

      const filters = vi.mocked(listTasks).mock.calls[0]?.[0] ?? {};
      expect(filters.archived).toBe(archived);
      expect(process.exitCode).toBe(0);
    });

    it('both flags together are a usage error and call nothing', async () => {
      const { listTasks } = await import('../../api/client.js');

      await run('list', '--include-archived', '--archived-only');

      expect(listTasks).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
