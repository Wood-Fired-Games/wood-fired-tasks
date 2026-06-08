import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configSchema, ExitCodes, CliExitCodes, resetConfig, parseApiKeyEntries } from '../env.js';
// task #731 + C1/H1: DATABASE_PATH now defaults via the unified resolver
// (env > legacy-adopt ./data/tasks.db > OS app-data). When unset, the schema
// default delegates to `resolveDbPath()`, so assert against that exact source
// of truth — its result depends on the test cwd (legacy file present?) and the
// app-data DB state, which `resolveDbPath()` itself accounts for.
import { resolveDbPath } from '../db-path.js';

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
    delete process.env.DATABASE_PATH;
    delete process.env.CONNECTION_TIMEOUT;
    delete process.env.REQUEST_TIMEOUT;
    delete process.env.KEEP_ALIVE_TIMEOUT;
    delete process.env.WAL_CHECKPOINT_INTERVAL_MS;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.LEGACY_AUTH_SUNSET_DATE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Valid configuration', () => {
    it('should parse valid configuration with all required fields', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.PORT).toBe(3000);
        // task #188: HOST defaults to 127.0.0.1 (loopback) — operators must
        // opt in to LAN exposure with HOST=0.0.0.0 or a specific LAN IP.
        expect(result.data.HOST).toBe('127.0.0.1');
        expect(result.data.LOG_LEVEL).toBe('info');
        expect(result.data.DATABASE_PATH).toBe(resolveDbPath());
        expect(result.data.CONNECTION_TIMEOUT).toBe(120000);
        expect(result.data.REQUEST_TIMEOUT).toBe(60000);
        expect(result.data.KEEP_ALIVE_TIMEOUT).toBe(10000);
        expect(result.data.WAL_CHECKPOINT_INTERVAL_MS).toBe(900000);
      }
    });

    it('should use defaults for optional values', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.PORT).toBe(3000);
        // task #188: default HOST is loopback-only.
        expect(result.data.HOST).toBe('127.0.0.1');
        expect(result.data.LOG_LEVEL).toBe('info');
        expect(result.data.DATABASE_PATH).toBe(resolveDbPath());
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

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HOST).toBe('127.0.0.1');
      }
    });

    it('should honour explicit HOST override for LAN exposure', () => {
      // Verify the opt-in path: when an operator sets HOST=0.0.0.0
      // explicitly, the schema must pass that value through unchanged.
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
      process.env.HOST = '192.168.1.42';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HOST).toBe('192.168.1.42');
      }
    });

    it('should accept production NODE_ENV', () => {
      process.env.NODE_ENV = 'production';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('production');
      }
    });

    it('should accept test NODE_ENV', () => {
      process.env.NODE_ENV = 'test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('test');
      }
    });

    it('should transform PORT string to number', () => {
      process.env.PORT = '8080';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe(8080);
        expect(typeof result.data.PORT).toBe('number');
      }
    });

    it('should transform timeout strings to numbers', () => {
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
      process.env.LOG_LEVEL = 'debug';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LOG_LEVEL).toBe('debug');
      }
    });

    it('should accept custom DATABASE_PATH', () => {
      process.env.DATABASE_PATH = '/custom/path/db.sqlite';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DATABASE_PATH).toBe('/custom/path/db.sqlite');
      }
    });
  });

  describe('Invalid configuration', () => {
    it('should fail on invalid NODE_ENV', () => {
      process.env.NODE_ENV = 'invalid-env';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
    });

    it('should fail on invalid LOG_LEVEL', () => {
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
      const entries = parseApiKeyEntries('abc12345xxxxxxxx,def456:ci-bot,ghi789:alice-laptop');
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
      expect(() => parseApiKeyEntries(':label-only')).toThrow(/empty key before ':'/);
    });

    it('rejects an entry containing more than one ":"', () => {
      expect(() => parseApiKeyEntries('abc:def:ghi')).toThrow(/multiple ':' separators/);
    });

    it('rejects label containing ":" via the multiple-colon rule', () => {
      // A label like "ci:bot" produces two colons in the entry, which is
      // ambiguous (could be key="ci:bot", label="" or key="ci", label="bot").
      // We reject rather than guess.
      expect(() => parseApiKeyEntries('abc:ci:bot')).toThrow(/multiple ':' separators/);
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

  describe('OIDC + session-cookie validation (Phase 29-01)', () => {
    beforeEach(() => {
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      delete process.env.OIDC_REDIRECT_URI;
      delete process.env.OIDC_SCOPES;
      delete process.env.OIDC_DEVICE_CLIENT_ID;
      delete process.env.SESSION_COOKIE_NAME;
      delete process.env.SESSION_COOKIE_SECRET;
    });

    // 32-byte base64 secret (sodium key constraint per 29-RESEARCH.md).
    const validSecret32 = Buffer.alloc(32).toString('base64');
    const tooShortSecret31 = Buffer.alloc(31).toString('base64');
    const tooLongSecret33 = Buffer.alloc(33).toString('base64');

    it('accepts a SESSION_COOKIE_SECRET of exactly 32 bytes (base64)', () => {
      process.env.SESSION_COOKIE_SECRET = validSecret32;

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SESSION_COOKIE_SECRET).toBe(validSecret32);
      }
    });

    it('rejects a SESSION_COOKIE_SECRET that decodes to 31 bytes', () => {
      process.env.SESSION_COOKIE_SECRET = tooShortSecret31;

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join(' ');
        expect(msgs).toContain('base64-encoded 32 bytes');
      }
    });

    it('rejects a SESSION_COOKIE_SECRET that decodes to 33 bytes', () => {
      process.env.SESSION_COOKIE_SECRET = tooLongSecret33;

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join(' ');
        expect(msgs).toContain('base64-encoded 32 bytes');
      }
    });

    it('rejects a non-base64 garbage SESSION_COOKIE_SECRET', () => {
      // `!!!` is not valid base64; Buffer.from is lenient but decoded length
      // will not be 32, so the refine still rejects it.
      process.env.SESSION_COOKIE_SECRET = '!!!';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join(' ');
        expect(msgs).toContain('base64-encoded 32 bytes');
      }
    });

    it('accepts the full OIDC quartet + SESSION_COOKIE_SECRET set together', () => {
      process.env.OIDC_ISSUER_URL = 'https://accounts.google.com';
      process.env.OIDC_CLIENT_ID = 'client-id';
      process.env.OIDC_CLIENT_SECRET = 'client-secret';
      process.env.OIDC_REDIRECT_URI = 'https://example.com/auth/callback';
      process.env.SESSION_COOKIE_SECRET = validSecret32;

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OIDC_ISSUER_URL).toBe('https://accounts.google.com');
        expect(result.data.OIDC_CLIENT_ID).toBe('client-id');
        expect(result.data.OIDC_CLIENT_SECRET).toBe('client-secret');
        expect(result.data.OIDC_REDIRECT_URI).toBe('https://example.com/auth/callback');
      }
    });

    it('#833: OIDC_DEVICE_CLIENT_ID defaults to "wft-cli", independent of the OIDC group', () => {
      // No OIDC vars set at all → the device client id still resolves to its
      // default (it is NOT part of the all-or-nothing OIDC quartet), so the
      // stock CLI's 'wft-cli' matches a stock server out of the box.
      const result = configSchema.safeParse(process.env);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OIDC_DEVICE_CLIENT_ID).toBe('wft-cli');
      }
    });

    it('#833: OIDC_DEVICE_CLIENT_ID is operator-overridable and does NOT require the OIDC quartet', () => {
      process.env.OIDC_DEVICE_CLIENT_ID = 'my-cli-client';
      const result = configSchema.safeParse(process.env);
      // Set alone (no OIDC_ISSUER_URL/etc.) — must still validate, proving it is
      // decoupled from the all-or-nothing OIDC group and from OIDC_CLIENT_ID.
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OIDC_DEVICE_CLIENT_ID).toBe('my-cli-client');
      }
    });

    it('rejects partial OIDC configuration (only OIDC_ISSUER_URL set)', () => {
      process.env.OIDC_ISSUER_URL = 'https://accounts.google.com';
      process.env.SESSION_COOKIE_SECRET = validSecret32;

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join(' ');
        expect(msgs).toContain('OIDC_* must all be set together, or none at all');
      }
    });

    it('rejects OIDC enabled without SESSION_COOKIE_SECRET', () => {
      process.env.OIDC_ISSUER_URL = 'https://accounts.google.com';
      process.env.OIDC_CLIENT_ID = 'client-id';
      process.env.OIDC_CLIENT_SECRET = 'client-secret';
      process.env.OIDC_REDIRECT_URI = 'https://example.com/auth/callback';
      // SESSION_COOKIE_SECRET intentionally unset.

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const msgs = result.error.issues.map((i) => i.message).join(' ');
        expect(msgs).toContain('SESSION_COOKIE_SECRET is required when OIDC is enabled');
      }
    });

    it('accepts disabled mode (no OIDC vars, no SESSION_COOKIE_SECRET)', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OIDC_ISSUER_URL).toBeUndefined();
        expect(result.data.OIDC_CLIENT_ID).toBeUndefined();
        expect(result.data.OIDC_CLIENT_SECRET).toBeUndefined();
        expect(result.data.OIDC_REDIRECT_URI).toBeUndefined();
        expect(result.data.SESSION_COOKIE_SECRET).toBeUndefined();
      }
    });

    it('defaults OIDC_SCOPES to "openid email profile" when unset', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OIDC_SCOPES).toBe('openid email profile');
      }
    });

    it('defaults SESSION_COOKIE_NAME to "wft_session" when unset', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SESSION_COOKIE_NAME).toBe('wft_session');
      }
    });
  });

  describe('Slack token validation', () => {
    it('should accept config with both Slack tokens absent', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_BOT_TOKEN).toBeUndefined();
        expect(result.data.SLACK_APP_TOKEN).toBeUndefined();
      }
    });

    it('should accept config with both Slack tokens present', () => {
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
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((i) => i.message).join(' ');
        expect(errorMessages).toContain(
          'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together',
        );
      }
    });

    it('should reject config with only SLACK_APP_TOKEN', () => {
      process.env.SLACK_APP_TOKEN = 'xapp-test';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const slackError = result.error.issues.find((issue) => issue.path[0] === 'SLACK_APP_TOKEN');
        expect(slackError).toBeDefined();
      }
    });

    it('should include SLACK tokens in Config type', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-verify';
      process.env.SLACK_APP_TOKEN = 'xapp-verify';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_BOT_TOKEN).toBe('xoxb-verify');
      }
    });
  });

  describe('LEGACY_AUTH_SUNSET_DATE (Phase 31-05)', () => {
    // RFC 8594 `Sunset:` header value sent on every legacy-X-API-Key-authed
    // response. The header is operator-controlled by design (T-31-14); zod's
    // role is to refuse a value that would render a malformed header or a
    // calendar-invalid date.

    it('defaults to 2026-12-31 when unset', () => {
      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LEGACY_AUTH_SUNSET_DATE).toBe('2026-12-31');
      }
    });

    it('accepts a future operator-supplied date', () => {
      process.env.LEGACY_AUTH_SUNSET_DATE = '2027-06-30';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LEGACY_AUTH_SUNSET_DATE).toBe('2027-06-30');
      }
    });

    it('rejects a non-YYYY-MM-DD shape', () => {
      process.env.LEGACY_AUTH_SUNSET_DATE = 'not-a-date';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((i) => i.message).join(' ');
        expect(errorMessages).toMatch(/LEGACY_AUTH_SUNSET_DATE/);
      }
    });

    it('rejects well-formed but calendar-invalid dates (e.g. 2026-13-99)', () => {
      process.env.LEGACY_AUTH_SUNSET_DATE = '2026-13-99';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((i) => i.message).join(' ');
        expect(errorMessages).toMatch(/LEGACY_AUTH_SUNSET_DATE/);
      }
    });

    it('rejects an out-of-range month even if regex passes (2026-02-30)', () => {
      // 2026-02-30 matches the regex (\d{4}-\d{2}-\d{2}) but Feb 30 is not a
      // calendar-valid date. The refine() guard must catch this.
      process.env.LEGACY_AUTH_SUNSET_DATE = '2026-02-30';

      const result = configSchema.safeParse(process.env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((i) => i.message).join(' ');
        expect(errorMessages).toMatch(/LEGACY_AUTH_SUNSET_DATE/);
      }
    });
  });
});
