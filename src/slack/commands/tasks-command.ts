import type { App, RespondFn, SlashCommand } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { TaskService } from '../../services/task.service.js';
import type { ProjectService } from '../../services/project.service.js';
import type { DependencyService } from '../../services/dependency.service.js';
import type { CommentService } from '../../services/comment.service.js';
import type { UserIdentityCache } from '../user-identity.js';
import { NotFoundError, ValidationError, BusinessError } from '../../services/errors.js';

export interface Services {
  taskService: TaskService;
  projectService: ProjectService;
  dependencyService: DependencyService;
  commentService: CommentService;
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
];

/**
 * registerTasksCommand — registers the /tasks slash command on the Bolt App.
 *
 * Must be called ONCE per SlackService lifecycle, after slackService.start().
 * Takes a shared UserIdentityCache (constructed once in server.ts) so that
 * the TTL cache is preserved across multiple command invocations.
 *
 * Routing: command.text is split into [subcommand, ...args]. A switch
 * dispatches to subcommand stubs (Plans 02 and 03 will implement them).
 * Unknown subcommands return an ephemeral error with a /tasks help hint.
 *
 * ack() is ALWAYS the first statement — Slack enforces a 3-second deadline
 * for acknowledgement. respond() has no time constraint (30-minute window).
 */
export function registerTasksCommand(
  app: App,
  services: Services,
  identityCache: UserIdentityCache
): void {
  // Suppress "unused" warnings for services/identityCache — Plans 02 and 03 will use them
  void services;
  void identityCache;

  app.command('/tasks', async ({ ack, respond, command }: { ack: () => Promise<void>; respond: RespondFn; command: SlashCommand }) => {
    // FIRST: ack() — must complete within 3 seconds of Slack delivering the event.
    // Everything after this point has no time constraint (respond_url valid 30 min).
    await ack();

    const text = command.text.trim();
    const [subcommand, ...args] = text ? text.split(/\s+/) : [''];

    // Suppress "unused" warning for args — Plans 02 and 03 will use them
    void args;

    try {
      switch (subcommand) {
        // ── Task commands ──────────────────────────────────────────────────────
        case 'list':
          await respondError(respond, 'Not yet implemented: `list`');
          break;
        case 'show':
          await respondError(respond, 'Not yet implemented: `show`');
          break;
        case 'create':
          await respondError(respond, 'Not yet implemented: `create`');
          break;
        case 'update':
          await respondError(respond, 'Not yet implemented: `update`');
          break;
        case 'delete':
          await respondError(respond, 'Not yet implemented: `delete`');
          break;
        case 'claim':
          await respondError(respond, 'Not yet implemented: `claim`');
          break;

        // ── Project commands ───────────────────────────────────────────────────
        case 'project-create':
          await respondError(respond, 'Not yet implemented: `project-create`');
          break;
        case 'project-list':
          await respondError(respond, 'Not yet implemented: `project-list`');
          break;
        case 'project-show':
          await respondError(respond, 'Not yet implemented: `project-show`');
          break;
        case 'project-update':
          await respondError(respond, 'Not yet implemented: `project-update`');
          break;
        case 'project-delete':
          await respondError(respond, 'Not yet implemented: `project-delete`');
          break;

        // ── Dependency commands ────────────────────────────────────────────────
        case 'dep-add':
          await respondError(respond, 'Not yet implemented: `dep-add`');
          break;
        case 'dep-list':
          await respondError(respond, 'Not yet implemented: `dep-list`');
          break;
        case 'dep-remove':
          await respondError(respond, 'Not yet implemented: `dep-remove`');
          break;

        // ── Comment commands ───────────────────────────────────────────────────
        case 'comment-add':
          await respondError(respond, 'Not yet implemented: `comment-add`');
          break;
        case 'comment-list':
          await respondError(respond, 'Not yet implemented: `comment-list`');
          break;
        case 'comment-delete':
          await respondError(respond, 'Not yet implemented: `comment-delete`');
          break;

        // ── Subtask commands ───────────────────────────────────────────────────
        case 'subtask-create':
          await respondError(respond, 'Not yet implemented: `subtask-create`');
          break;
        case 'subtask-list':
          await respondError(respond, 'Not yet implemented: `subtask-list`');
          break;

        // ── Operational commands (CLI-only stubs) ──────────────────────────────
        case 'health':
          await respondError(respond, 'Not yet implemented: `health`');
          break;
        case 'backup':
          await respondError(respond, 'Not yet implemented: `backup`');
          break;
        case 'doctor':
          await respondError(respond, 'Not yet implemented: `doctor`');
          break;
        case 'stats':
          await respondError(respond, 'Not yet implemented: `stats`');
          break;
        case 'db-check':
          await respondError(respond, 'Not yet implemented: `db-check`');
          break;
        case 'completions':
          await respondError(respond, 'Not yet implemented: `completions`');
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
