import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { TaskEvent } from '../../events/types.js';
import type { SlackChannelSubscriptionRepository } from '../repositories/channel-subscription.repository.js';
import type { ProjectService } from '../../services/project.service.js';

// ---------------------------------------------------------------------------
// Mock eventBus — store handlers so tests can trigger events directly
// ---------------------------------------------------------------------------

const subscribedHandlers: Array<{ event: string; handler: (payload: unknown) => void }> = [];
const mockUnsubscribeFns: Array<Mock> = [];

vi.mock('../../events/event-bus.js', () => ({
  eventBus: {
    subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
      subscribedHandlers.push({ event, handler });
      const unsubFn = vi.fn();
      mockUnsubscribeFns.push(unsubFn);
      return unsubFn;
    }),
  },
}));

// Mock formatTaskNotification — return canned blocks
vi.mock('../task-formatter.js', () => ({
  formatTaskNotification: vi.fn((_event: unknown, _projectName?: string) => [
    { type: 'section', text: { type: 'mrkdwn', text: 'Test notification' } },
  ]),
}));

// Import after mocks are set up
import { SlackNotifier } from '../notifier.js';
import { formatTaskNotification } from '../task-formatter.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMockClient(): WebClient {
  return {
    chat: {
      postMessage: vi.fn(() => Promise.resolve({ ok: true })),
    },
  } as unknown as WebClient;
}

function makeMockSubscriptionRepo(): SlackChannelSubscriptionRepository {
  return {
    findSubscribedChannels: vi.fn(() => []),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    findByChannel: vi.fn(),
  } as unknown as SlackChannelSubscriptionRepository;
}

function makeMockProjectService(): ProjectService {
  return {
    getProject: vi.fn(() => ({
      id: 1,
      name: 'Test Project',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })),
  } as unknown as ProjectService;
}

function makeMockLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeTaskEvent(overrides: Record<string, unknown> = {}): TaskEvent {
  return {
    eventType: 'task.created',
    timestamp: '2026-02-18T00:00:00Z',
    data: {
      id: 42,
      title: 'Fix login bug',
      description: null,
      status: 'open',
      priority: 'medium',
      project_id: 1,
      parent_task_id: null,
      estimated_minutes: null,
      assignee: null,
      created_by: 'Alice',
      due_date: null,
      created_at: '2026-02-18T00:00:00Z',
      updated_at: '2026-02-18T00:00:00Z',
      version: 1,
      claimed_at: null,
      completed_at: null,
      tags: [],
      ...overrides,
    },
    metadata: { source: 'user', actor: 'Alice' },
  } as TaskEvent;
}

/**
 * Trigger an event handler by event name. Returns a promise that resolves
 * after the async fire-and-forget chain completes.
 */
function triggerEvent(eventName: string, event: TaskEvent): void {
  for (const entry of subscribedHandlers) {
    if (entry.event === eventName) {
      entry.handler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackNotifier', () => {
  let client: WebClient;
  let subscriptionRepo: SlackChannelSubscriptionRepository;
  let projectService: ProjectService;
  let logger: ReturnType<typeof makeMockLogger>;
  let notifier: SlackNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribedHandlers.length = 0;
    mockUnsubscribeFns.length = 0;

    client = makeMockClient();
    subscriptionRepo = makeMockSubscriptionRepo();
    projectService = makeMockProjectService();
    logger = makeMockLogger();
    notifier = new SlackNotifier(client, subscriptionRepo, projectService, logger);

    vi.mocked(formatTaskNotification).mockReturnValue([
      { type: 'section', text: { type: 'mrkdwn', text: 'Test notification' } },
    ]);
  });

  afterEach(() => {
    notifier.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('start() subscribes to 6 task event types', () => {
      notifier.start();

      // Task #1003 added task.claim_released (TTL sweep auto-release).
      expect(subscribedHandlers).toHaveLength(6);
      const eventNames = subscribedHandlers.map((h) => h.event);
      expect(eventNames).toEqual([
        'task.created',
        'task.updated',
        'task.status_changed',
        'task.claimed',
        'task.claim_released',
        'task.deleted',
      ]);
    });

    it('stop() calls all unsubscribe functions', () => {
      notifier.start();
      expect(mockUnsubscribeFns).toHaveLength(6);

      notifier.stop();

      for (const fn of mockUnsubscribeFns) {
        expect(fn).toHaveBeenCalledOnce();
      }
    });

    it('stop() can be called multiple times safely', () => {
      notifier.start();
      notifier.stop();
      notifier.stop(); // should not throw
    });
  });

  // ── Event handling ─────────────────────────────────────────────────────

  describe('Event handling', () => {
    it('posts notification to subscribed channels', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001', 'C002']);
      notifier.start();

      const event = makeTaskEvent();
      triggerEvent('task.created', event);
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C001' }),
      );
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C002' }),
      );
    });

    it('skips posting when no channels subscribed', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue([]);
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('resolves project name from ProjectService', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);
      vi.mocked(projectService.getProject).mockReturnValue({
        id: 1,
        name: 'My Project',
        description: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(formatTaskNotification).toHaveBeenCalledWith(expect.anything(), 'My Project');
    });

    it('uses fallback project name when ProjectService throws', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);
      vi.mocked(projectService.getProject).mockImplementation(() => {
        throw new Error('Not found');
      });
      notifier.start();

      triggerEvent('task.created', makeTaskEvent({ project_id: 7 }));
      await vi.runAllTimersAsync();

      expect(formatTaskNotification).toHaveBeenCalledWith(expect.anything(), 'Project #7');
    });

    it('passes the RAW project name to the formatter (escaping is the formatter choke point, no double-escape)', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);
      vi.mocked(projectService.getProject).mockReturnValue({
        id: 1,
        name: '<!channel>',
        description: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      // Notifier must NOT pre-escape — it hands the raw name to formatTaskNotification,
      // which is the single layer that escapes. Pre-escaping here would double-encode.
      expect(formatTaskNotification).toHaveBeenCalledWith(expect.anything(), '<!channel>');
    });

    it('includes task title in fallback text', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);
      notifier.start();

      triggerEvent('task.created', makeTaskEvent({ title: 'Deploy feature' }));
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Deploy feature') }),
      );
    });
  });

  // ── Error isolation ────────────────────────────────────────────────────

  describe('Error isolation', () => {
    it('one channel failure does not prevent other channels from receiving notification', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001', 'C002']);

      vi.mocked(client.chat.postMessage).mockImplementation((args: unknown) => {
        const { channel } = args as { channel: string };
        if (channel === 'C001') {
          return Promise.reject(new Error('network error'));
        }
        return Promise.resolve({ ok: true } as never);
      });
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      // C002 should still have received its message
      const calls = vi.mocked(client.chat.postMessage).mock.calls;
      const c002Calls = calls.filter((c) => (c[0] as { channel: string }).channel === 'C002');
      expect(c002Calls).toHaveLength(1);

      // Logger should have been called for C001 failure
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'C001' }),
        expect.stringContaining('failed to post notification'),
      );
    });

    it('logs error when chat.postMessage fails after retries', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);
      vi.mocked(client.chat.postMessage).mockRejectedValue(new Error('transient'));
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'C001', eventType: 'task.created' }),
        expect.stringContaining('failed to post notification'),
      );
    });
  });

  // ── Retry behavior ─────────────────────────────────────────────────────

  describe('Retry behavior', () => {
    it('retries transient errors up to 2 times', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);

      let callCount = 0;
      vi.mocked(client.chat.postMessage).mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve({ ok: true } as never);
      });
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(callCount).toBe(3); // 1 initial + 2 retries
    });

    it('does not retry permanent not_in_channel error', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);

      const permanentError = Object.assign(new Error('not_in_channel'), {
        data: { error: 'not_in_channel' },
      });
      vi.mocked(client.chat.postMessage).mockRejectedValue(permanentError);
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('does not retry permanent channel_not_found error', async () => {
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue(['C001']);

      const permanentError = Object.assign(new Error('channel_not_found'), {
        data: { error: 'channel_not_found' },
      });
      vi.mocked(client.chat.postMessage).mockRejectedValue(permanentError);
      notifier.start();

      triggerEvent('task.created', makeTaskEvent());
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Fire-and-forget pattern ────────────────────────────────────────────

  describe('Fire-and-forget pattern', () => {
    it('handler registered with EventBus is synchronous', () => {
      notifier.start();

      // The handler stored by eventBus.subscribe should be synchronous.
      // When called, it returns undefined (not a Promise) because the async
      // work is chained via .catch(). The try/catch in EventBus will catch
      // synchronous throws, and .catch() handles the async rejection.
      const handler = subscribedHandlers[0]!.handler;

      // Call with a minimal event — the return value should NOT be a Promise
      vi.mocked(subscriptionRepo.findSubscribedChannels).mockReturnValue([]);
      const result = handler(makeTaskEvent());
      expect(result).toBeUndefined();
    });
  });
});
