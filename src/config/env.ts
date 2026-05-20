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
  HOST: z.string().min(1).default('0.0.0.0'),
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
}).refine(
  (d) => (!d.SLACK_BOT_TOKEN && !d.SLACK_APP_TOKEN) || (!!d.SLACK_BOT_TOKEN && !!d.SLACK_APP_TOKEN),
  {
    message: 'Both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together, or neither should be set',
    path: ['SLACK_APP_TOKEN'],
  }
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
