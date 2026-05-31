import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { pino } from 'pino';

import { LOGGER_REDACT_CONFIG } from '../../src/logging/logger.js';
import { redactForLogging } from '../../src/util/redaction.js';
import { silentLogger } from './harness.js';

// fix-9 / secret-redaction: a rule whose headers carry an authorization bearer
// token shows the censored marker — never the cleartext secret — on every log
// surface. Two complementary seams enforce this: the value-path deep redaction
// applied before logging, and pino's serialization-time path redaction.

/** Capture pino's serialized output into an in-memory buffer (no stdout). */
function captureSink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

describe('fix-9 / secret-redaction', () => {
  it('censors an authorization header via the production pino redact config', () => {
    // The harness silent logger stands in for surfaces a fixture does not want
    // to assert on; here we assert on a capture-stream pino built from the REAL
    // exported redact config (same paths/censor the daemon's logger uses).
    void silentLogger;
    const sink = captureSink();
    const logger = pino(
      { redact: { paths: [...LOGGER_REDACT_CONFIG.paths], censor: LOGGER_REDACT_CONFIG.censor } },
      sink.stream,
    );

    const secret = 'Bearer xyz-super-secret-token';
    logger.info({ headers: { authorization: secret, cookie: 'session=leak' } }, 'dispatching webhook');

    const out = sink.text();
    // The cleartext secret never appears on the log surface.
    expect(out).not.toContain('xyz-super-secret-token');
    expect(out).not.toContain('session=leak');
    // The censor marker stands in for both credential-bearing headers.
    expect(out).toContain(LOGGER_REDACT_CONFIG.censor);
    const record = JSON.parse(out.trim().split('\n')[0]);
    expect(record.headers.authorization).toBe(LOGGER_REDACT_CONFIG.censor);
    expect(record.headers.cookie).toBe(LOGGER_REDACT_CONFIG.censor);
  });

  it('deep-redacts a nested authorization value before it reaches any log call', () => {
    // The value-path seam handlers apply to a rendered payload prior to logging.
    const redacted = redactForLogging({
      rule: { with: { headers: { authorization: 'Bearer top-secret' } } },
      token: 'tok-leak',
    });
    expect(JSON.stringify(redacted)).not.toContain('top-secret');
    expect(JSON.stringify(redacted)).not.toContain('tok-leak');
    expect(redacted.rule.with.headers.authorization).toBe('***');
    expect(redacted.token).toBe('***');
  });
});
