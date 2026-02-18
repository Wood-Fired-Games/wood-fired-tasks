import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { eventBus } from '../events/event-bus.js';
import type { TaskEvent } from '../events/types.js';
import type { SlackChannelSubscriptionRepository } from './repositories/channel-subscription.repository.js';
import type { ProjectService } from '../services/project.service.js';
import { formatTaskNotification } from './task-formatter.js';

/** Minimal logger interface — accepts Fastify's BaseLogger and pino Logger */
interface NotifierLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

const TASK_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.claimed',
  'task.deleted',
] as const;

const PERMANENT_ERRORS = new Set([
  'not_in_channel',
  'channel_not_found',
  'invalid_auth',
  'token_revoked',
]);

export class SlackNotifier {
  private unsubscribes: Array<() => void> = [];

  constructor(
    private readonly client: WebClient,
    private readonly subscriptionRepo: SlackChannelSubscriptionRepository,
    private readonly projectService: ProjectService,
    private readonly logger: NotifierLogger
  ) {}

  /**
   * Subscribe to task event types on the EventBus.
   *
   * CRITICAL: The handler registered with eventBus.subscribe is synchronous.
   * It calls the async handleTaskEvent method and chains .catch() to avoid
   * unhandled promise rejections. EventBus wraps handlers in try/catch which
   * only catches synchronous throws — an async handler would slip through.
   */
  start(): void {
    for (const eventType of TASK_EVENT_TYPES) {
      const unsub = eventBus.subscribe(eventType, (event: TaskEvent) => {
        this.handleTaskEvent(eventType, event).catch((err) =>
          this.logger.error({ err, eventType }, 'SlackNotifier: unhandled error')
        );
      });
      this.unsubscribes.push(unsub);
    }
  }

  /**
   * Unsubscribe from all EventBus events. Safe to call multiple times.
   */
  stop(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  /**
   * Handle a single task event: look up subscribed channels, resolve
   * project name, format Block Kit message, and post to each channel
   * independently via Promise.allSettled.
   */
  private async handleTaskEvent(eventType: string, event: TaskEvent): Promise<void> {
    const projectId = event.data.project_id;

    // Synchronous better-sqlite3 call
    const channels = this.subscriptionRepo.findSubscribedChannels(projectId, eventType);
    if (channels.length === 0) {
      return;
    }

    // Resolve project name (best-effort)
    let projectName: string;
    try {
      const project = this.projectService.getProject(projectId);
      projectName = project.name;
    } catch {
      projectName = 'Project #' + projectId;
    }

    const blocks = formatTaskNotification(event, projectName);
    const fallbackText = `${eventType}: ${event.data.title}`;

    const results = await Promise.allSettled(
      channels.map((channelId) => this.postWithRetry(channelId, blocks, fallbackText))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        this.logger.error(
          { err: result.reason, channelId: channels[i], eventType },
          'SlackNotifier: failed to post notification'
        );
      }
    }
  }

  /**
   * Post a message to a Slack channel with retry for transient errors.
   * Permanent errors (not_in_channel, channel_not_found, invalid_auth,
   * token_revoked) fail immediately without retry.
   */
  private async postWithRetry(
    channelId: string,
    blocks: KnownBlock[],
    text: string,
    maxRetries = 2
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.client.chat.postMessage({ channel: channelId, blocks, text });
        return;
      } catch (err: unknown) {
        // Check for permanent Slack errors — no point retrying
        const slackError = err as { data?: { error?: string } };
        if (slackError.data?.error && PERMANENT_ERRORS.has(slackError.data.error)) {
          throw err;
        }

        // If last attempt, throw
        if (attempt === maxRetries) {
          throw err;
        }

        // Exponential backoff: 500ms, 1000ms
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
}
