import type {
  KnownBlock,
  SectionBlock,
  HeaderBlock,
  DividerBlock,
  ContextBlock,
  MrkdwnElement,
} from '@slack/types';
import type { Task } from '../types/task.js';
import type { TaskEvent } from '../events/types.js';

// ---------------------------------------------------------------------------
// Lookup maps — exported so project-formatter.ts can reuse them (Plan 02)
// ---------------------------------------------------------------------------

export const STATUS_EMOJI: Record<string, string> = {
  open: '⚪',
  in_progress: '🔵',
  done: '✅',
  closed: '⛔',
  blocked: '🔴',
  backlogged: '🟡',
};

export const PRIORITY_INDICATOR: Record<string, string> = {
  urgent: '🔴 urgent',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '⚪ low',
};

// ---------------------------------------------------------------------------
// Event label map
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<string, string> = {
  'task.created': 'Task created',
  'task.updated': 'Task updated',
  'task.status_changed': 'Status changed',
  'task.claimed': 'Task claimed',
  'task.deleted': 'Task deleted',
};

// ---------------------------------------------------------------------------
// formatTaskList
// ---------------------------------------------------------------------------

/**
 * Format a list of tasks as Block Kit blocks.
 *
 * Returns a single "_No tasks found._" section for empty arrays.
 * Truncates to 20 tasks and adds a context footer if the list is longer.
 */
export function formatTaskList(tasks: Array<Task & { tags: string[] }>): KnownBlock[] {
  if (tasks.length === 0) {
    const emptySection: SectionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: '_No tasks found._' },
    };
    return [emptySection];
  }

  const totalCount = tasks.length;
  const displayTasks = tasks.slice(0, 20);

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Tasks (${totalCount})`, emoji: true },
    } as HeaderBlock,
  ];

  for (const task of displayTasks) {
    const emoji = STATUS_EMOJI[task.status] ?? '❓';
    const priority = PRIORITY_INDICATOR[task.priority] ?? task.priority;
    const assignee = task.assignee ? `@${task.assignee}` : '_unassigned_';

    const section: SectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *#${task.id} ${task.title}*\n${priority} · ${assignee}`,
      },
    };
    blocks.push(section);
  }

  if (totalCount > 20) {
    const footer: ContextBlock = {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing 20 of ${totalCount} tasks` }],
    };
    blocks.push(footer);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// formatTaskDetail
// ---------------------------------------------------------------------------

/**
 * Format a single task as a detailed Block Kit card.
 *
 * Structure: HeaderBlock (title, ≤150 chars) + SectionBlock with fields
 * (status, priority, assignee, due_date, project, created_by, optional tags)
 * + optional DividerBlock + description SectionBlock.
 */
export function formatTaskDetail(task: Task & { tags: string[] }): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  // Header — max 150 chars (Slack Block Kit constraint)
  const rawTitle = task.title;
  // HeaderBlock max 150 chars (Slack API constraint); truncate with ellipsis if exceeded
  const title = rawTitle.length > 150 ? rawTitle.slice(0, 147) + '...' : rawTitle;

  const header: HeaderBlock = {
    type: 'header',
    text: { type: 'plain_text', text: title, emoji: true },
  };
  blocks.push(header);

  // Fields section — 2-column key/value pairs (max 10 items in Slack API)
  const fields: MrkdwnElement[] = [
    { type: 'mrkdwn', text: `*Status*\n${STATUS_EMOJI[task.status] ?? '❓'} ${task.status}` },
    { type: 'mrkdwn', text: `*Priority*\n${PRIORITY_INDICATOR[task.priority] ?? task.priority}` },
    { type: 'mrkdwn', text: `*Assignee*\n${task.assignee ?? '_unassigned_'}` },
    { type: 'mrkdwn', text: `*Due Date*\n${task.due_date ?? '_none_'}` },
    { type: 'mrkdwn', text: `*Project*\n#${task.project_id}` },
    { type: 'mrkdwn', text: `*Created by*\n${task.created_by}` },
  ];

  if (task.tags.length > 0) {
    fields.push({ type: 'mrkdwn', text: `*Tags*\n${task.tags.join(', ')}` });
  }

  const fieldsSection: SectionBlock = { type: 'section', fields };
  blocks.push(fieldsSection);

  // Optional description
  if (task.description !== null) {
    const divider: DividerBlock = { type: 'divider' };
    blocks.push(divider);

    const descSection: SectionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: task.description.slice(0, 3000) },
    };
    blocks.push(descSection);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// formatTaskNotification
// ---------------------------------------------------------------------------

/**
 * Format a task event as a compact notification SectionBlock.
 *
 * Includes: event label, actor, task id/title with status emoji, priority,
 * assignee, and a /tasks show <id> command reference.
 */
export function formatTaskNotification(event: TaskEvent, projectName?: string): KnownBlock[] {
  const { data: task, eventType, metadata } = event;
  const emoji = STATUS_EMOJI[task.status] ?? '❓';
  const actor = metadata.actor ?? 'system';
  const label = EVENT_LABELS[eventType] ?? eventType;
  const assignee = task.assignee ? `@${task.assignee}` : '_unassigned_';
  const priority = PRIORITY_INDICATOR[task.priority] ?? task.priority;

  const text = [
    `*${label}* by ${actor}`,
    `${emoji} *#${task.id} ${task.title}*`,
    ...(projectName ? [`_${projectName}_`] : []),
    `${priority} · ${assignee}`,
    `\`/tasks show ${task.id}\``,
  ].join('\n');

  const section: SectionBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };

  return [section];
}
