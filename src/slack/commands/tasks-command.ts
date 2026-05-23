import type { App, RespondFn, SlashCommand } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { TaskService } from '../../services/task.service.js';
import type { ProjectService } from '../../services/project.service.js';
import type { DependencyService } from '../../services/dependency.service.js';
import type { CommentService } from '../../services/comment.service.js';
import type { IUserRepository } from '../../repositories/interfaces.js';
import type { UserIdentityCache } from '../user-identity.js';
import type { SlackChannelSubscriptionRepository } from '../repositories/channel-subscription.repository.js';
import { NotFoundError, ValidationError, BusinessError } from '../../services/errors.js';
import { formatTaskList, formatTaskDetail } from '../task-formatter.js';
import { formatProjectList, formatProjectDetail } from '../formatters/project-formatter.js';
import { ALLOWED_EVENT_TYPES, isAllowedEventType } from '../../events/types.js';

/**
 * Hard cap on subscription rows (project_id x event_type) per Slack channel.
 * Prevents a malicious or careless user from filling the table with junk to
 * slow subscribe/unsubscribe lookups.
 */
export const MAX_SUBSCRIPTIONS_PER_CHANNEL = 100;

/**
 * Minimal pino-style logger interface for the Slack write handlers.
 *
 * Mirrors the object-first shape used by identity-seeder.ts so pino,
 * FastifyBaseLogger, and `vi.fn()` mocks all satisfy it. The Slack write
 * handlers only need `warn` today (for the `slack_user_unmapped` event);
 * `info`/`error` are included for future structured logging consistency.
 */
export interface SlackHandlerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Default no-op logger used when registerTasksCommand is called without a
 * logger (e.g. existing unit tests that don't care about warn logs).
 */
const noopLogger: SlackHandlerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface Services {
  taskService: TaskService;
  projectService: ProjectService;
  dependencyService: DependencyService;
  commentService: CommentService;
  /**
   * Phase 31 (Plan 31-04): required for slack_user_id → user.id resolution
   * on every Slack write. At registration time, registerTasksCommand resolves
   * `findServiceAccountByName('slack-bot')` once and caches the id as the
   * fallback for unmapped Slack users.
   */
  userRepository: IUserRepository;
}

/**
 * resolveActorUserId — Plan 31-04 shim used by every Slack write handler.
 *
 * Looks up the incoming Slack user via `findBySlackUserId(command.user_id)`.
 * On hit, returns the real `users.id`. On miss, returns the cached
 * `slackBotUserId` AND emits a structured warn log with
 * `event: 'slack_user_unmapped'` so operators can audit + provision the
 * missing Slack user (admin UI deferred to post-v1.6).
 *
 * The `action` parameter is the originating handler name (e.g. `'create'`,
 * `'comment-add'`) — included in the warn-log payload so operators can grep
 * by the action that triggered the unmapped lookup.
 */
function resolveActorUserId(
  services: Services,
  command: SlashCommand,
  slackBotUserId: number,
  logger: SlackHandlerLogger,
  action: string
): number {
  const slackUser = services.userRepository.findBySlackUserId(command.user_id);
  if (slackUser) {
    return slackUser.id;
  }
  logger.warn(
    {
      event: 'slack_user_unmapped',
      slack_user_id: command.user_id,
      action,
    },
    'slack_user_unmapped'
  );
  return slackBotUserId;
}

/**
 * parseArgs — splits an args array into positionals and --flag value pairs.
 *
 * Iterates the args array: tokens starting with '--' consume the next token as
 * their value and are recorded in `flags`. All other tokens go into `positionals`.
 */
export function parseArgs(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1] ?? '';
      flags[key] = value;
      i++; // skip next arg — it's the flag value
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/**
 * respondBlocks — sends an ephemeral Block Kit response to the invoking user.
 *
 * All slash command responses use respond() (not say()) so only the invoking
 * user sees the result. respond() uses the response_url webhook which is valid
 * for 30 minutes after ack().
 */
export async function respondBlocks(
  respond: RespondFn,
  blocks: KnownBlock[],
  fallbackText: string
): Promise<void> {
  await respond({
    response_type: 'ephemeral',
    blocks,
    text: fallbackText, // accessibility fallback for screen readers / push notifications
  });
}

/**
 * respondError — sends an ephemeral error message with optional corrective hint.
 *
 * Always uses Block Kit SectionBlock with mrkdwn so the :x: emoji and code
 * spans render properly in Slack clients.
 */
export async function respondError(
  respond: RespondFn,
  message: string,
  hint?: string
): Promise<void> {
  const text = hint ? `${message}\n${hint}` : message;
  await respond({
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:x: ${text}` },
      } as KnownBlock,
    ],
    text: message, // accessibility fallback
  });
}

/**
 * formatServiceError — converts a caught service error into a user-friendly string.
 *
 * Checks known error types from src/services/errors.ts in priority order:
 * NotFoundError > ValidationError (with structured field errors) > BusinessError > Error > fallback.
 */
export function formatServiceError(error: unknown): string {
  if (error instanceof NotFoundError) {
    return `Not found: ${error.message}`;
  }
  if (error instanceof ValidationError) {
    const fields = Object.entries(error.fieldErrors)
      .map(([f, msgs]) => `${f}: ${msgs.join(', ')}`)
      .join('; ');
    return `Validation failed — ${fields}`;
  }
  if (error instanceof BusinessError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

/**
 * HELP_BLOCKS — Block Kit blocks for /tasks help.
 *
 * Grouped into three sections: Task commands, Project commands,
 * and Dependency/Comment/Subtask commands. Each section lists usage examples
 * with backtick-wrapped command strings per SCMD-03.
 */
const HELP_BLOCKS: KnownBlock[] = [
  {
    type: 'header',
    text: { type: 'plain_text', text: 'Tasks \u2014 Available Commands', emoji: true },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Task commands*',
        '`/tasks list [--status open] [--project 3] [--assignee name]`',
        '`/tasks show <id>`',
        '`/tasks create <title> --project <id> [--priority high]`',
        '`/tasks update <id> --status done [--assignee name]`',
        '`/tasks claim <id>`',
        '`/tasks delete <id>`',
      ].join('\n'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Project commands*',
        '`/tasks project-list`',
        '`/tasks project-show <id>`',
        '`/tasks project-create <name>`',
        '`/tasks project-update <id> --name <name>`',
        '`/tasks project-delete <id>`',
      ].join('\n'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Dependency, Comment & Subtask commands*',
        '`/tasks dep-add <id> <blocks-id>`',
        '`/tasks dep-list <id>`',
        '`/tasks dep-remove <id> <blocks-id>`',
        '`/tasks comment-add <id> <content>`',
        '`/tasks comment-list <id>`',
        '`/tasks comment-delete <task-id> <comment-id>`',
        '`/tasks subtask-create <parent-id> <title>`',
        '`/tasks subtask-list <parent-id>`',
      ].join('\n'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Notification commands*',
        '`/tasks subscribe --project <id> [--events task.created,task.status_changed]`',
        '`/tasks unsubscribe [--project <id>]`',
      ].join('\n'),
    },
  },
];

// ---------------------------------------------------------------------------
// Task subcommand handlers
// ---------------------------------------------------------------------------

/**
 * handleList — /tasks list [--status <s>] [--project <id>] [--assignee <a>] [--search <q>] [--tags <t>]
 */
async function handleList(
  respond: RespondFn,
  services: Services,
  args: string[]
): Promise<void> {
  const { flags } = parseArgs(args);

  const filters: Record<string, unknown> = {};
  if (flags['status']) filters['status'] = flags['status'];
  if (flags['project']) filters['project_id'] = parseInt(flags['project'], 10);
  if (flags['assignee']) filters['assignee'] = flags['assignee'];
  if (flags['search']) filters['search'] = flags['search'];
  if (flags['tags']) filters['tags'] = flags['tags'].split(',');

  const tasks = services.taskService.listTasks(filters);
  const blocks = formatTaskList(tasks);
  await respondBlocks(respond, blocks, `Tasks (${tasks.length})`);
}

/**
 * handleShow — /tasks show <id>
 */
async function handleShow(
  respond: RespondFn,
  services: Services,
  args: string[]
): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks show <id>`');
    return;
  }

  const task = services.taskService.getTask(id);
  const allBlocks: KnownBlock[] = [...formatTaskDetail(task)];

  // Append last 5 comments
  const comments = await services.commentService.getComments(id);
  if (comments.length > 0) {
    allBlocks.push({ type: 'divider' } as KnownBlock);
    allBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Comments*' },
    } as KnownBlock);

    const displayComments = comments.slice(-5);
    for (const comment of displayComments) {
      allBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${comment.author}*: ${comment.content}` },
      } as KnownBlock);
    }

    if (comments.length > 5) {
      allBlocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${comments.length - 5} more comments` }],
      } as KnownBlock);
    }
  }

  // Append dependencies
  const blockedBy = services.dependencyService.getBlockedBy(id);
  const blockers = services.dependencyService.getBlockers(id);

  if (blockedBy.length > 0 || blockers.length > 0) {
    allBlocks.push({ type: 'divider' } as KnownBlock);

    const parts: string[] = [];
    if (blockedBy.length > 0) {
      parts.push(`Blocks: ${blockedBy.map((d) => `#${d.blocks_task_id}`).join(', ')}`);
    }
    if (blockers.length > 0) {
      parts.push(`Blocked by: ${blockers.map((d) => `#${d.task_id}`).join(', ')}`);
    }

    allBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: parts.join('\n') },
    } as KnownBlock);
  }

  await respondBlocks(respond, allBlocks, `Task #${id}`);
}

/**
 * handleCreate — /tasks create <title> --project <id> [--priority <p>] [--description <d>]
 *
 * Phase 31 (Plan 31-04): resolves `command.user_id` to a `users.id` via
 * `findBySlackUserId`. On miss, falls back to the cached `slackBotUserId`
 * AND emits a structured warn log so operators can provision the missing
 * Slack user. The resolved id is passed to the service as `created_by_user_id`.
 */
async function handleCreate(
  respond: RespondFn,
  services: Services,
  identityCache: UserIdentityCache,
  command: SlashCommand,
  args: string[],
  slackBotUserId: number,
  logger: SlackHandlerLogger
): Promise<void> {
  const { positionals, flags } = parseArgs(args);

  if (positionals.length === 0) {
    await respondError(respond, 'Title required.', 'Usage: `/tasks create <title> --project <id>`');
    return;
  }

  if (!flags['project']) {
    await respondError(respond, 'Project ID required.', 'Usage: `/tasks create <title> --project <id>`');
    return;
  }

  const title = positionals.join(' ');
  const createdBy = await identityCache.resolve(command.user_id);
  const actorUserId = resolveActorUserId(services, command, slackBotUserId, logger, 'create');

  const task = services.taskService.createTask({
    title,
    project_id: parseInt(flags['project'], 10),
    priority: flags['priority'] || 'medium',
    created_by: createdBy,
    created_by_user_id: actorUserId,
    description: flags['description'] || null,
  });

  const blocks = formatTaskDetail(task);
  await respondBlocks(respond, blocks, `Task created: ${task.title}`);
}

/**
 * handleUpdate — /tasks update <id> [--status <s>] [--title <t>] [--priority <p>] [--assignee <a>] [--due <d>] [--description <d>]
 *
 * Phase 31 (Plan 31-04 Task 3): when `--assignee` is supplied, also resolve
 * `assignee_user_id` mirroring the REST PATCH pattern from Plan 31-02 — but
 * email-only (Slack has no display-name resolver here; non-email values stay
 * NULL for the `migrate-identities` CLI tool to backfill).
 *
 * Resolution rules:
 *   - assignee = '' or null  → assignee_user_id = null (clearing)
 *   - assignee contains '@'  → findByEmail; matched → user.id, else null
 *   - assignee free-form     → assignee_user_id = null
 *   - --assignee not supplied → assignee_user_id omitted (no FK write)
 *
 * No actor resolution here — the `tasks` table has no `updated_by_user_id`
 * column in migration 009 per the plan threat-model / RESEARCH §1.
 */
async function handleUpdate(
  respond: RespondFn,
  services: Services,
  args: string[]
): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks update <id> --status <status>`');
    return;
  }

  const { flags } = parseArgs(args.slice(1));

  const updates: Record<string, unknown> = {};
  if (flags['status'] !== undefined) updates['status'] = flags['status'];
  if (flags['title'] !== undefined) updates['title'] = flags['title'];
  if (flags['priority'] !== undefined) updates['priority'] = flags['priority'];
  if (flags['assignee'] !== undefined) updates['assignee'] = flags['assignee'];
  if (flags['due'] !== undefined) updates['due_date'] = flags['due'];
  if (flags['description'] !== undefined) updates['description'] = flags['description'];

  if (Object.keys(updates).length === 0) {
    await respondError(respond, 'No update fields provided.');
    return;
  }

  // Phase 31 (Plan 31-04 Task 3): derive assignee_user_id when the caller
  // sets --assignee. Email matches resolve to a user.id; clearing or
  // free-form values yield null (NOT undefined — the repo treats null as
  // "explicitly clear the FK").
  if (Object.prototype.hasOwnProperty.call(updates, 'assignee')) {
    const a = updates['assignee'];
    let assigneeUserId: number | null = null;
    if (typeof a === 'string' && a.length > 0 && a.includes('@')) {
      try {
        const u = services.userRepository.findByEmail(a);
        assigneeUserId = u?.id ?? null;
      } catch {
        // findByEmail throws on invalid input; treat as unresolved → null.
        assigneeUserId = null;
      }
    }
    updates['assignee_user_id'] = assigneeUserId;
  }

  const task = services.taskService.updateTask(id, updates);
  const blocks = formatTaskDetail(task);
  await respondBlocks(respond, blocks, `Task #${id} updated`);
}

/**
 * handleDelete — /tasks delete <id>
 */
async function handleDelete(
  respond: RespondFn,
  services: Services,
  args: string[]
): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks delete <id>`');
    return;
  }

  services.taskService.deleteTask(id);

  await respondBlocks(
    respond,
    [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: Task #${id} deleted.` } } as KnownBlock],
    `Task #${id} deleted.`
  );
}

/**
 * handleClaim — /tasks claim <id>
 *
 * Phase 31 (Plan 31-04): the resolved user.id is passed as the 4th positional
 * (`assigneeUserId`) on claimTask. The `source` arg is fixed to 'workflow'
 * since Slack-originated claims are bot-mediated (not a direct human REST call).
 */
async function handleClaim(
  respond: RespondFn,
  services: Services,
  identityCache: UserIdentityCache,
  command: SlashCommand,
  args: string[],
  slackBotUserId: number,
  logger: SlackHandlerLogger
): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks claim <id>`');
    return;
  }

  const displayName = await identityCache.resolve(command.user_id);
  const actorUserId = resolveActorUserId(services, command, slackBotUserId, logger, 'claim');
  const task = services.taskService.claimTask(id, displayName, 'workflow', actorUserId);
  const blocks = formatTaskDetail(task);
  await respondBlocks(respond, blocks, `Task #${id} claimed by ${displayName}`);
}

// ---------------------------------------------------------------------------
// Project subcommand handlers
// ---------------------------------------------------------------------------

/**
 * handleProjectList — /tasks project-list
 */
async function handleProjectList(respond: RespondFn, services: Services): Promise<void> {
  const projects = services.projectService.listProjects();
  const blocks = formatProjectList(projects);
  await respondBlocks(respond, blocks, `Projects (${projects.length})`);
}

/**
 * handleProjectShow — /tasks project-show <id>
 */
async function handleProjectShow(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Project ID required.', 'Usage: `/tasks project-show <id>`');
    return;
  }
  const project = services.projectService.getProject(id);
  const blocks = formatProjectDetail(project);
  await respondBlocks(respond, blocks, `Project #${id}`);
}

/**
 * handleProjectCreate — /tasks project-create <name> [--description <desc>]
 */
async function handleProjectCreate(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const name = positionals.join(' ');
  if (!name) {
    await respondError(respond, 'Project name required.', 'Usage: `/tasks project-create <name>`');
    return;
  }
  const project = services.projectService.createProject({
    name,
    description: flags['description'] || null,
  });
  const blocks = formatProjectDetail(project);
  await respondBlocks(respond, blocks, `Project created: ${project.name}`);
}

/**
 * handleProjectUpdate — /tasks project-update <id> [--name <name>] [--description <desc>]
 */
async function handleProjectUpdate(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Project ID required.', 'Usage: `/tasks project-update <id> --name <name>`');
    return;
  }
  const { flags } = parseArgs(args.slice(1));
  const updates: Record<string, unknown> = {};
  if (flags['name'] !== undefined) updates['name'] = flags['name'];
  if (flags['description'] !== undefined) updates['description'] = flags['description'];
  if (Object.keys(updates).length === 0) {
    await respondError(respond, 'No update fields provided.');
    return;
  }
  const project = services.projectService.updateProject(id, updates);
  const blocks = formatProjectDetail(project);
  await respondBlocks(respond, blocks, `Project #${id} updated`);
}

/**
 * handleProjectDelete — /tasks project-delete <id>
 */
async function handleProjectDelete(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Project ID required.', 'Usage: `/tasks project-delete <id>`');
    return;
  }
  services.projectService.deleteProject(id);
  await respondBlocks(
    respond,
    [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: Project #${id} deleted.` } } as KnownBlock],
    `Project #${id} deleted.`
  );
}

// ---------------------------------------------------------------------------
// Dependency subcommand handlers
// ---------------------------------------------------------------------------

/**
 * handleDepAdd — /tasks dep-add <task_id> <blocks_task_id>
 */
async function handleDepAdd(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const taskId = parseInt(args[0] ?? '', 10);
  const blocksTaskId = parseInt(args[1] ?? '', 10);
  if (isNaN(taskId) || isNaN(blocksTaskId)) {
    await respondError(
      respond,
      'Two task IDs required.',
      'Usage: `/tasks dep-add <task-id> <blocks-task-id>`'
    );
    return;
  }
  services.dependencyService.addDependency({ task_id: taskId, blocks_task_id: blocksTaskId });
  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: Dependency added: Task #${taskId} blocks Task #${blocksTaskId}` },
    } as KnownBlock],
    `Dependency added: Task #${taskId} blocks Task #${blocksTaskId}`
  );
}

/**
 * handleDepList — /tasks dep-list <task_id>
 */
async function handleDepList(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks dep-list <id>`');
    return;
  }
  const blockedBy = services.dependencyService.getBlockedBy(id);
  const blockers = services.dependencyService.getBlockers(id);

  const blocksText = blockedBy.length > 0
    ? blockedBy.map((d) => `#${d.blocks_task_id}`).join(', ')
    : '_none_';
  const blockersText = blockers.length > 0
    ? blockers.map((d) => `#${d.task_id}`).join(', ')
    : '_none_';

  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Dependencies for Task #${id}*\n*Blocks:* ${blocksText}\n*Blocked by:* ${blockersText}`,
      },
    } as KnownBlock],
    `Dependencies for Task #${id}`
  );
}

/**
 * handleDepRemove — /tasks dep-remove <task_id> <blocks_task_id>
 */
async function handleDepRemove(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const taskId = parseInt(args[0] ?? '', 10);
  const blocksTaskId = parseInt(args[1] ?? '', 10);
  if (isNaN(taskId) || isNaN(blocksTaskId)) {
    await respondError(
      respond,
      'Two task IDs required.',
      'Usage: `/tasks dep-remove <task-id> <blocks-task-id>`'
    );
    return;
  }
  services.dependencyService.removeDependency(taskId, blocksTaskId);
  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: Dependency removed: Task #${taskId} no longer blocks Task #${blocksTaskId}` },
    } as KnownBlock],
    `Dependency removed: Task #${taskId} no longer blocks Task #${blocksTaskId}`
  );
}

// ---------------------------------------------------------------------------
// Comment subcommand handlers
// ---------------------------------------------------------------------------

/**
 * handleCommentAdd — /tasks comment-add <task_id> <content...>
 *
 * Phase 31 (Plan 31-04): resolves the Slack actor → `author_user_id`.
 */
async function handleCommentAdd(
  respond: RespondFn,
  services: Services,
  identityCache: UserIdentityCache,
  command: SlashCommand,
  args: string[],
  slackBotUserId: number,
  logger: SlackHandlerLogger
): Promise<void> {
  const taskId = parseInt(args[0] ?? '', 10);
  if (isNaN(taskId)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks comment-add <task-id> <content>`');
    return;
  }
  const content = args.slice(1).join(' ');
  if (!content) {
    await respondError(respond, 'Comment content required.', 'Usage: `/tasks comment-add <task-id> <content>`');
    return;
  }
  const author = await identityCache.resolve(command.user_id);
  const actorUserId = resolveActorUserId(services, command, slackBotUserId, logger, 'comment-add');
  services.commentService.addComment({ task_id: taskId, author, content, author_user_id: actorUserId });
  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: Comment added to Task #${taskId}` },
    } as KnownBlock],
    `Comment added to Task #${taskId}`
  );
}

/**
 * handleCommentList — /tasks comment-list <task_id>
 */
async function handleCommentList(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Task ID required.', 'Usage: `/tasks comment-list <id>`');
    return;
  }
  const comments = await services.commentService.getComments(id);
  if (comments.length === 0) {
    await respondBlocks(
      respond,
      [{ type: 'section', text: { type: 'mrkdwn', text: '_No comments._' } } as KnownBlock],
      `No comments for Task #${id}`
    );
    return;
  }
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `Comments for Task #${id}`, emoji: true } } as KnownBlock,
  ];
  for (const comment of comments) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${comment.author}* (${comment.created_at})\n${comment.content}` },
    } as KnownBlock);
  }
  await respondBlocks(respond, blocks, `Comments for Task #${id}`);
}

/**
 * handleCommentDelete — /tasks comment-delete <task_id> <comment_id>
 */
async function handleCommentDelete(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const taskId = parseInt(args[0] ?? '', 10);
  const commentId = parseInt(args[1] ?? '', 10);
  if (isNaN(taskId) || isNaN(commentId)) {
    await respondError(
      respond,
      'Task ID and Comment ID required.',
      'Usage: `/tasks comment-delete <task-id> <comment-id>`'
    );
    return;
  }
  services.commentService.deleteComment(commentId);
  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: Comment #${commentId} deleted.` },
    } as KnownBlock],
    `Comment #${commentId} deleted.`
  );
}

// ---------------------------------------------------------------------------
// Subtask subcommand handlers
// ---------------------------------------------------------------------------

/**
 * handleSubtaskCreate — /tasks subtask-create <parent_id> <title...> --project <id>
 *
 * Phase 31 (Plan 31-04): same actor-resolution shim as handleCreate. The
 * subtask is just a task with `parent_task_id`, so the FK column populated
 * is also `created_by_user_id`.
 */
async function handleSubtaskCreate(
  respond: RespondFn,
  services: Services,
  identityCache: UserIdentityCache,
  command: SlashCommand,
  args: string[],
  slackBotUserId: number,
  logger: SlackHandlerLogger
): Promise<void> {
  const parentId = parseInt(args[0] ?? '', 10);
  if (isNaN(parentId)) {
    await respondError(respond, 'Parent task ID required.', 'Usage: `/tasks subtask-create <parent-id> <title> --project <id>`');
    return;
  }
  const { positionals, flags } = parseArgs(args.slice(1));
  const title = positionals.join(' ');
  if (!title) {
    await respondError(respond, 'Subtask title required.', 'Usage: `/tasks subtask-create <parent-id> <title> --project <id>`');
    return;
  }
  if (!flags['project']) {
    await respondError(respond, 'Project ID required.', 'Usage: `/tasks subtask-create <parent-id> <title> --project <id>`');
    return;
  }
  const createdBy = await identityCache.resolve(command.user_id);
  const actorUserId = resolveActorUserId(services, command, slackBotUserId, logger, 'subtask-create');
  const task = services.taskService.createTask({
    title,
    project_id: parseInt(flags['project'], 10),
    parent_task_id: parentId,
    priority: flags['priority'] || 'medium',
    created_by: createdBy,
    created_by_user_id: actorUserId,
  });
  const blocks = formatTaskDetail(task);
  await respondBlocks(respond, blocks, `Subtask created: ${task.title}`);
}

/**
 * handleSubtaskList — /tasks subtask-list <parent_id>
 */
async function handleSubtaskList(respond: RespondFn, services: Services, args: string[]): Promise<void> {
  const parentId = parseInt(args[0] ?? '', 10);
  if (isNaN(parentId)) {
    await respondError(respond, 'Parent task ID required.', 'Usage: `/tasks subtask-list <parent-id>`');
    return;
  }
  const subtasks = services.taskService.getSubtasks(parentId);
  const blocks = formatTaskList(subtasks);
  await respondBlocks(respond, blocks, `Subtasks for Task #${parentId}`);
}

// ---------------------------------------------------------------------------
// Health handler
// ---------------------------------------------------------------------------

/**
 * handleHealth — /tasks health
 */
async function handleHealth(respond: RespondFn, services: Services): Promise<void> {
  try {
    const count = services.taskService.countTasks();
    await respondBlocks(
      respond,
      [{
        type: 'section',
        text: { type: 'mrkdwn', text: `:white_check_mark: Service is healthy. ${count} tasks in database.` },
      } as KnownBlock],
      `Service is healthy. ${count} tasks in database.`
    );
  } catch {
    await respondBlocks(
      respond,
      [{ type: 'section', text: { type: 'mrkdwn', text: ':x: Service health check failed.' } } as KnownBlock],
      'Service health check failed.'
    );
  }
}

// ---------------------------------------------------------------------------
// CLI-only stub handler
// ---------------------------------------------------------------------------

/**
 * handleCliOnly — for subcommands only available via the CLI (backup, doctor, stats, db-check, completions)
 */
async function handleCliOnly(respond: RespondFn, subcommand: string): Promise<void> {
  await respondBlocks(
    respond,
    [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:information_source: \`${subcommand}\` is only available via the CLI.\nRun: \`tasks ${subcommand}\``,
      },
    } as KnownBlock],
    `${subcommand} is only available via the CLI.`
  );
}

// ---------------------------------------------------------------------------
// Notification subscription handlers
// ---------------------------------------------------------------------------

/**
 * handleSubscribe — /tasks subscribe --project <id> [--events task.created,task.status_changed]
 */
async function handleSubscribe(
  respond: RespondFn,
  services: Services,
  subscriptionRepo: SlackChannelSubscriptionRepository | undefined,
  command: SlashCommand,
  args: string[]
): Promise<void> {
  if (!subscriptionRepo) {
    await respondError(respond, 'Slack notifications not configured.');
    return;
  }

  const { flags } = parseArgs(args);
  const projectIdStr = flags['project'];
  if (!projectIdStr) {
    await respondError(
      respond,
      'Missing required flag: `--project <id>`',
      'Usage: `/tasks subscribe --project 3 [--events task.created,task.status_changed]`'
    );
    return;
  }

  const projectId = parseInt(projectIdStr, 10);
  if (isNaN(projectId)) {
    await respondError(respond, `Invalid project ID: \`${projectIdStr}\``);
    return;
  }

  // Validate project exists
  try {
    services.projectService.getProject(projectId);
  } catch {
    await respondError(respond, `Project \`${projectId}\` not found.`);
    return;
  }

  // Parse event types — default to task.created + task.status_changed
  const DEFAULT_EVENTS: string[] = ['task.created', 'task.status_changed'];
  const eventsStr = flags['events'];
  const eventTypes = eventsStr
    ? eventsStr.split(',').map(e => e.trim()).filter(e => e.length > 0)
    : DEFAULT_EVENTS;

  if (eventTypes.length === 0) {
    await respondError(
      respond,
      'No event types specified.',
      `Allowed values: ${ALLOWED_EVENT_TYPES.map(e => '`' + e + '`').join(', ')}`
    );
    return;
  }

  // Validate every supplied event type against the runtime allowlist.
  // Reject on first invalid value; do NOT persist anything.
  for (const eventType of eventTypes) {
    if (!isAllowedEventType(eventType)) {
      await respondError(
        respond,
        `Invalid event type: \`${eventType}\``,
        `Allowed values: ${ALLOWED_EVENT_TYPES.map(e => '`' + e + '`').join(', ')}`
      );
      return;
    }
  }

  // Enforce per-channel subscription cap before inserting more rows.
  const currentCount = subscriptionRepo.countByChannel(command.channel_id);
  if (currentCount + eventTypes.length > MAX_SUBSCRIPTIONS_PER_CHANNEL) {
    await respondError(
      respond,
      `Subscription cap reached for this channel (${currentCount}/${MAX_SUBSCRIPTIONS_PER_CHANNEL}).`,
      'Run `/tasks unsubscribe` to remove existing subscriptions before adding more.'
    );
    return;
  }

  subscriptionRepo.subscribe(command.channel_id, projectId, eventTypes);

  // Show confirmation
  const project = services.projectService.getProject(projectId);
  await respondBlocks(respond, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bell: Subscribed this channel to *${project.name}* events: ${eventTypes.map(e => '`' + e + '`').join(', ')}`,
      },
    } as KnownBlock,
  ], `Subscribed to ${project.name} events`);
}

/**
 * handleUnsubscribe — /tasks unsubscribe [--project <id>]
 */
async function handleUnsubscribe(
  respond: RespondFn,
  subscriptionRepo: SlackChannelSubscriptionRepository | undefined,
  command: SlashCommand,
  args: string[]
): Promise<void> {
  if (!subscriptionRepo) {
    await respondError(respond, 'Slack notifications not configured.');
    return;
  }

  const { flags } = parseArgs(args);
  const projectIdStr = flags['project'];
  const projectId = projectIdStr ? parseInt(projectIdStr, 10) : undefined;

  if (projectIdStr && isNaN(projectId!)) {
    await respondError(respond, `Invalid project ID: \`${projectIdStr}\``);
    return;
  }

  const removed = subscriptionRepo.unsubscribe(command.channel_id, projectId);

  if (removed === 0) {
    await respondError(respond, 'No subscriptions found for this channel.');
    return;
  }

  const scope = projectId ? `project \`${projectId}\`` : 'all projects';
  await respondBlocks(respond, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:no_bell: Unsubscribed this channel from ${scope} (${removed} subscription${removed !== 1 ? 's' : ''} removed).`,
      },
    } as KnownBlock,
  ], `Unsubscribed from ${scope}`);
}

/**
 * registerTasksCommand — registers the /tasks slash command on the Bolt App.
 *
 * Must be called ONCE per SlackService lifecycle, after slackService.start().
 * Takes a shared UserIdentityCache (constructed once in server.ts) so that
 * the TTL cache is preserved across multiple command invocations.
 *
 * Routing: command.text is split into [subcommand, ...args]. A switch
 * dispatches to subcommand handlers (Plans 02 and 03).
 * Unknown subcommands return an ephemeral error with a /tasks help hint.
 *
 * ack() is ALWAYS the first statement — Slack enforces a 3-second deadline
 * for acknowledgement. respond() has no time constraint (30-minute window).
 */
export function registerTasksCommand(
  app: App,
  services: Services,
  identityCache: UserIdentityCache,
  subscriptionRepo?: SlackChannelSubscriptionRepository,
  logger: SlackHandlerLogger = noopLogger
): void {
  // Phase 31 (Plan 31-04): Resolve the slack-bot service-account user ONCE at
  // registration. This id is the fallback when an incoming command's user_id
  // does not map to a real users row. Looking it up per-message would add an
  // avoidable DB hit per slash command; the seeder always runs before
  // createApp, so this row exists by the time Slack handlers register.
  const slackBot = services.userRepository.findServiceAccountByName('slack-bot');
  if (!slackBot) {
    throw new Error(
      'slack-bot service account not seeded — createApp must run identity-seeder first'
    );
  }
  const slackBotUserId: number = slackBot.id;

  app.command('/tasks', async ({ ack, respond, command }: { ack: () => Promise<void>; respond: RespondFn; command: SlashCommand }) => {
    // FIRST: ack() — must complete within 3 seconds of Slack delivering the event.
    // Everything after this point has no time constraint (respond_url valid 30 min).
    await ack();

    const text = command.text.trim();
    const [subcommand, ...args] = text ? text.split(/\s+/) : [''];

    try {
      switch (subcommand) {
        // ── Task commands ──────────────────────────────────────────────────────
        case 'list':
          await handleList(respond, services, args);
          break;
        case 'show':
          await handleShow(respond, services, args);
          break;
        case 'create':
          await handleCreate(respond, services, identityCache, command, args, slackBotUserId, logger);
          break;
        case 'update':
          await handleUpdate(respond, services, args);
          break;
        case 'delete':
          await handleDelete(respond, services, args);
          break;
        case 'claim':
          await handleClaim(respond, services, identityCache, command, args, slackBotUserId, logger);
          break;

        // ── Project commands ───────────────────────────────────────────────────
        case 'project-list':
          await handleProjectList(respond, services);
          break;
        case 'project-show':
          await handleProjectShow(respond, services, args);
          break;
        case 'project-create':
          await handleProjectCreate(respond, services, args);
          break;
        case 'project-update':
          await handleProjectUpdate(respond, services, args);
          break;
        case 'project-delete':
          await handleProjectDelete(respond, services, args);
          break;

        // ── Dependency commands ────────────────────────────────────────────────
        case 'dep-add':
          await handleDepAdd(respond, services, args);
          break;
        case 'dep-list':
          await handleDepList(respond, services, args);
          break;
        case 'dep-remove':
          await handleDepRemove(respond, services, args);
          break;

        // ── Comment commands ───────────────────────────────────────────────────
        case 'comment-add':
          await handleCommentAdd(respond, services, identityCache, command, args, slackBotUserId, logger);
          break;
        case 'comment-list':
          await handleCommentList(respond, services, args);
          break;
        case 'comment-delete':
          await handleCommentDelete(respond, services, args);
          break;

        // ── Subtask commands ───────────────────────────────────────────────────
        case 'subtask-create':
          await handleSubtaskCreate(respond, services, identityCache, command, args, slackBotUserId, logger);
          break;
        case 'subtask-list':
          await handleSubtaskList(respond, services, args);
          break;

        // ── Health ─────────────────────────────────────────────────────────────
        case 'health':
          await handleHealth(respond, services);
          break;

        // ── Operational commands (CLI-only stubs) ──────────────────────────────
        case 'backup':
        case 'doctor':
        case 'stats':
        case 'db-check':
        case 'completions':
          await handleCliOnly(respond, subcommand);
          break;

        // ── Notification subscription commands ────────────────────────────────
        case 'subscribe':
          await handleSubscribe(respond, services, subscriptionRepo, command, args);
          break;
        case 'unsubscribe':
          await handleUnsubscribe(respond, subscriptionRepo, command, args);
          break;

        // ── Help ───────────────────────────────────────────────────────────────
        case 'help':
          await respondBlocks(respond, HELP_BLOCKS, 'Tasks \u2014 Available Commands');
          break;

        // ── Empty / bare /tasks → help ─────────────────────────────────────────
        case '':
        case undefined:
          await respondBlocks(respond, HELP_BLOCKS, 'Tasks \u2014 Available Commands');
          break;

        // ── Unknown subcommand ─────────────────────────────────────────────────
        default:
          await respondError(
            respond,
            `Unknown subcommand: \`${subcommand}\``,
            'Run `/tasks help` to see available subcommands.'
          );
      }
    } catch (error) {
      await respondError(respond, formatServiceError(error));
    }
  });
}
