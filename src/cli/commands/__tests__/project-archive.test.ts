/**
 * WFT #2477 (A16) — `tasks project-archive` and `tasks project-unarchive`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return {
    ...actual,
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
  };
});

vi.mock('../../config/env.js', () => ({
  env: { API_BASE_URL: 'http://localhost:3000', API_KEY: 'test-key' },
}));

vi.mock('../../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
}));

vi.mock('../../output/formatters.js', () => ({
  formatProjectDetail: vi.fn((project) => `Project #${project.id}: ${project.name}`),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
}));

const archived = {
  id: 7,
  name: 'Shipped',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  archived: true,
  archived_at: '2026-01-02T00:00:00.000Z',
  archived_by: 'alice',
  archive_reason: 'shipped',
};

const unarchived = {
  ...archived,
  archived: false,
  archived_at: null,
  archived_by: null,
  archive_reason: null,
};

describe('project-archive / project-unarchive commands (WFT #2477)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
    // Fresh command instances per test: commander keeps parsed option values.
    vi.resetModules();
    const { projectArchiveCommand } = await import('../project-archive.js');
    const { projectUnarchiveCommand } = await import('../project-unarchive.js');
    program = new Command();
    program.exitOverride();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts for destructive actions');
    program.addCommand(projectArchiveCommand);
    program.addCommand(projectUnarchiveCommand);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  });

  async function client() {
    return import('../../api/client.js');
  }

  async function run(...args: string[]): Promise<void> {
    await program.parseAsync(['node', 'tasks', ...args]);
  }

  describe('project-archive', () => {
    it('archives with no options and prints the project', async () => {
      const { archiveProject } = await client();
      vi.mocked(archiveProject).mockResolvedValue(archived);

      await run('project-archive', '7');

      expect(archiveProject).toHaveBeenCalledWith(7, {});
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Project #7 archived'));
      expect(process.exitCode).toBe(0);
    });

    // The archive override is `--with-unfinished` (verifier decision on PR
    // #171). The global `--force` means only "skip prompts": it never forces
    // an archive, wherever it sits on the line.
    describe('--with-unfinished, and the global --force that never forces', () => {
      const unfinished =
        'project_has_unfinished_tasks: project 7 has 1 unfinished task (open: 1, in_progress: 0, ' +
        'blocked: 0, backlogged: 0); finish or close them, or archive with force: true and a reason';

      it('(a) global --force plus --reason on a project with unfinished tasks is refused as before', async () => {
        const { archiveProject, ApiClientError } = await client();
        vi.mocked(archiveProject).mockRejectedValue(
          new ApiClientError(unfinished, 422, {
            error: 'BUSINESS_RULE_VIOLATION',
            message: unfinished,
          }),
        );

        await run('--force', 'project-archive', '7', '--reason', 'shelved');

        // No force is sent: the reason alone is an ordinary archive's reason.
        expect(archiveProject).toHaveBeenCalledWith(7, { reason: 'shelved' });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('project_has_unfinished_tasks'),
        );
        expect(process.exitCode).toBe(1);
      });

      it('(b) global --force alone on a finished project archives cleanly', async () => {
        const { archiveProject } = await client();
        vi.mocked(archiveProject).mockResolvedValue(archived);

        await run('--force', 'project-archive', '7');

        expect(archiveProject).toHaveBeenCalledWith(7, {});
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Project #7 archived'));
        expect(process.exitCode).toBe(0);
      });

      it('a --force after the command name is the same global flag and forces nothing', async () => {
        const { archiveProject } = await client();
        vi.mocked(archiveProject).mockResolvedValue(archived);

        await run('project-archive', '7', '--reason', 'shipped', '--force');

        expect(archiveProject).toHaveBeenCalledWith(7, { reason: 'shipped' });
        expect(process.exitCode).toBe(0);
      });

      it('a --force between the id and --reason is the same global flag and forces nothing', async () => {
        const { archiveProject } = await client();
        vi.mocked(archiveProject).mockResolvedValue(archived);

        await run('project-archive', '7', '--force', '--reason', 'x');

        expect(archiveProject).toHaveBeenCalledWith(7, { reason: 'x' });
        expect(process.exitCode).toBe(0);
      });

      it('(c) --with-unfinished without --reason is refused without calling the API', async () => {
        const { archiveProject } = await client();

        await run('project-archive', '7', '--with-unfinished');

        expect(archiveProject).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('--with-unfinished requires --reason'),
        );
        expect(process.exitCode).toBe(1);
      });

      it('(d) --with-unfinished with --reason forces the archive', async () => {
        const { archiveProject } = await client();
        vi.mocked(archiveProject).mockResolvedValue(archived);

        await run('project-archive', '7', '--with-unfinished', '--reason', 'shelved');

        expect(archiveProject).toHaveBeenCalledWith(7, { reason: 'shelved', force: true });
        expect(process.exitCode).toBe(0);
      });

      it('help names --with-unfinished and no longer offers a --force of its own', async () => {
        const { projectArchiveCommand } = await import('../project-archive.js');
        const help = projectArchiveCommand.helpInformation();
        expect(help).toContain('--with-unfinished');
        expect(help).not.toMatch(/^\s+--force\b/m);
      });
    });

    it('--json prints the project in the JSON envelope', async () => {
      const { archiveProject } = await client();
      const { jsonOutput } = await import('../../output/json-output.js');
      vi.mocked(archiveProject).mockResolvedValue(archived);

      await run('--json', 'project-archive', '7');

      expect(jsonOutput).toHaveBeenCalledWith({ project: archived });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('a 422 prints the server message with its counts and exits non-zero', async () => {
      const { archiveProject, ApiClientError } = await client();
      const message =
        'project_has_unfinished_tasks: project 7 has 1 unfinished task (open: 1, in_progress: 0, ' +
        'blocked: 0, backlogged: 0); finish or close them, or archive with force: true and a reason';
      vi.mocked(archiveProject).mockRejectedValue(
        new ApiClientError(message, 422, { error: 'BUSINESS_RULE_VIOLATION', message }),
      );

      await run('project-archive', '7');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(process.exitCode).toBe(1);
    });

    it.each(['abc', '7abc', '0', '-1'])('rejects the id %s without calling the API', async (id) => {
      const { archiveProject } = await client();

      await run('project-archive', '--', id);

      expect(archiveProject).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid project ID'));
      expect(process.exitCode).toBe(1);
    });
  });

  describe('project-unarchive', () => {
    it('unarchives and prints the project', async () => {
      const { unarchiveProject } = await client();
      vi.mocked(unarchiveProject).mockResolvedValue(unarchived);

      await run('project-unarchive', '7');

      expect(unarchiveProject).toHaveBeenCalledWith(7);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Project #7 unarchived'));
      expect(process.exitCode).toBe(0);
    });

    it('--json prints the project in the JSON envelope', async () => {
      const { unarchiveProject } = await client();
      const { jsonOutput } = await import('../../output/json-output.js');
      vi.mocked(unarchiveProject).mockResolvedValue(unarchived);

      await run('--json', 'project-unarchive', '7');

      expect(jsonOutput).toHaveBeenCalledWith({ project: unarchived });
    });

    it('names the tasks whose re-evaluation failed on stderr, and still exits 0 (WFT #2542)', async () => {
      const { unarchiveProject } = await client();
      vi.mocked(unarchiveProject).mockResolvedValue({
        ...unarchived,
        reevaluation_failed_task_ids: [41, 42],
      });

      await run('project-unarchive', '7');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Project #7 unarchived'));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('re-evaluation failed for tasks 41, 42'),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('tasks project-unarchive 7'));
      expect(process.exitCode).toBe(0);
    });

    it('--json carries reevaluation_failed_task_ids in the project envelope (WFT #2542)', async () => {
      const { unarchiveProject } = await client();
      const { jsonOutput } = await import('../../output/json-output.js');
      const partial = { ...unarchived, reevaluation_failed_task_ids: [41] };
      vi.mocked(unarchiveProject).mockResolvedValue(partial);

      await run('--json', 'project-unarchive', '7');

      expect(jsonOutput).toHaveBeenCalledWith({ project: partial });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('prints no warning when no task failed', async () => {
      const { unarchiveProject } = await client();
      vi.mocked(unarchiveProject).mockResolvedValue({
        ...unarchived,
        reevaluation_failed_task_ids: [],
      });

      await run('project-unarchive', '7');

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a 404 exits non-zero', async () => {
      const { unarchiveProject, ApiClientError } = await client();
      vi.mocked(unarchiveProject).mockRejectedValue(
        new ApiClientError('Project with id 99 not found', 404, {
          error: 'NOT_FOUND',
          message: 'Project with id 99 not found',
        }),
      );

      await run('project-unarchive', '99');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
      expect(process.exitCode).toBe(1);
    });

    it('rejects a non-numeric id without calling the API', async () => {
      const { unarchiveProject } = await client();

      await run('project-unarchive', 'seven');

      expect(unarchiveProject).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
