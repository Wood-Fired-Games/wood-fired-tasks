import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configSchema,
  ExitCodes,
  CliExitCodes,
  resetConfig,
  parseApiKeyEntries,
} from '../env.js';

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
        // task #188: HOST defaults to 127.0.0.1 (loopback) — operators must
        // opt in to LAN exposure with HOST=0.0.0.0 or a specific LAN IP.
        expect(result.data.HOST).toBe('127.0.0.1');
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
        // task #188: default HOST is loopback-only.
        expect(result.data.HOST).toBe('127.0.0.1');
        expect(result.data.LOG_LEVEL).toBe('info');
        expect(result.data.DATABASE_PATH).toBe('./data/tasks.db');
        expect(result.data.CONNECTION_TIMEOUT).toBe(120000);
        expect(result.data.REQUEST_TIMEOUT).toBe(60000);
        expect(result.data.KEEP_ALIVE_TIMEOUT).toBe(10000);
        expect(result.data.WAL_CHECKPOINT_INTERVAL_MS).toBe(900000);
      }
    });

    it('should default HOST to loopback (127.0.0.1) — task #188', () => {
      // Operators who want LAN exposure must explicitly set HOST=0.0.0.0
      // (or a specific LAN IP). The default must never silently bind to
      // every interface; a new OSS user following the README quick-start
      // would otherwise expose the task tracker on every NIC.
      process.env.API_KEYS = 'test-key';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HOST).toBe('127.0.0.1');
      }
    });

    it('should honour explicit HOST override for LAN exposure', () => {
      // Verify the opt-in path: when an operator sets HOST=0.0.0.0
      // explicitly, the schema must pass that value through unchanged.
      process.env.API_KEYS = 'test-key';
      process.env.HOST = '0.0.0.0';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HOST).toBe('0.0.0.0');
      }
    });

    it('should honour an explicit LAN IP for HOST', () => {
      // A common middle ground is binding to a specific LAN IP rather
      // than 0.0.0.0; the schema must accept any non-empty string.
      process.env.API_KEYS = 'test-key';
      process.env.HOST = '192.168.1.42';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HOST).toBe('192.168.1.42');
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

  describe('parseApiKeyEntries (key:label format)', () => {
    it('returns empty list for undefined input', () => {
      expect(parseApiKeyEntries(undefined)).toEqual([]);
    });

    it('returns empty list for empty string', () => {
      expect(parseApiKeyEntries('')).toEqual([]);
    });

    it('parses a single bare key with auto-derived label', () => {
      const entries = parseApiKeyEntries('abc12345xxxxxxxx');
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('abc12345xxxxxxxx');
      // First 8 chars of the key.
      expect(entries[0].label).toBe('key_abc12345');
    });

    it('uses entire key as label suffix when key is shorter than 8 chars', () => {
      const entries = parseApiKeyEntries('short');
      expect(entries).toEqual([{ key: 'short', label: 'key_short' }]);
    });

    it('parses a single key:label entry', () => {
      const entries = parseApiKeyEntries('abc123:ci-bot');
      expect(entries).toEqual([{ key: 'abc123', label: 'ci-bot' }]);
    });

    it('parses multiple bare keys', () => {
      const entries = parseApiKeyEntries('aaaaaaaa11,bbbbbbbb22,cccccccc33');
      expect(entries).toEqual([
        { key: 'aaaaaaaa11', label: 'key_aaaaaaaa' },
        { key: 'bbbbbbbb22', label: 'key_bbbbbbbb' },
        { key: 'cccccccc33', label: 'key_cccccccc' },
      ]);
    });

    it('parses multiple key:label entries', () => {
      const entries = parseApiKeyEntries('abc:one,def:two,ghi:three');
      expect(entries).toEqual([
        { key: 'abc', label: 'one' },
        { key: 'def', label: 'two' },
        { key: 'ghi', label: 'three' },
      ]);
    });

    it('parses mixed bare and labelled entries', () => {
      const entries = parseApiKeyEntries(
        'abc12345xxxxxxxx,def456:ci-bot,ghi789:alice-laptop',
      );
      expect(entries).toEqual([
        { key: 'abc12345xxxxxxxx', label: 'key_abc12345' },
        { key: 'def456', label: 'ci-bot' },
        { key: 'ghi789', label: 'alice-laptop' },
      ]);
    });

    it('trims whitespace around keys and labels', () => {
      const entries = parseApiKeyEntries('  abc  :  ci-bot  ,  def  ');
      expect(entries).toEqual([
        { key: 'abc', label: 'ci-bot' },
        { key: 'def', label: 'key_def' },
      ]);
    });

    it('drops empty entries from trailing or doubled commas', () => {
      const entries = parseApiKeyEntries('abc:one,,def:two,');
      expect(entries).toEqual([
        { key: 'abc', label: 'one' },
        { key: 'def', label: 'two' },
      ]);
    });

    it('permits duplicate labels (operator choice)', () => {
      const entries = parseApiKeyEntries('aaa:shared,bbb:shared');
      expect(entries).toEqual([
        { key: 'aaa', label: 'shared' },
        { key: 'bbb', label: 'shared' },
      ]);
    });

    it('rejects an entry with empty label after ":"', () => {
      expect(() => parseApiKeyEntries('abc:')).toThrow(/empty label after ':'/);
      expect(() => parseApiKeyEntries('abc:  ')).toThrow(/empty label after ':'/);
    });

    it('rejects an entry with empty key before ":"', () => {
      expect(() => parseApiKeyEntries(':label-only')).toThrow(
        /empty key before ':'/,
      );
    });

    it('rejects an entry containing more than one ":"', () => {
      expect(() => parseApiKeyEntries('abc:def:ghi')).toThrow(
        /multiple ':' separators/,
      );
    });

    it('rejects label containing ":" via the multiple-colon rule', () => {
      // A label like "ci:bot" produces two colons in the entry, which is
      // ambiguous (could be key="ci:bot", label="" or key="ci", label="bot").
      // We reject rather than guess.
      expect(() => parseApiKeyEntries('abc:ci:bot')).toThrow(
        /multiple ':' separators/,
      );
    });

    it('does NOT log or surface the raw key in error messages', () => {
      const sensitive = 'super-secret-key-do-not-leak';
      try {
        parseApiKeyEntries(`${sensitive}::extra`);
        // Should have thrown.
        expect.fail('expected parseApiKeyEntries to throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain(sensitive);
        // Position-based error reference is fine.
        expect(msg).toMatch(/entry #1/);
      }
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
