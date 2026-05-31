/**
 * Barrel re-export for the logging subsystem (task #427).
 *
 * Downstream modules should import from `../logging/index.js` rather than
 * reaching into `logger.js` directly so the public surface stays narrow and
 * future refactors (e.g. splitting `redact` config into its own file) don't
 * ripple through every call site.
 */

export {
  LOGGER_REDACT_CONFIG,
  createRuleLogger,
  getLogger,
} from './logger.js';
