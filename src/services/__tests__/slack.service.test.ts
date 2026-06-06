import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackService } from '../slack.service.js';

// Mock pino logger
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  level: 'info',
} as any;

// The mock App instance methods — shared so tests can verify calls
const mockAppInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

// Mock @slack/bolt — App must be a proper constructor (class or function, not arrow fn)
vi.mock('@slack/bolt', () => {
  const MockApp = vi.fn(function () {
    return mockAppInstance;
  });
  return { App: MockApp };
});

import { App } from '@slack/bolt';

describe('SlackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock instance methods after clearAllMocks
    mockAppInstance.start.mockResolvedValue(undefined);
    mockAppInstance.stop.mockResolvedValue(undefined);
  });

  describe('when tokens are absent', () => {
    it('should not create App or connect', async () => {
      const service = new SlackService(undefined, undefined, mockLogger);

      await service.start();

      expect(App).not.toHaveBeenCalled();
      expect(service.isEnabled()).toBe(false);
    });

    it('should log that Slack integration is disabled', async () => {
      const service = new SlackService(undefined, undefined, mockLogger);

      await service.start();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    it('should handle stop() gracefully when never started', async () => {
      const service = new SlackService(undefined, undefined, mockLogger);

      // Should not throw
      await expect(service.stop()).resolves.toBeUndefined();
    });

    it('should return null from getApp()', async () => {
      const service = new SlackService(undefined, undefined, mockLogger);

      await service.start();

      expect(service.getApp()).toBeNull();
    });
  });

  describe('when tokens are present', () => {
    const BOT_TOKEN = 'xoxb-test-token';
    const APP_TOKEN = 'xapp-test-token';

    it('should create App and connect via Socket Mode', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();

      expect(App).toHaveBeenCalledWith({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        socketMode: true,
      });
    });

    it('should call app.start() on the Bolt instance', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();

      expect(mockAppInstance.start).toHaveBeenCalled();
    });

    it('should report isEnabled() true after start', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();

      expect(service.isEnabled()).toBe(true);
    });

    it('should return App instance from getApp()', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();

      expect(service.getApp()).not.toBeNull();
    });

    it('should log connection confirmation', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Socket Mode'));
    });
  });

  describe('graceful shutdown', () => {
    const BOT_TOKEN = 'xoxb-test-token';
    const APP_TOKEN = 'xapp-test-token';

    it('should call app.stop() on stop()', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();
      await service.stop();

      expect(mockAppInstance.stop).toHaveBeenCalled();
    });

    it('should report isEnabled() false after stop', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();
      await service.stop();

      expect(service.isEnabled()).toBe(false);
    });

    it('should log disconnection', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();
      vi.clearAllMocks(); // Clear start() logs to isolate stop() logs
      mockAppInstance.stop.mockResolvedValue(undefined);
      await service.stop();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
    });

    it('should not call app.stop() twice on repeated stop() calls', async () => {
      const service = new SlackService(BOT_TOKEN, APP_TOKEN, mockLogger);

      await service.start();
      await service.stop();
      await service.stop(); // Second call should be a no-op

      expect(mockAppInstance.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop before start completes', () => {
    it('should handle stop() when start() was never called', async () => {
      const service = new SlackService('xoxb-token', 'xapp-token', mockLogger);

      // Do NOT call start(), call stop() directly
      await expect(service.stop()).resolves.toBeUndefined();
    });
  });
});
