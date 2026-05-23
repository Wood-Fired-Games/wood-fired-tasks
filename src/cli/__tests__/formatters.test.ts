/**
 * Pure-function unit tests for src/cli/output/formatters.ts (task #249).
 *
 * Targets the bare-spot files identified in #199 — pre-existing test coverage
 * exercised only ~37 % of the formatter surface area. These tests cover the
 * remaining helpers (color helpers, status/priority routes, table renderers,
 * detail renderers, dependency list, health rendering).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
const ORIGINAL_ARGV = [...process.argv];

async function loadModule() {
  // Force chalk to think the terminal supports colors; explicit setting of
  // process.env.NO_COLOR / argv inside each test still drives the formatter
  // decisions.
  chalk.level = 1;
  return import('../output/formatters.js');
}

describe('formatters: color gating', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('isJsonMode true when --json is present', async () => {
    process.argv = ['node', 'tasks', '--json', 'list'];
    const { isJsonMode } = await loadModule();
    expect(isJsonMode()).toBe(true);
  });

  it('isJsonMode false when --json absent', async () => {
    process.argv = ['node', 'tasks', 'list'];
    const { isJsonMode } = await loadModule();
    expect(isJsonMode()).toBe(false);
  });

  it('shouldUseColor false when NO_COLOR is set (any value)', async () => {
    process.env.NO_COLOR = '1';
    const { shouldUseColor } = await loadModule();
    expect(shouldUseColor()).toBe(false);
  });

  it('shouldUseColor false in JSON mode', async () => {
    process.argv = ['node', 'tasks', '--json', 'list'];
    const { shouldUseColor } = await loadModule();
    expect(shouldUseColor()).toBe(false);
  });

  it('shouldUseColor true in normal terminal mode', async () => {
    const { shouldUseColor } = await loadModule();
    expect(shouldUseColor()).toBe(true);
  });
});

describe('formatters: color helpers', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('color helpers wrap text in chalk when colors enabled', async () => {
    const mod = await loadModule();
    expect(mod.colorSuccess('ok')).not.toBe('ok'); // ANSI escapes present
    expect(mod.colorError('bad')).not.toBe('bad');
    expect(mod.colorWarn('warn')).not.toBe('warn');
    expect(mod.colorInfo('hint')).not.toBe('hint');
    expect(mod.colorBold('hdr')).not.toBe('hdr');
  });

  it('color helpers return raw text when colors disabled', async () => {
    process.env.NO_COLOR = '1';
    const mod = await loadModule();
    expect(mod.colorSuccess('ok')).toBe('ok');
    expect(mod.colorError('bad')).toBe('bad');
    expect(mod.colorWarn('warn')).toBe('warn');
    expect(mod.colorInfo('hint')).toBe('hint');
    expect(mod.colorBold('hdr')).toBe('hdr');
  });

  it('stripAnsiIfJsonMode passes raw text through outside JSON mode', async () => {
    const colored = '[31mhello[0m';
    process.argv = ['node', 'tasks', 'list'];
    const mod = await loadModule();
    expect(mod.stripAnsiIfJsonMode(colored)).toBe(colored);
  });

  it('stripAnsiIfJsonMode strips ANSI escape codes in JSON mode', async () => {
    const colored = '[31mhello[0m';
    process.argv = ['node', 'tasks', '--json', 'list'];
    const mod = await loadModule();
    expect(mod.stripAnsiIfJsonMode(colored)).toBe('hello');
  });
});

describe('formatters: formatStatus', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('returns raw value when colors disabled', async () => {
    process.env.NO_COLOR = '1';
    const { formatStatus } = await loadModule();
    expect(formatStatus('open')).toBe('open');
    expect(formatStatus('done')).toBe('done');
    expect(formatStatus('unknown_status')).toBe('unknown_status');
  });

  it('wraps known statuses in colored output', async () => {
    const { formatStatus } = await loadModule();
    for (const s of [
      'open',
      'in_progress',
      'done',
      'closed',
      'blocked',
      'backlogged',
    ]) {
      const out = formatStatus(s);
      expect(out).toContain(s);
      expect(out).not.toBe(s); // chalk wrapped it
    }
  });

  it('default branch handles unknown status with white color', async () => {
    const { formatStatus } = await loadModule();
    const out = formatStatus('weird');
    expect(out).toContain('weird');
  });
});

describe('formatters: formatPriority', () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('returns raw value when colors disabled', async () => {
    process.env.NO_COLOR = '1';
    const { formatPriority } = await loadModule();
    expect(formatPriority('urgent')).toBe('urgent');
    expect(formatPriority('low')).toBe('low');
  });

  it('wraps known priorities in colored output', async () => {
    const { formatPriority } = await loadModule();
    for (const p of ['urgent', 'high', 'medium', 'low']) {
      const out = formatPriority(p);
      expect(out).toContain(p);
      expect(out).not.toBe(p);
    }
  });

  it('default branch handles unknown priority', async () => {
    const { formatPriority } = await loadModule();
    expect(formatPriority('mystery')).toContain('mystery');
  });
});

const baseTask = {
  id: 42,
  title: 'Example task',
  description: 'A description',
  status: 'open' as const,
  priority: 'high' as const,
  project_id: 1,
  parent_task_id: null,
  estimated_minutes: null,
  assignee: 'alice',
  created_by: 'tester',
  due_date: '2026-06-01T00:00:00Z',
  created_at: '2026-05-21T10:00:00Z',
  updated_at: '2026-05-21T10:00:00Z',
  version: 1,
  claimed_at: null,
  tags: ['x', 'y'],
};

describe('formatters: task renderers', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('formatTaskTable renders a table with task fields', async () => {
    const { formatTaskTable } = await loadModule();
    const out = formatTaskTable([baseTask]);
    expect(out).toContain('Example task');
    expect(out).toContain('open');
    expect(out).toContain('high');
    expect(out).toContain('alice');
  });

  it('formatTaskTable truncates long titles to 45 chars + ellipsis', async () => {
    const { formatTaskTable } = await loadModule();
    const longTitle = 'a'.repeat(80);
    const out = formatTaskTable([{ ...baseTask, title: longTitle }]);
    expect(out).toContain('...');
    expect(out).not.toContain('a'.repeat(80));
  });

  it('formatTaskTable handles tasks without assignee or due_date', async () => {
    const { formatTaskTable } = await loadModule();
    const out = formatTaskTable([{ ...baseTask, assignee: null, due_date: null }]);
    expect(out).toContain('-');
  });

  it('formatTaskDetail renders all primary fields', async () => {
    const { formatTaskDetail } = await loadModule();
    const out = formatTaskDetail(baseTask);
    expect(out).toContain('ID:');
    expect(out).toContain('42');
    expect(out).toContain('Title:');
    expect(out).toContain('Example task');
    expect(out).toContain('Status:');
    expect(out).toContain('open');
    expect(out).toContain('Priority:');
    expect(out).toContain('high');
    expect(out).toContain('Project:');
    expect(out).toContain('1');
    expect(out).toContain('Assignee:');
    expect(out).toContain('alice');
    expect(out).toContain('Created by:');
    expect(out).toContain('Tags:');
    expect(out).toContain('x, y');
    expect(out).toContain('Description:');
    expect(out).toContain('A description');
  });

  it('formatTaskDetail renders acceptance_criteria block when present (#311)', async () => {
    const { formatTaskDetail } = await loadModule();
    const out = formatTaskDetail({
      ...baseTask,
      acceptance_criteria: 'Build green; lint clean.',
    });
    expect(out).toContain('Acceptance criteria:');
    expect(out).toContain('Build green; lint clean.');
  });

  it('formatTaskDetail omits acceptance_criteria block when null (#311)', async () => {
    const { formatTaskDetail } = await loadModule();
    const out = formatTaskDetail({
      ...baseTask,
      acceptance_criteria: null,
    });
    expect(out).not.toContain('Acceptance criteria:');
  });

  it('formatTaskDetail omits empty description block and renders dashes for null fields', async () => {
    const { formatTaskDetail } = await loadModule();
    const out = formatTaskDetail({
      ...baseTask,
      description: null,
      assignee: null,
      due_date: null,
      tags: [],
    });
    expect(out).not.toContain('Description:');
    // null fields render as '-'
    expect(out).toMatch(/Assignee:\s+-/);
    expect(out).toMatch(/Due date:\s+-/);
    expect(out).toMatch(/Tags:\s+-/);
  });
});

const baseProject = {
  id: 7,
  name: 'wood-fired-bugs',
  description: 'An example project',
  created_at: '2026-05-21T10:00:00Z',
  updated_at: '2026-05-21T10:00:00Z',
};

describe('formatters: project renderers', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('formatProjectTable shows project rows', async () => {
    const { formatProjectTable } = await loadModule();
    const out = formatProjectTable([baseProject]);
    expect(out).toContain('wood-fired-bugs');
    expect(out).toContain('An example project');
  });

  it('formatProjectTable truncates long descriptions', async () => {
    const { formatProjectTable } = await loadModule();
    const longDesc = 'b'.repeat(120);
    const out = formatProjectTable([{ ...baseProject, description: longDesc }]);
    expect(out).toContain('...');
  });

  it('formatProjectTable replaces missing description with a dash', async () => {
    const { formatProjectTable } = await loadModule();
    const out = formatProjectTable([{ ...baseProject, description: null }]);
    expect(out).toContain('-');
  });

  it('formatProjectDetail renders all keys', async () => {
    const { formatProjectDetail } = await loadModule();
    const out = formatProjectDetail(baseProject);
    expect(out).toContain('ID:');
    expect(out).toContain('Name:');
    expect(out).toContain('wood-fired-bugs');
    expect(out).toContain('Description:');
    expect(out).toContain('Created:');
    expect(out).toContain('Updated:');
  });

  it('formatProjectDetail prints dash when description is null', async () => {
    const { formatProjectDetail } = await loadModule();
    const out = formatProjectDetail({ ...baseProject, description: null });
    expect(out).toMatch(/Description:\s+-/);
  });
});

describe('formatters: dependency + comment + health', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
    process.argv = ['node', 'test'];
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
    process.argv = [...ORIGINAL_ARGV];
  });

  it('formatDependencyList shows both blocks and blocked_by sections', async () => {
    const { formatDependencyList } = await loadModule();
    const out = formatDependencyList({
      blocks: [{ id: 1, task_id: 100, blocks_task_id: 200, created_at: 't' }],
      blocked_by: [
        // Direction reversed: this row says "task 300 blocks task 100".
        { id: 2, task_id: 300, blocks_task_id: 100, created_at: 't' },
      ],
    });
    expect(out).toContain('Blocks (this task blocks):');
    expect(out).toContain('Task #200');
    expect(out).toContain('Blocked by');
    expect(out).toContain('Task #300');
  });

  it('formatDependencyList renders "None" for empty sections', async () => {
    const { formatDependencyList } = await loadModule();
    const out = formatDependencyList({ blocks: [], blocked_by: [] });
    const noneOccurrences = (out.match(/None/g) || []).length;
    expect(noneOccurrences).toBe(2);
  });

  it('formatCommentList returns "No comments" for empty input', async () => {
    const { formatCommentList } = await loadModule();
    expect(formatCommentList([])).toBe('No comments');
  });

  it('formatCommentList renders timestamp, author, and indented content', async () => {
    const { formatCommentList } = await loadModule();
    const out = formatCommentList([
      {
        id: 1,
        task_id: 100,
        author: 'alice',
        content: 'line1\nline2',
        created_at: '2026-05-21T10:00:00Z',
      },
    ]);
    expect(out).toContain('alice');
    expect(out).toContain('  line1');
    expect(out).toContain('  line2');
  });

  it('formatHealthStatus shows healthy + connected', async () => {
    const { formatHealthStatus } = await loadModule();
    const out = formatHealthStatus({
      status: 'healthy',
      timestamp: '2026-05-21T10:00:00Z',
      version: '1.2.3',
      checks: { database: 'ok' },
    });
    expect(out).toContain('Service Status:');
    expect(out).toContain('OK');
    expect(out).toContain('Connected');
    expect(out).toContain('Version:');
    expect(out).toContain('1.2.3');
    expect(out).toContain('Last checked:');
  });

  it('formatHealthStatus shows unhealthy + disconnected', async () => {
    const { formatHealthStatus } = await loadModule();
    const out = formatHealthStatus({
      status: 'unhealthy',
      timestamp: '2026-05-21T10:00:00Z',
      version: '1.2.3',
      checks: { database: 'failed' },
    });
    expect(out).toContain('ERROR');
    expect(out).toContain('Disconnected');
  });

  it('formatHealthStatus omits version when empty string', async () => {
    const { formatHealthStatus } = await loadModule();
    const out = formatHealthStatus({
      status: 'healthy',
      timestamp: '2026-05-21T10:00:00Z',
      version: '',
      checks: { database: 'ok' },
    });
    expect(out).not.toContain('Version:');
  });
});
