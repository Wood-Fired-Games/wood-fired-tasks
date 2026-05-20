import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { App, ExpressReceiver } from '@slack/bolt';

/**
 * Regression test: Slack request-signing verification.
 *
 * Source: reports/open-source-audit-2026-05-20/tests.md MEDIUM #2 (task 205).
 *
 * Today src/services/slack.service.ts uses Socket Mode, which does not perform
 * HTTP-level signature verification (Slack opens the WebSocket from its side
 * with the bot/app token). If anyone switches to an HTTP-based receiver
 * (ExpressReceiver/HTTPReceiver/AwsLambdaReceiver) — which is the only safe
 * way to receive slash commands without Socket Mode — they MUST configure a
 * signing secret and let Bolt verify every inbound request.
 *
 * This test stands up a real ExpressReceiver-backed Bolt App in-process,
 * registers the /tasks slash command handler with a sentinel spy, and then:
 *
 *   1. POSTs a slash-command payload with a deliberately WRONG X-Slack-Signature
 *      and asserts the request is rejected with 401 before the spy fires.
 *   2. POSTs the same payload with a CORRECT HMAC computed from the configured
 *      signing secret and asserts the spy IS invoked.
 *
 * If a future change weakens or bypasses Bolt's signature verification
 * (e.g. `signatureVerification: false`, a hand-rolled receiver that skips
 * `verifySignatureAndParseRawBody`, or a misrouted endpoint), this test will
 * fail because case #1 will reach the spy or case #2 will be rejected.
 */

const SIGNING_SECRET = 'test-signing-secret-do-not-use-in-prod';
const SLASH_COMMAND_ENDPOINT = '/slack/events';

/**
 * Build the form-encoded body Slack would send for `/tasks list`.
 * Slack signs the raw request body, so the exact string matters.
 */
function buildSlashCommandBody(): string {
  const params = new URLSearchParams({
    token: 'verification-token-deprecated',
    team_id: 'T123',
    team_domain: 'wood-fired',
    channel_id: 'C123',
    channel_name: 'general',
    user_id: 'U0123ABC',
    user_name: 'testuser',
    command: '/tasks',
    text: 'list',
    response_url: 'https://hooks.slack.com/commands/T123/456/abc',
    trigger_id: 'trigger.123',
    api_app_id: 'A123',
  });
  return params.toString();
}

/**
 * Compute the v0 signature Slack would attach to a given body + timestamp.
 * Mirrors verify-request.js: hmac-sha256(`v0:${ts}:${body}`, signingSecret).
 */
function computeSignature(body: string, timestampSec: number, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`v0:${timestampSec}:${body}`);
  return `v0=${hmac.digest('hex')}`;
}

describe('Slack request-signing verification (HTTP receiver)', () => {
  let receiver: ExpressReceiver;
  let app: App;
  let server: Server;
  let baseUrl: string;
  /** Spy fired only if Bolt routes the verified request into the /tasks handler. */
  const handlerSpy = vi.fn(async () => {});

  beforeAll(async () => {
    // Silence the Bolt console logger so a deliberate 401 doesn't spam test output.
    const silentLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      getLevel: vi.fn().mockReturnValue('error'),
      setName: vi.fn(),
    };

    receiver = new ExpressReceiver({
      signingSecret: SIGNING_SECRET,
      endpoints: SLASH_COMMAND_ENDPOINT,
      processBeforeResponse: true,
      // biome-ignore lint/suspicious/noExplicitAny: minimal logger shim for test silence
      logger: silentLogger as any,
    });

    app = new App({
      receiver,
      // Use authorize() instead of token to bypass Bolt's auth.test call to
      // api.slack.com. We don't need a real bot identity — we only need to
      // assert that signature verification fires BEFORE handler dispatch.
      authorize: async () => ({
        botToken: 'xoxb-test',
        botId: 'B0TEST',
        botUserId: 'U0TEST',
      }),
      tokenVerificationEnabled: false,
    });

    // Register the same command name tasks-command.ts uses. The spy stands in
    // for the real handler — we only care THAT it's reached, not what it does.
    app.command('/tasks', async ({ ack }) => {
      await ack();
      await handlerSpy();
    });

    // Bind the receiver's express app to an ephemeral port.
    server = receiver.app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects requests with a WRONG signature with 401 and never invokes the handler', async () => {
    handlerSpy.mockClear();
    const body = buildSlashCommandBody();
    const timestamp = Math.floor(Date.now() / 1000);
    // Deliberately compute the HMAC with a DIFFERENT secret so the v0 hash
    // is well-formed but does not match what the receiver computes.
    const wrongSignature = computeSignature(body, timestamp, 'wrong-secret');

    const res = await fetch(`${baseUrl}${SLASH_COMMAND_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': wrongSignature,
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    // The spy must NEVER fire when verification fails — that's the regression.
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('rejects requests with a missing signature header without invoking the handler', async () => {
    handlerSpy.mockClear();
    const body = buildSlashCommandBody();
    const timestamp = Math.floor(Date.now() / 1000);

    const res = await fetch(`${baseUrl}${SLASH_COMMAND_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(timestamp),
        // x-slack-signature intentionally omitted
      },
      body,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('accepts requests with a CORRECT signature and invokes the /tasks handler', async () => {
    handlerSpy.mockClear();
    const body = buildSlashCommandBody();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(body, timestamp, SIGNING_SECRET);

    const res = await fetch(`${baseUrl}${SLASH_COMMAND_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});
