import { z } from 'zod';

/**
 * sysexits.h standard exit codes
 * @see https://www.freebsd.org/cgi/man.cgi?query=sysexits
 */
export const ExitCodes = {
  /** Success */
  EX_OK: 0,
  /** Command line usage error */
  EX_USAGE: 64,
  /** Data format error */
  EX_DATAERR: 65,
  /** Cannot open input */
  EX_NOINPUT: 66,
  /** Service unavailable */
  EX_UNAVAILABLE: 69,
  /** Internal software error */
  EX_SOFTWARE: 70,
  /** System error */
  EX_OSERR: 71,
  /** Cannot create output file */
  EX_CANTCREAT: 73,
  /** I/O error */
  EX_IOERR: 74,
  /** Temporary failure */
  EX_TEMPFAIL: 75,
  /** Remote error in protocol */
  EX_PROTOCOL: 76,
  /** Permission denied */
  EX_NOPERM: 77,
  /** Configuration error */
  EX_CONFIG: 78,
} as const;

/**
 * Simplified exit codes for CLI use
 */
export const CliExitCodes = {
  /** Success */
  SUCCESS: 0,
  /** General error */
  GENERAL_ERROR: 1,
  /** Usage error */
  USAGE_ERROR: 2,
  /** Configuration error */
  CONFIG_ERROR: 78,
} as const;

/**
 * Configuration schema with Zod validation
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().min(1).default('3000').transform(Number),
  // task #188: default to loopback so a quick-start `npm run dev` on a public
  // network does not expose the task tracker on every interface. Operators
  // who want LAN access must opt in explicitly with HOST=0.0.0.0 (or a
  // specific LAN IP). The bound interface is logged at startup so the
  // default is visible.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  API_KEYS: z.string().min(1, 'API_KEYS is required and cannot be empty'),
  DATABASE_PATH: z.string().min(1).default('./data/tasks.db'),
  CONNECTION_TIMEOUT: z.string().min(1).default('120000').transform(Number),
  REQUEST_TIMEOUT: z.string().min(1).default('60000').transform(Number),
  KEEP_ALIVE_TIMEOUT: z.string().min(1).default('10000').transform(Number),
  WAL_CHECKPOINT_INTERVAL_MS: z.string().min(1).default('900000').transform(Number),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  // task #185: gate Swagger UI / JSON spec in production. Disabled by default;
  // operators opt-in with ENABLE_SWAGGER_IN_PRODUCTION=true. When enabled in
  // production, the canonical auth plugin gates /docs and /docs/json.
  ENABLE_SWAGGER_IN_PRODUCTION: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // task #185: SSE connection caps. New per-key/per-IP/global limits bound
  // long-lived connection exhaustion. When any cap is hit the route returns
  // 429 with Retry-After.
  SSE_MAX_CONNECTIONS_PER_KEY: z.string().min(1).default('4').transform(Number),
  SSE_MAX_CONNECTIONS_PER_IP: z.string().min(1).default('8').transform(Number),
  SSE_MAX_CONNECTIONS: z.string().min(1).default('200').transform(Number),
  // Phase 29: OIDC browser flow + session cookie configuration.
  // All four OIDC_* vars are all-or-nothing (see refine below). When unset,
  // OIDC routes return 501 and the session strategy returns null — PAT +
  // legacy auth continue to work (disabled mode).
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  // WR-03 fix — `post_logout_redirect_uri` for RP-initiated logout.
  // Optional: when absent, the wiring at src/api/server.ts derives a
  // default from OIDC_REDIRECT_URI's origin (+ `/auth/login`). Sourcing
  // from configuration (rather than request.protocol/hostname headers)
  // makes the value immune to a malicious upstream proxy spoofing the
  // Host header.
  OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().min(1).default('openid email profile'),
  SESSION_COOKIE_NAME: z.string().min(1).default('wfb_session'),
  // SESSION_COOKIE_SECRET is the sealed-box key for @fastify/secure-session.
  // sodium requires exactly 32 bytes; the refine enforces that strictly so
  // misconfiguration cannot silently produce a weaker key.
  // Generate with: openssl rand -base64 32
  SESSION_COOKIE_SECRET: z
    .string()
    .min(1)
    .refine(
      (s) => {
        try {
          return Buffer.from(s, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      {
        message:
          'SESSION_COOKIE_SECRET must be base64-encoded 32 bytes (openssl rand -base64 32)',
      },
    )
    .optional(),
  // Phase 31 (Plan 31-05): RFC 8594 `Sunset:` header value stamped on every
  // legacy-X-API-Key-authed response. Operator-controlled by design
  // (T-31-14) — operators may pick the date that fits their rollout.
  // Validation is two-step:
  //   1. Regex enforces the wire shape (YYYY-MM-DD).
  //   2. refine() round-trips through Date so calendar-invalid values
  //      (e.g. `2026-13-99`, `2026-02-30`) fail loudly. The round-trip
  //      anchors on `T00:00:00Z` so we compare apples-to-apples against
  //      the ISO substring, dodging the JS quirk where `new Date('2026-02-30')`
  //      silently rolls over to March.
  LEGACY_AUTH_SUNSET_DATE: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      'LEGACY_AUTH_SUNSET_DATE must be YYYY-MM-DD',
    )
    .refine(
      (s) => {
        const d = new Date(s + 'T00:00:00Z');
        if (Number.isNaN(d.getTime())) return false;
        return d.toISOString().slice(0, 10) === s;
      },
      'LEGACY_AUTH_SUNSET_DATE must be a valid calendar date',
    )
    .default('2026-12-31'),
}).refine(
  (d) => (!d.SLACK_BOT_TOKEN && !d.SLACK_APP_TOKEN) || (!!d.SLACK_BOT_TOKEN && !!d.SLACK_APP_TOKEN),
  {
    message: 'Both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together, or neither should be set',
    path: ['SLACK_APP_TOKEN'],
  }
).refine(
  (d) => {
    // All-or-nothing: either zero or all four OIDC_* vars are defined.
    const oidcVars = [
      d.OIDC_ISSUER_URL,
      d.OIDC_CLIENT_ID,
      d.OIDC_CLIENT_SECRET,
      d.OIDC_REDIRECT_URI,
    ];
    const setCount = oidcVars.filter((v) => v !== undefined && v !== '').length;
    return setCount === 0 || setCount === 4;
  },
  {
    message: 'OIDC_* must all be set together, or none at all',
    path: ['OIDC_ISSUER_URL'],
  },
).refine(
  (d) => !d.OIDC_ISSUER_URL || !!d.SESSION_COOKIE_SECRET,
  {
    message: 'SESSION_COOKIE_SECRET is required when OIDC is enabled',
    path: ['SESSION_COOKIE_SECRET'],
  },
);

/**
 * Inferred configuration type from schema
 */
export type Config = z.infer<typeof configSchema>;

// Cache for lazy-loaded config
let _config: Config | undefined;

/**
 * Parse and validate environment variables
 * Fails fast with exit code 78 on configuration errors
 */
export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `  - ${path}: ${issue.message}`;
    });

    // Only log and exit if we're not in a test environment
    // In tests, throw an error so it can be caught
    if (process.env.NODE_ENV === 'test') {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    console.error('Configuration validation failed:');
    console.error(errors.join('\n'));
    process.exit(ExitCodes.EX_CONFIG);
  }

  return result.data;
}

/**
 * Validated configuration object (lazy-loaded)
 * Call loadConfig() first in production to validate at startup
 * In tests, set env vars before accessing this
 */
export const config: Config = new Proxy({} as Config, {
  get(_, prop: string | symbol) {
    if (_config === undefined) {
      _config = loadConfig();
    }
    return _config[prop as keyof Config];
  },
});

/**
 * Reset the cached config (useful for testing)
 */
export function resetConfig(): void {
  _config = undefined;
}

/**
 * Phase 30 Plan 08 — derive the effective server origin for surfaces that
 * embed an absolute URL (currently the device-flow verification URI shown
 * to the CLI user, and the absolute redirect for the unauthenticated /auth
 * /device → /auth/login bounce).
 *
 * Rules:
 *   - When `OIDC_REDIRECT_URI` is set and parses, return `new URL(it).origin`
 *     (scheme + host + port; no trailing slash, no path).
 *   - Otherwise, fall back to `http://localhost:${PORT}` so a PAT-only
 *     deployment without OIDC still has a valid (if non-routable) origin
 *     for logs and the disabled-stub responses.
 *
 * This is a pure function of the env shape — no side effects, no Proxy
 * touch — so unit tests can pass a plain object literal without needing
 * the full Zod-validated config.
 *
 * Note on the empty-string case: a malformed/empty OIDC_REDIRECT_URI is
 * treated as "absent" rather than throwing. The Zod schema's `.url()`
 * refinement would have rejected the value at boot time if production
 * config was malformed; this helper is defensive for tests that pass a
 * partial env object.
 */
export function effectiveOrigin(env: {
  OIDC_REDIRECT_URI?: string;
  PORT: number;
}): string {
  if (env.OIDC_REDIRECT_URI && env.OIDC_REDIRECT_URI.length > 0) {
    try {
      return new URL(env.OIDC_REDIRECT_URI).origin;
    } catch {
      // Fall through to localhost fallback for malformed inputs (defense
      // in depth — Zod already validates production config).
    }
  }
  return `http://localhost:${env.PORT}`;
}

/**
 * A parsed API key entry: raw key plus a human-readable label for audit logs.
 *
 * Labels are operator-supplied or fingerprint-derived. They are intended to
 * appear in per-request log lines so operators can attribute calls to a
 * specific machine/agent without exposing the raw key. The raw `key` field
 * must NEVER be logged.
 */
export interface ApiKeyEntry {
  /** Raw key string (compared against the supplied X-API-Key). */
  key: string;
  /**
   * Human-readable label for audit logs. Either operator-supplied
   * (`key:label` syntax) or auto-derived as `key_<first8>` for bare keys.
   */
  label: string;
}

/**
 * Parse an `API_KEYS` string into a list of `{ key, label }` entries.
 *
 * Format:
 * - `API_KEYS=abc123,def456,ghi789` — bare keys, label auto-derived.
 * - `API_KEYS=abc123:label-a,def456:label-b` — explicit labels.
 * - Mixed: `API_KEYS=abc123,def456:ci-bot` — both forms in one list.
 *
 * Rules:
 * - Whitespace around keys and labels is trimmed.
 * - Empty entries (e.g. trailing comma) are dropped.
 * - A key MUST NOT be empty. If the `key:` part is empty, the entry is
 *   rejected with a thrown Error so config validation fails fast.
 * - Only ONE `:` is permitted per entry — additional `:` characters cause the
 *   entry to be rejected. (Both labels and keys should be plain text; embedded
 *   `:` is almost always a typo or attempt to smuggle structure.)
 * - Bare-key entries get an auto-label of `key_<first8>` where first8 is the
 *   first 8 characters of the raw key. Short keys (<8 chars) use the entire
 *   key in the suffix.
 * - Duplicate labels are PERMITTED (operators may genuinely have two agents
 *   on the same machine sharing a label) — but the parser exposes the full
 *   list so callers that care can detect them.
 * - An empty label after `:` is rejected ("key:" with no label is ambiguous —
 *   operator likely intended either a bare key or forgot the label).
 *
 * This is the single source of truth for the API_KEYS format. The auth
 * plugin consumes the output directly via `parseApiKeyEntries`.
 */
export function parseApiKeyEntries(raw: string | undefined): ApiKeyEntry[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const entries: ApiKeyEntry[] = [];
  const rawParts = raw.split(',');

  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i].trim();
    if (part.length === 0) {
      // Empty segment from trailing/double comma — silently skip.
      continue;
    }

    const colonCount = (part.match(/:/g) ?? []).length;

    if (colonCount === 0) {
      // Bare key. Auto-derive label from first 8 characters.
      const suffix = part.slice(0, 8);
      entries.push({ key: part, label: `key_${suffix}` });
      continue;
    }

    if (colonCount > 1) {
      throw new Error(
        `API_KEYS entry #${i + 1} contains multiple ':' separators. ` +
          `Use exactly one ':' between key and label, e.g. "abc123:ci-bot".`,
      );
    }

    // Exactly one ':' — split into key and label.
    const sepIdx = part.indexOf(':');
    const keyPart = part.slice(0, sepIdx).trim();
    const labelPart = part.slice(sepIdx + 1).trim();

    if (keyPart.length === 0) {
      throw new Error(
        `API_KEYS entry #${i + 1} has an empty key before ':'. ` +
          `Format must be "key:label" with a non-empty key.`,
      );
    }
    if (labelPart.length === 0) {
      throw new Error(
        `API_KEYS entry #${i + 1} has an empty label after ':'. ` +
          `Use a bare key (no ':') or supply a non-empty label, e.g. "abc123:ci-bot".`,
      );
    }

    entries.push({ key: keyPart, label: labelPart });
  }

  return entries;
}
