import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configSchema, ExitCodes, CliExitCodes, resetConfig } from '../env.js';

describe('Configuration Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules and config before each test
    vi.resetModules();
    resetConfig();
    // Clear relevant env vars
    delete process.env.NODE_ENV;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.LOG_LEVEL;
    delete process.env.API_KEYS;
    delete process.env.DATABASE_PATH;
    delete process.env.CONNECTION_TIMEOUT;
    delete process.env.REQUEST_TIMEOUT;
    delete process.env.KEEP_ALIVE_TIMEOUT;
    delete process.env.WAL_CHECKPOINT_INTERVAL_MS;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Valid configuration', () => {
    it('should parse valid configuration with all required fields', () => {
      process.env.API_KEYS = 'test-key-1,test-key-2';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.API_KEYS).toBe('test-key-1,test-key-2');
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.PORT).toBe(3000);
        expect(result.data.HOST).toBe('0.0.0.0');
        expect(result.data.LOG_LEVEL).toBe('info');
        expect(result.data.DATABASE_PATH).toBe('./data/tasks.db');
        expect(result.data.CONNECTION_TIMEOUT).toBe(120000);
        expect(result.data.REQUEST_TIMEOUT).toBe(60000);
        expect(result.data.KEEP_ALIVE_TIMEOUT).toBe(10000);
        expect(result.data.WAL_CHECKPOINT_INTERVAL_MS).toBe(900000);
      }
    });

    it('should use defaults for optional values', () => {
      process.env.API_KEYS = 'test-key';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.PORT).toBe(3000);
        expect(result.data.HOST).toBe('0.0.0.0');
        expect(result.data.LOG_LEVEL).toBe('info');
        expect(result.data.DATABASE_PATH).toBe('./data/tasks.db');
        expect(result.data.CONNECTION_TIMEOUT).toBe(120000);
        expect(result.data.REQUEST_TIMEOUT).toBe(60000);
        expect(result.data.KEEP_ALIVE_TIMEOUT).toBe(10000);
        expect(result.data.WAL_CHECKPOINT_INTERVAL_MS).toBe(900000);
      }
    });

    it('should accept production NODE_ENV', () => {
      process.env.API_KEYS = 'test-key';
      process.env.NODE_ENV = 'production';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('production');
      }
    });

    it('should accept test NODE_ENV', () => {
      process.env.API_KEYS = 'test-key';
      process.env.NODE_ENV = 'test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('test');
      }
    });

    it('should transform PORT string to number', () => {
      process.env.API_KEYS = 'test-key';
      process.env.PORT = '8080';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
        expect(typeof result.data.PORT).toBe('number');
      }
    });

    it('should transform timeout strings to numbers', () => {
      process.env.API_KEYS = 'test-key';
      process.env.CONNECTION_TIMEOUT = '5000';
      process.env.REQUEST_TIMEOUT = '3000';
      process.env.KEEP_ALIVE_TIMEOUT = '1000';
      process.env.WAL_CHECKPOINT_INTERVAL_MS = '60000';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CONNECTION_TIMEOUT).toBe(5000);
        expect(result.data.REQUEST_TIMEOUT).toBe(3000);
        expect(result.data.KEEP_ALIVE_TIMEOUT).toBe(1000);
        expect(result.data.WAL_CHECKPOINT_INTERVAL_MS).toBe(60000);
      }
    });

    it('should accept custom LOG_LEVEL values', () => {
      process.env.API_KEYS = 'test-key';
      process.env.LOG_LEVEL = 'debug';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LOG_LEVEL).toBe('debug');
      }
    });

    it('should accept custom DATABASE_PATH', () => {
      process.env.API_KEYS = 'test-key';
      process.env.DATABASE_PATH = '/custom/path/db.sqlite';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DATABASE_PATH).toBe('/custom/path/db.sqlite');
      }
    });
  });

  describe('Invalid configuration', () => {
    it('should fail on missing API_KEYS', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const apiKeyError = result.error.issues.find(
          (issue) => issue.path[0] === 'API_KEYS'
        );
        expect(apiKeyError).toBeDefined();
        // Zod reports this as a required/invalid type error
        expect(apiKeyError?.code).toBe('invalid_type');
      }
    });

    it('should fail on empty API_KEYS', () => {
      process.env.API_KEYS = '';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const apiKeyError = result.error.issues.find(
          (issue) => issue.path[0] === 'API_KEYS'
        );
        expect(apiKeyError).toBeDefined();
      }
    });

    it('should fail on invalid NODE_ENV', () => {
      process.env.API_KEYS = 'test-key';
      process.env.NODE_ENV = 'invalid-env';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
    });

    it('should fail on invalid LOG_LEVEL', () => {
      process.env.API_KEYS = 'test-key';
      process.env.LOG_LEVEL = 'invalid-level';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
    });

    it('should report multiple validation errors', () => {
      process.env.NODE_ENV = 'invalid';
      process.env.LOG_LEVEL = 'invalid';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('ExitCodes constants', () => {
    it('should define EX_OK as 0', () => {
      expect(ExitCodes.EX_OK).toBe(0);
    });

    it('should define EX_USAGE as 64', () => {
      expect(ExitCodes.EX_USAGE).toBe(64);
    });

    it('should define EX_DATAERR as 65', () => {
      expect(ExitCodes.EX_DATAERR).toBe(65);
    });

    it('should define EX_SOFTWARE as 70', () => {
      expect(ExitCodes.EX_SOFTWARE).toBe(70);
    });

    it('should define EX_CONFIG as 78', () => {
      expect(ExitCodes.EX_CONFIG).toBe(78);
    });

    it('should have all sysexits.h standard codes', () => {
      expect(ExitCodes.EX_OK).toBe(0);
      expect(ExitCodes.EX_USAGE).toBe(64);
      expect(ExitCodes.EX_DATAERR).toBe(65);
      expect(ExitCodes.EX_NOINPUT).toBe(66);
      expect(ExitCodes.EX_UNAVAILABLE).toBe(69);
      expect(ExitCodes.EX_SOFTWARE).toBe(70);
      expect(ExitCodes.EX_OSERR).toBe(71);
      expect(ExitCodes.EX_CANTCREAT).toBe(73);
      expect(ExitCodes.EX_IOERR).toBe(74);
      expect(ExitCodes.EX_TEMPFAIL).toBe(75);
      expect(ExitCodes.EX_PROTOCOL).toBe(76);
      expect(ExitCodes.EX_NOPERM).toBe(77);
      expect(ExitCodes.EX_CONFIG).toBe(78);
    });
  });

  describe('CliExitCodes constants', () => {
    it('should define SUCCESS as 0', () => {
      expect(CliExitCodes.SUCCESS).toBe(0);
    });

    it('should define GENERAL_ERROR as 1', () => {
      expect(CliExitCodes.GENERAL_ERROR).toBe(1);
    });

    it('should define USAGE_ERROR as 2', () => {
      expect(CliExitCodes.USAGE_ERROR).toBe(2);
    });

    it('should define CONFIG_ERROR as 78', () => {
      expect(CliExitCodes.CONFIG_ERROR).toBe(78);
    });
  });

  describe('Slack token validation', () => {
    it('should accept config with both Slack tokens absent', () => {
      process.env.API_KEYS = 'test-key';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_BOT_TOKEN).toBeUndefined();
        expect(result.data.SLACK_APP_TOKEN).toBeUndefined();
      }
    });

    it('should accept config with both Slack tokens present', () => {
      process.env.API_KEYS = 'test-key';
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_BOT_TOKEN).toBe('xoxb-test');
        expect(result.data.SLACK_APP_TOKEN).toBe('xapp-test');
      }
    });

    it('should reject config with only SLACK_BOT_TOKEN', () => {
      process.env.API_KEYS = 'test-key';
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((i) => i.message).join(' ');
        expect(errorMessages).toContain('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together');
      }
    });

    it('should reject config with only SLACK_APP_TOKEN', () => {
      process.env.API_KEYS = 'test-key';
      process.env.SLACK_APP_TOKEN = 'xapp-test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const slackError = result.error.issues.find(
          (issue) => issue.path[0] === 'SLACK_APP_TOKEN'
        );
        expect(slackError).toBeDefined();
      }
    });

    it('should include SLACK tokens in Config type', () => {
      process.env.API_KEYS = 'test-key';
      process.env.SLACK_BOT_TOKEN = 'xoxb-verify';
      process.env.SLACK_APP_TOKEN = 'xapp-verify';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_BOT_TOKEN).toBe('xoxb-verify');
      }
    });
  });
});
