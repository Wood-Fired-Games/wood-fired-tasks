/**
 * Pino logger with secret redaction for the event router (task #427).
 *
 * Two complementary redaction surfaces protect operator-visible logs:
 *
 *   1. KEY-NAME redaction — `util/redaction.ts::SENSITIVE_KEY_RE` deep-walks
 *      arbitrary payloads and replaces ANY object key whose name matches a
 *      known credential-bearing name (token, secret, password, api*key,
 *      authorization, cookie). This path is used for rendered handler
 *      payloads BEFORE they reach a log surface.
 *
 *   2. PATH redaction (THIS FILE) — pino's native `redact.paths` runs at
 *      serialization time. Path-based redaction is the only thing that can
 *      hit specific positions in a structured record (e.g. `headers.cookie`
 *      nested at a fixed shape), and it is faster than deep-walk because
 *      pino fast-paths known positions during JSON emission.
 *
 * IMPORT-VS-DUPLICATE DECISION: pino's redact API takes literal path strings,
 * NOT a key-name regex — there is no way to feed `SENSITIVE_KEY_RE` straight
 * into pino. The path list below is therefore a hand-maintained mirror of the
 * SAME canonical names covered by `SENSITIVE_KEY_RE`. The two lists MUST stay
 * in lockstep; redaction.test.ts pins the regex, logger.test.ts pins the path
 * list, and any future addition to one MUST be matched in the other.
 *
 * The path set covers each canonical name at:
 *   - TOP LEVEL                  (`token`, `secret`, ...)
 *   - WILDCARD ONE-LEVEL NEST    (`*.token`, ...)
 *   - WILDCARD ANY-DEPTH NEST    (`*.*.token`, ...) for two-level shapes
 *   - HTTP HEADER CARRIERS       (`headers.authorization`, `headers.cookie`,
 *                                 `headers["x-api-key"]`, plus a `req.headers.*`
 *                                 form for sources that wrap headers in a
 *                                 Fastify-style request envelope)
 *
 * Vendor-neutrality: this file is part of the wft-router standalone package
 * and MUST NOT reference any AI provider, chat platform, CI vendor, or
 * proprietary tool name (see docs/event-router-design.md
 * §Vendor-neutral guardrails §1, §2, §9). The router is a generic event-bus
 * fan-out; concrete sink identities belong to the rule-yaml that operators
 * write, never to the source tree.
 */

import { pino, type Logger } from 'pino';

/**
 * Canonical credential-bearing key names, kept in lockstep with the
 * `SENSITIVE_KEY_RE` regex in `util/redaction.ts`. If you add a name here,
 * update the regex AND its tests, and vice versa.
 */
const SENSITIVE_NAMES = [
  'token',
  'secret',
  'password',
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
] as const;

/**
 * Build the pino `redact.paths` list. Each canonical name is registered at
 * the top level, one-level wildcard, and two-level wildcard so a sensitive
 * field anywhere in a moderately nested rule payload still gets censored
 * during serialization.
 */
function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const name of SENSITIVE_NAMES) {
    paths.push(name);
    paths.push(`*.${name}`);
    paths.push(`*.*.${name}`);
    paths.push(`*.*.*.${name}`);
  }
  // The `x-api-key` HTTP header is dash-delimited and cannot use dot syntax
  // anywhere it appears; pino requires the bracket form for keys that contain
  // a dash. Cover the common header-bag shapes seen in event payloads.
  paths.push('["x-api-key"]');
  paths.push('*["x-api-key"]');
  paths.push('*.*["x-api-key"]');
  paths.push('headers["x-api-key"]');
  paths.push('req.headers["x-api-key"]');
  // Explicit HTTP-header path carriers (also covered by the wildcards above,
  // but listing them keeps pino's redact fast-path optimal for the common
  // shape and makes test assertions self-documenting).
  paths.push('headers.authorization');
  paths.push('headers.cookie');
  paths.push('req.headers.authorization');
  paths.push('req.headers.cookie');
  return paths;
}

/**
 * Pino redact configuration applied to every logger and inherited by every
 * child logger created via `createRuleLogger`. Exported so tests can pin the
 * exact path set without instantiating a logger.
 *
 * The `censor` literal matches the convention used by the host server's own
 * LOGGER_REDACT_CONFIG (see `src/api/server.ts`) so operators reading either
 * surface see the same marker. The two configs are intentionally separate
 * constants because they cover different request shapes — the server has a
 * Fastify `req` envelope; the router has rule-level payloads — and coupling
 * them would force one surface to carry paths it never sees.
 */
export const LOGGER_REDACT_CONFIG = {
  paths: buildRedactPaths(),
  censor: '[REDACTED]',
} as const;

let cachedLogger: Logger | undefined;

/**
 * Read the desired log level from the environment, defaulting to `info`.
 * Pino validates the level string at construction time and throws on an
 * unknown value — we leave that strictness in place so a typo in operator
 * config fails loudly rather than silently dropping log output.
 */
function resolveLevel(): string {
  const raw = process.env.LOG_LEVEL;
  return raw && raw.length > 0 ? raw : 'info';
}

/**
 * Return the root pino logger. The instance is constructed lazily on first
 * call and cached for the lifetime of the process. The cache is keyed on the
 * module instance — tests that need a fresh logger must re-import the module
 * via vitest's module isolation (each test file gets its own module graph by
 * default).
 */
export function getLogger(): Logger {
  if (cachedLogger === undefined) {
    cachedLogger = pino({
      name: 'wft-router',
      level: resolveLevel(),
      redact: {
        paths: [...LOGGER_REDACT_CONFIG.paths],
        censor: LOGGER_REDACT_CONFIG.censor,
      },
    });
  }
  return cachedLogger;
}

/**
 * Create a child logger bound to a specific rule id. The child INHERITS the
 * root redaction config — pino propagates `redact` through `child()` without
 * extra wiring — so any sensitive key written through the child is censored
 * the same way as the root.
 *
 * The `rule_id` binding is snake_case for parity with the rest of the
 * router's structured-log vocabulary (see dispatch state machine fields like
 * `rule_id`, `dispatch_id`).
 */
export function createRuleLogger(ruleId: string): Logger {
  return getLogger().child({ rule_id: ruleId });
}
