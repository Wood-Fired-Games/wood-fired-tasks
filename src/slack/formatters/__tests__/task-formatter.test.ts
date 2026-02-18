import { describe, it, expect } from 'vitest';
import type { KnownBlock, SectionBlock, HeaderBlock, ContextBlock } from '@slack/types';
import type { Task } from '../../../types/task.js';
import type { TaskEvent } from '../../../events/types.js';
import {
  formatTaskList,
  formatTaskDetail,
  formatTaskNotification,
} from '../../task-formatter.js';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task & { tags: string[] }> = {}): Task & { tags: string[] } {
  return {
    id: 1,
    title: 'Fix login bug',
    description: null,
    status: 'open',
    priority: 'medium',
    project_id: 10,
    parent_task_id: null,
    estimated_minutes: null,
    assignee: 'alice',
    created_by: 'bob',
    due_date: '2026-03-01',
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    version: 1,
    claimed_at: null,
    tags: [],
    ...overrides,
  };
}

function makeTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    eventType: 'task.created',
    timestamp: '2026-02-01T00:00:00Z',
    data: makeTask(),
    metadata: {
      source: 'user',
      actor: 'alice',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatTaskList
// ---------------------------------------------------------------------------

describe('formatTaskList', () => {
  it('returns a single section with no-tasks message for empty array', () => {
    const blocks = formatTaskList([]);
    expect(blocks).toHaveLength(1);
    const section = blocks[0] as SectionBlock;
    expect(section.type).toBe('section');
    expect(section.text?.text).toBe('_No tasks found._');
  });

  it('returns header block with task count for non-empty array', () => {
    const tasks = [makeTask()];
    const blocks = formatTaskList(tasks);
    expect(blocks[0].type).toBe('header');
    const header = blocks[0] as HeaderBlock;
    expect(header.text.text).toBe('Tasks (1)');
  });

  it('returns one section block per task', () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2, title: 'Task 2' })];
    const blocks = formatTaskList(tasks);
    // header + 2 sections
    expect(blocks).toHaveLength(3);
    expect(blocks[1].type).toBe('section');
    expect(blocks[2].type).toBe('section');
  });

  it('includes status emoji in task section text', () => {
    const blocks = formatTaskList([makeTask({ status: 'in_progress' })]);
    const section = blocks[1] as SectionBlock;
    expect(section.text?.text).toContain('🔵');
  });

  it('includes priority indicator in task section text', () => {
    const blocks = formatTaskList([makeTask({ priority: 'urgent' })]);
    const section = blocks[1] as SectionBlock;
    expect(section.text?.text).toContain('🔴 urgent');
  });

  it('includes assignee in task section text', () => {
    const blocks = formatTaskList([makeTask({ assignee: 'charlie' })]);
    const section = blocks[1] as SectionBlock;
    expect(section.text?.text).toContain('@charlie');
  });

  it('shows _unassigned_ when assignee is null', () => {
    const blocks = formatTaskList([makeTask({ assignee: null })]);
    const section = blocks[1] as SectionBlock;
    expect(section.text?.text).toContain('_unassigned_');
  });

  it('includes task id and title in section text', () => {
    const blocks = formatTaskList([makeTask({ id: 42, title: 'Deploy feature' })]);
    const section = blocks[1] as SectionBlock;
    expect(section.text?.text).toContain('#42 Deploy feature');
  });

  it('truncates to 20 tasks and adds context footer when tasks.length > 20', () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      makeTask({ id: i + 1, title: `Task ${i + 1}` })
    );
    const blocks = formatTaskList(tasks);
    // header + 20 sections + 1 context footer
    expect(blocks).toHaveLength(22);
    const footer = blocks[blocks.length - 1] as ContextBlock;
    expect(footer.type).toBe('context');
    expect(footer.elements[0]).toMatchObject({
      type: 'mrkdwn',
      text: 'Showing 20 of 25 tasks',
    });
  });

  it('does not add context footer when tasks.length === 20', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: i + 1, title: `Task ${i + 1}` })
    );
    const blocks = formatTaskList(tasks);
    // header + 20 sections, no footer
    expect(blocks).toHaveLength(21);
    expect(blocks[blocks.length - 1].type).toBe('section');
  });

  it('uses correct emoji for all status values', () => {
    const statusEmojis: Record<string, string> = {
      open: '⚪',
      in_progress: '🔵',
      done: '✅',
      closed: '⛔',
      blocked: '🔴',
      backlogged: '🟡',
    };
    for (const [status, emoji] of Object.entries(statusEmojis)) {
      const blocks = formatTaskList([makeTask({ status: status as Task['status'] })]);
      const section = blocks[1] as SectionBlock;
      expect(section.text?.text).toContain(emoji);
    }
  });
});

// ---------------------------------------------------------------------------
// formatTaskDetail
// ---------------------------------------------------------------------------

describe('formatTaskDetail', () => {
  it('returns a HeaderBlock as the first block', () => {
    const blocks = formatTaskDetail(makeTask());
    expect(blocks[0].type).toBe('header');
    const header = blocks[0] as HeaderBlock;
    expect(header.text.type).toBe('plain_text');
    expect(header.text.text).toBe('Fix login bug');
  });

  it('sets emoji: true on the HeaderBlock plain_text', () => {
    const blocks = formatTaskDetail(makeTask());
    const header = blocks[0] as HeaderBlock;
    expect(header.text.emoji).toBe(true);
  });

  it('truncates title longer than 150 chars with ellipsis', () => {
    const longTitle = 'A'.repeat(200);
    const blocks = formatTaskDetail(makeTask({ title: longTitle }));
    const header = blocks[0] as HeaderBlock;
    expect(header.text.text).toHaveLength(150);
    expect(header.text.text).toMatch(/\.\.\.$/);
    expect(header.text.text).toBe('A'.repeat(147) + '...');
  });

  it('does not truncate titles of exactly 150 chars', () => {
    const title150 = 'B'.repeat(150);
    const blocks = formatTaskDetail(makeTask({ title: title150 }));
    const header = blocks[0] as HeaderBlock;
    expect(header.text.text).toHaveLength(150);
    expect(header.text.text).not.toMatch(/\.\.\.$/);
  });

  it('returns a SectionBlock with fields as the second block', () => {
    const blocks = formatTaskDetail(makeTask());
    expect(blocks[1].type).toBe('section');
    const section = blocks[1] as SectionBlock;
    expect(section.fields).toBeDefined();
    expect(Array.isArray(section.fields)).toBe(true);
  });

  it('includes Status field with emoji in fields section', () => {
    const blocks = formatTaskDetail(makeTask({ status: 'done' }));
    const section = blocks[1] as SectionBlock;
    const statusField = section.fields?.find((f) => f.text.includes('*Status*'));
    expect(statusField).toBeDefined();
    expect(statusField?.text).toContain('✅');
  });

  it('includes Priority field in fields section', () => {
    const blocks = formatTaskDetail(makeTask({ priority: 'high' }));
    const section = blocks[1] as SectionBlock;
    const priorityField = section.fields?.find((f) => f.text.includes('*Priority*'));
    expect(priorityField).toBeDefined();
    expect(priorityField?.text).toContain('🟠 high');
  });

  it('includes Assignee field with value when set', () => {
    const blocks = formatTaskDetail(makeTask({ assignee: 'diana' }));
    const section = blocks[1] as SectionBlock;
    const assigneeField = section.fields?.find((f) => f.text.includes('*Assignee*'));
    expect(assigneeField?.text).toContain('diana');
  });

  it('includes _unassigned_ in Assignee field when null', () => {
    const blocks = formatTaskDetail(makeTask({ assignee: null }));
    const section = blocks[1] as SectionBlock;
    const assigneeField = section.fields?.find((f) => f.text.includes('*Assignee*'));
    expect(assigneeField?.text).toContain('_unassigned_');
  });

  it('includes Due Date field with value when set', () => {
    const blocks = formatTaskDetail(makeTask({ due_date: '2026-04-01' }));
    const section = blocks[1] as SectionBlock;
    const dueDateField = section.fields?.find((f) => f.text.includes('*Due Date*'));
    expect(dueDateField?.text).toContain('2026-04-01');
  });

  it('shows _none_ in Due Date field when null', () => {
    const blocks = formatTaskDetail(makeTask({ due_date: null }));
    const section = blocks[1] as SectionBlock;
    const dueDateField = section.fields?.find((f) => f.text.includes('*Due Date*'));
    expect(dueDateField?.text).toContain('_none_');
  });

  it('includes Project field with project_id', () => {
    const blocks = formatTaskDetail(makeTask({ project_id: 42 }));
    const section = blocks[1] as SectionBlock;
    const projectField = section.fields?.find((f) => f.text.includes('*Project*'));
    expect(projectField?.text).toContain('#42');
  });

  it('includes Created By field', () => {
    const blocks = formatTaskDetail(makeTask({ created_by: 'evan' }));
    const section = blocks[1] as SectionBlock;
    const createdByField = section.fields?.find((f) => f.text.includes('*Created by*'));
    expect(createdByField?.text).toContain('evan');
  });

  it('includes Tags field when tags are present', () => {
    const blocks = formatTaskDetail(makeTask({ tags: ['bug', 'ui'] }));
    const section = blocks[1] as SectionBlock;
    const tagsField = section.fields?.find((f) => f.text.includes('*Tags*'));
    expect(tagsField).toBeDefined();
    expect(tagsField?.text).toContain('bug, ui');
  });

  it('omits Tags field when tags array is empty', () => {
    const blocks = formatTaskDetail(makeTask({ tags: [] }));
    const section = blocks[1] as SectionBlock;
    const tagsField = section.fields?.find((f) => f.text.includes('*Tags*'));
    expect(tagsField).toBeUndefined();
  });

  it('includes DividerBlock and description SectionBlock when description is set', () => {
    const blocks = formatTaskDetail(makeTask({ description: 'This is a detailed description.' }));
    expect(blocks).toHaveLength(4); // header + fields + divider + description
    expect(blocks[2].type).toBe('divider');
    const descSection = blocks[3] as SectionBlock;
    expect(descSection.type).toBe('section');
    expect(descSection.text?.text).toContain('This is a detailed description.');
  });

  it('omits divider and description when description is null', () => {
    const blocks = formatTaskDetail(makeTask({ description: null }));
    expect(blocks).toHaveLength(2); // header + fields only
  });

  it('truncates description longer than 3000 chars', () => {
    const longDesc = 'X'.repeat(4000);
    const blocks = formatTaskDetail(makeTask({ description: longDesc }));
    const descSection = blocks[3] as SectionBlock;
    expect(descSection.text?.text).toHaveLength(3000);
  });
});

// ---------------------------------------------------------------------------
// formatTaskNotification
// ---------------------------------------------------------------------------

describe('formatTaskNotification', () => {
  it('returns a single SectionBlock', () => {
    const blocks = formatTaskNotification(makeTaskEvent());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('section');
  });

  it('includes event label for task.created', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.created' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('Task created');
  });

  it('includes event label for task.updated', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.updated' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('Task updated');
  });

  it('includes event label for task.status_changed', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.status_changed' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('Status changed');
  });

  it('includes event label for task.claimed', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.claimed' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('Task claimed');
  });

  it('includes event label for task.deleted', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.deleted' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('Task deleted');
  });

  it('falls back to raw eventType string for unknown event types', () => {
    const blocks = formatTaskNotification(makeTaskEvent({ eventType: 'task.unknown_event' }));
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('task.unknown_event');
  });

  it('includes actor name in text', () => {
    const event = makeTaskEvent({ metadata: { source: 'user', actor: 'frank' } });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('frank');
  });

  it('uses "system" as actor when metadata.actor is undefined', () => {
    const event = makeTaskEvent({ metadata: { source: 'workflow' } });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('system');
  });

  it('includes task id and title in notification text', () => {
    const event = makeTaskEvent({
      data: makeTask({ id: 99, title: 'Critical hotfix' }),
    });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('#99 Critical hotfix');
  });

  it('includes /tasks show <id> command reference in text', () => {
    const event = makeTaskEvent({ data: makeTask({ id: 7 }) });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('/tasks show 7');
  });

  it('includes priority indicator in notification text', () => {
    const event = makeTaskEvent({ data: makeTask({ priority: 'low' }) });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('⚪ low');
  });

  it('includes assignee in notification text', () => {
    const event = makeTaskEvent({ data: makeTask({ assignee: 'grace' }) });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('@grace');
  });

  it('shows _unassigned_ in notification text when assignee is null', () => {
    const event = makeTaskEvent({ data: makeTask({ assignee: null }) });
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('_unassigned_');
  });

  it('includes project name when projectName is provided', () => {
    const event = makeTaskEvent();
    const blocks = formatTaskNotification(event, 'Wood Fired Games');
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).toContain('_Wood Fired Games_');
  });

  it('omits project name line when projectName is not provided', () => {
    const event = makeTaskEvent();
    const blocks = formatTaskNotification(event);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).not.toContain('_Project');
    // Also verify no italic project name line
    expect(section.text?.text).not.toMatch(/_[A-Z]/);
  });

  it('omits project name line when projectName is undefined', () => {
    const event = makeTaskEvent();
    const blocks = formatTaskNotification(event, undefined);
    const section = blocks[0] as SectionBlock;
    expect(section.text?.text).not.toContain('_Project');
  });
});
