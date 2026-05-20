/**
 * CLI output snapshot tests (task 211).
 *
 * Captures HUMAN (default) and JSON (`--json`) output for a representative
 * subset of CLI commands and asserts against `toMatchSnapshot()`. The actual
 * formatters are NOT mocked — the API client is mocked so we exercise the
 * real terminal-rendering code path.
 *
 * Determinism:
 *  - `NO_COLOR=1` is forced via the env mock so `shouldUseColor()` returns
 *    false → no ANSI escape sequences in human output.
 *  - `chalk.level = 0` is also pinned as a belt-and-braces guard.
 *  - Locale-dependent fields (timestamps rendered by `toLocaleString()` /
 *    `toLocaleDateString()`) are scrubbed before snapshotting.
 *  - All mock data uses fixed IDs so no randomness leaks in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import chalk from 'chalk';

// Mock the API client module — preserve ApiClientError so error paths work.
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    listTasks: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    addComment: vi.fn(),
    listProjects: vi.fn(),
  };
});

// Mock the env module to avoid validation errors at import time.
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock spinner — pass-through so we can assert on the wrapped output without
// terminal control codes from ora.
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Mock prompts — every prompt simply returns the supplied value (no stdin).
vi.mock('../prompts/interactive.js', () => ({
  promptForMissing: vi.fn((_field, value) => Promise.resolve(value)),
  shouldPrompt: vi.fn(() => false),
}));

// NOTE: formatters.js and json-output.js are intentionally NOT mocked —
// we want the real output.

/**
 * Scrub locale/timezone-dependent fields out of captured output so the
 * snapshot is stable across CI environments and host locales.
 *
 *  - ISO-8601 timestamps in JSON payloads pass through verbatim (they are
 *    embedded as literal strings in the mock data, not re-formatted).
 *  - `new Date(...).toLocaleString()` / `toLocaleDateString()` output is
 *    replaced with a fixed placeholder. We match the two common locale
 *    formats: "M/D/YYYY" and "M/D/YYYY, h:mm:ss AM/PM".
 */
function scrubOutput(text: string): string {
  return (
    text
      // Strip ANSI escapes (defense in depth — should already be off via NO_COLOR).
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;]*m/g, '')
      // Locale date+time: "5/20/2026, 1:23:45 PM" or "5/20/2026, 13:23:45"
      .replace(
        /\b\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\b/g,
        '<LOCALE_DATETIME>'
      )
      // Locale date only: "5/20/2026"
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, '<LOCALE_DATE>')
  );
}

/**
 * Capture everything written to stdout (`process.stdout.write` + `console.log`)
 * during the execution of `fn`. Returns the scrubbed combined output.
 */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((data: string | Uint8Array) => {
      chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      return true;
    });
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  try {
    await fn();
  } finally {
    stdoutSpy.mockRestore();
    consoleLogSpy.mockRestore();
  }
  return scrubOutput(chunks.join(''));
}

// ── Fixture data ────────────────────────────────────────────────────────────

const FIXED_DATE_A = '2026-02-13T10:30:00Z';
const FIXED_DATE_B = '2026-02-14T15:45:00Z';
const FIXED_DUE = '2026-03-15T00:00:00Z';

const TASK_1 = {
  id: 1,
  title: 'Fix login button on mobile',
  description: null,
  status: 'open' as const,
  priority: 'high' as const,
  project_id: 1,
  assignee: 'stuart',
  created_by: 'stuart',
  due_date: FIXED_DUE,
  created_at: FIXED_DATE_A,
  updated_at: FIXED_DATE_A,
  tags: ['bug', 'mobile'],
};

const TASK_2 = {
  id: 2,
  title: 'Add dark mode toggle',
  description: 'Users have requested a dark mode option.',
  status: 'in_progress' as const,
  priority: 'medium' as const,
  project_id: 1,
  assignee: 'alice',
  created_by: 'stuart',
  due_date: null,
  created_at: FIXED_DATE_B,
  updated_at: FIXED_DATE_B,
  tags: ['feature', 'ui'],
};

const TASK_3 = {
  id: 3,
  title: 'Refactor auth middleware',
  description: null,
  status: 'done' as const,
  priority: 'low' as const,
  project_id: 2,
  assignee: 'bob',
  created_by: 'bob',
  due_date: null,
  created_at: FIXED_DATE_A,
  updated_at: FIXED_DATE_B,
  tags: [],
};

const PROJECT_1 = {
  id: 1,
  name: 'Web App',
  description: 'Customer-facing web application',
  created_at: FIXED_DATE_A,
  updated_at: FIXED_DATE_A,
};

const PROJECT_2 = {
  id: 2,
  name: 'Internal Tools',
  description: null,
  created_at: FIXED_DATE_B,
  updated_at: FIXED_DATE_B,
};

const COMMENT_1 = {
  id: 10,
  task_id: 1,
  author: 'stuart',
  content: 'Reproduced on iOS 17.4 — investigating.',
  created_at: FIXED_DATE_A,
};

// ── Test driver helpers ─────────────────────────────────────────────────────

async function buildProgramWith(commands: Command[]): Promise<Command> {
  const program = new Command();
  program.option('--json', 'Output as JSON (machine-readable)');
  program.option('--no-input', 'Disable interactive prompts');
  program.option('--force', 'Skip confirmation prompts');
  for (const cmd of commands) {
    program.addCommand(cmd);
  }
  return program;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CLI output snapshots', () => {
  let originalNoColor: string | undefined;
  let originalChalkLevel: number;

  beforeEach(() => {
    vi.clearAllMocks();
    // Pin color off via the public no-color contract used by shouldUseColor().
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    // Belt-and-braces: also clamp chalk's level so anything that bypasses
    // shouldUseColor() still produces deterministic output.
    originalChalkLevel = chalk.level;
    chalk.level = 0;
    process.exitCode = 0;
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    chalk.level = originalChalkLevel;
  });

  // 1. list tasks ────────────────────────────────────────────────────────────
  describe('list', () => {
    it('human mode renders a task table + count footer', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_1, TASK_2, TASK_3]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'list'])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits a parseable envelope', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_1, TASK_2, TASK_3]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', '--json', 'list'])
      );
      expect(out).toMatchSnapshot();
      // Also sanity-check parseability.
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 2. show task ─────────────────────────────────────────────────────────────
  describe('show', () => {
    it('human mode renders a task detail block', async () => {
      const { getTask } = await import('../api/client.js');
      vi.mocked(getTask).mockResolvedValue(TASK_2);
      const { showCommand } = await import('../commands/show.js');
      const program = await buildProgramWith([showCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'show', '2'])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits a single-task envelope', async () => {
      const { getTask } = await import('../api/client.js');
      vi.mocked(getTask).mockResolvedValue(TASK_2);
      const { showCommand } = await import('../commands/show.js');
      const program = await buildProgramWith([showCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', '--json', 'show', '2'])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 3. project-list ("project status") ───────────────────────────────────────
  describe('project-list', () => {
    it('human mode renders a project table + count footer', async () => {
      const { listProjects } = await import('../api/client.js');
      vi.mocked(listProjects).mockResolvedValue([PROJECT_1, PROJECT_2]);
      const { projectListCommand } = await import('../commands/project-list.js');
      const program = await buildProgramWith([projectListCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'project-list'])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits a project-list envelope', async () => {
      const { listProjects } = await import('../api/client.js');
      vi.mocked(listProjects).mockResolvedValue([PROJECT_1, PROJECT_2]);
      const { projectListCommand } = await import('../commands/project-list.js');
      const program = await buildProgramWith([projectListCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', '--json', 'project-list'])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 4. my-work (list -a <user>) ──────────────────────────────────────────────
  describe('my-work (list --assignee)', () => {
    it('human mode renders only my tasks', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_1]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'list', '-a', 'stuart'])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits filtered envelope', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_1]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', '--json', 'list', '-a', 'stuart'])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 5. search (list --search) ────────────────────────────────────────────────
  describe('search (list --search)', () => {
    it('human mode renders matching tasks', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_2]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'list', '--search', 'dark mode'])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits matching tasks envelope', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([TASK_2]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--json',
          'list',
          '--search',
          'dark mode',
        ])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('human mode renders empty-results message when no matches', async () => {
      const { listTasks } = await import('../api/client.js');
      vi.mocked(listTasks).mockResolvedValue([]);
      const { listCommand } = await import('../commands/list.js');
      const program = await buildProgramWith([listCommand]);

      const out = await captureOutput(() =>
        program.parseAsync(['node', 'tasks', 'list', '--search', 'xyzzy'])
      );
      expect(out).toMatchSnapshot();
    });
  });

  // 6. create task ───────────────────────────────────────────────────────────
  describe('create', () => {
    it('human mode renders success message + task detail', async () => {
      const { createTask } = await import('../api/client.js');
      vi.mocked(createTask).mockResolvedValue(TASK_1);
      const { createCommand } = await import('../commands/create.js');
      const program = await buildProgramWith([createCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--no-input',
          'create',
          '-t',
          'Fix login button on mobile',
          '-p',
          '1',
          '-c',
          'stuart',
          '--priority',
          'high',
          '-a',
          'stuart',
          '--due',
          FIXED_DUE,
          '--tags',
          'bug,mobile',
        ])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits the created task envelope', async () => {
      const { createTask } = await import('../api/client.js');
      vi.mocked(createTask).mockResolvedValue(TASK_1);
      const { createCommand } = await import('../commands/create.js');
      const program = await buildProgramWith([createCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--json',
          '--no-input',
          'create',
          '-t',
          'Fix login button on mobile',
          '-p',
          '1',
          '-c',
          'stuart',
          '--priority',
          'high',
          '-a',
          'stuart',
          '--due',
          FIXED_DUE,
          '--tags',
          'bug,mobile',
        ])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 7. add-comment (comment-add) ─────────────────────────────────────────────
  describe('comment-add', () => {
    it('human mode renders confirmation message', async () => {
      const { addComment } = await import('../api/client.js');
      vi.mocked(addComment).mockResolvedValue(COMMENT_1);
      const { commentAddCommand } = await import('../commands/comment-add.js');
      const program = await buildProgramWith([commentAddCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--no-input',
          'comment-add',
          '1',
          '-a',
          'stuart',
          '-c',
          'Reproduced on iOS 17.4 — investigating.',
        ])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits the comment envelope', async () => {
      const { addComment } = await import('../api/client.js');
      vi.mocked(addComment).mockResolvedValue(COMMENT_1);
      const { commentAddCommand } = await import('../commands/comment-add.js');
      const program = await buildProgramWith([commentAddCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--json',
          '--no-input',
          'comment-add',
          '1',
          '-a',
          'stuart',
          '-c',
          'Reproduced on iOS 17.4 — investigating.',
        ])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  // 8. done (update -s done) ─────────────────────────────────────────────────
  describe('done (update --status done)', () => {
    it('human mode renders success message + updated task detail', async () => {
      const { updateTask } = await import('../api/client.js');
      vi.mocked(updateTask).mockResolvedValue({ ...TASK_3, status: 'done' });
      const { updateCommand } = await import('../commands/update.js');
      const program = await buildProgramWith([updateCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          'update',
          '3',
          '-s',
          'done',
        ])
      );
      expect(out).toMatchSnapshot();
    });

    it('JSON mode emits the updated task envelope', async () => {
      const { updateTask } = await import('../api/client.js');
      vi.mocked(updateTask).mockResolvedValue({ ...TASK_3, status: 'done' });
      const { updateCommand } = await import('../commands/update.js');
      const program = await buildProgramWith([updateCommand]);

      const out = await captureOutput(() =>
        program.parseAsync([
          'node',
          'tasks',
          '--json',
          'update',
          '3',
          '-s',
          'done',
        ])
      );
      expect(out).toMatchSnapshot();
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });
});
