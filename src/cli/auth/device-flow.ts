/**
 * Phase 30 Plan 06 Task 2 — Device-flow pure functions.
 *
 * Pure, dependency-injected so login.ts's subprocess test can drive the loop
 * deterministically. No console I/O, no process exit — the caller (login.ts)
 * does that based on the PollResult shape.
 *
 * Design choices:
 *   - `requestDeviceCode` sends JSON because the server's /auth/device/code
 *     endpoint accepts JSON only (the body schema is z.object, not form).
 *   - `pollForToken` sends form-encoded bodies to /auth/device/token because
 *     RFC 8628 §3.4 specifies application/x-www-form-urlencoded as the
 *     canonical request shape; the server (Plan 30-01) accepts both, but the
 *     form variant is more interoperable with off-the-shelf OAuth tooling.
 *   - Both expiresIn and initialInterval are clamped on the CLI side. The
 *     server's published `expires_in=600` and `interval=5` are advisory; a
 *     compromised or buggy server cannot force the CLI to spin tighter than
 *     1s or hold an open session longer than 15 minutes.
 *   - `slow_down` mutation is ADDITIVE (+5), not multiplicative, per RFC
 *     8628 §3.5. Test 6 enforces this invariant.
 */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  token: string;
  token_type: 'PAT';
  token_id: number;
  user: {
    id: number;
    displayName: string;
    email: string | null;
    isLegacy: boolean;
    isServiceAccount: boolean;
  };
}

export type DeviceTokenError =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'invalid_client'
  | 'invalid_request'
  | 'unsupported_grant_type';

export interface RequestDeviceCodeArgs {
  baseUrl: string;
  clientId: string;
  hostname: string;
  tokenName?: string;
  fetchImpl?: typeof fetch;
}

export async function requestDeviceCode(args: RequestDeviceCodeArgs): Promise<DeviceCodeResponse> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    client_id: args.clientId,
    hostname: args.hostname,
  };
  if (args.tokenName !== undefined) body.token_name = args.tokenName;

  const res = await fetchImpl(`${args.baseUrl}/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status !== 200) {
    const bodyText = await safeBodyText(res);
    throw new Error(`Failed to start device flow: ${res.status} ${bodyText.slice(0, 200)}`);
  }

  return (await res.json()) as DeviceCodeResponse;
}

export interface PollOptions {
  baseUrl: string;
  deviceCode: string;
  clientId: string;
  initialInterval: number;
  expiresIn: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  /** Fires on every transient state (pending or slow_down) for --json
   *  envelope emission and text-mode progress dots. */
  onEvent?: (e: { kind: 'pending' | 'slow_down'; interval: number }) => void;
}

export type PollResult =
  | { kind: 'ok'; response: DeviceTokenSuccess }
  | {
      kind: 'terminal_error';
      error: DeviceTokenError | 'timeout' | 'network';
      message: string;
    };

/** 15 minutes — Phase 30 CLI-01 success criterion + T-30-06-04 mitigation. */
const MAX_EXPIRES_IN_S = 900;

/** Defensive minimum poll interval — even if the server says interval=1, we
 *  treat 1s as the floor. (RFC 8628 §3.5 says clients SHOULD honor server's
 *  interval; we go one further and never go below 1s.) */
const MIN_INTERVAL_S = 1;

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const TERMINAL_ERROR_MESSAGES: Record<
  Exclude<DeviceTokenError, 'authorization_pending' | 'slow_down'>,
  string
> = {
  expired_token: 'Login link expired. Run `tasks login` again.',
  access_denied: 'Sign-in was denied. Run `tasks login` again to retry.',
  invalid_client: "Server rejected the CLI's client_id. Contact your administrator.",
  invalid_request: 'Server rejected the request.',
  unsupported_grant_type: 'Server does not support this device flow.',
};

const TIMEOUT_MESSAGE = 'Login timed out after 15 minutes.';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function safeBodyJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function pollForToken(opts: PollOptions): Promise<PollResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const nowImpl = opts.nowImpl ?? (() => Date.now());

  let interval = Math.max(MIN_INTERVAL_S, opts.initialInterval);
  const expiresIn = Math.min(MAX_EXPIRES_IN_S, opts.expiresIn);
  const deadline = nowImpl() + expiresIn * 1000;

  // Poll loop. Each iteration: deadline check → sleep(interval) → POST → dispatch.
  // The sleep happens BEFORE the POST so the first request gives the user
  // time to complete the browser approval (matches the device-flow UX
  // expectation that the CLI is "waiting").
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (nowImpl() >= deadline) {
      return { kind: 'terminal_error', error: 'timeout', message: TIMEOUT_MESSAGE };
    }

    await sleepImpl(interval * 1000);

    const form = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT,
      device_code: opts.deviceCode,
      client_id: opts.clientId,
    });

    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        kind: 'terminal_error',
        error: 'network',
        message: `Could not reach ${opts.baseUrl}: ${detail}`,
      };
    }

    if (res.status === 200) {
      const ok = (await res.json()) as DeviceTokenSuccess;
      return { kind: 'ok', response: ok };
    }

    // Non-200 — parse the RFC 8628 error envelope.
    const body = await safeBodyJson(res);
    const error = typeof body?.error === 'string' ? (body.error as string) : null;

    if (error === 'authorization_pending') {
      opts.onEvent?.({ kind: 'pending', interval });
      continue;
    }
    if (error === 'slow_down') {
      interval += 5;
      opts.onEvent?.({ kind: 'slow_down', interval });
      continue;
    }
    if (
      error === 'expired_token' ||
      error === 'access_denied' ||
      error === 'invalid_client' ||
      error === 'invalid_request' ||
      error === 'unsupported_grant_type'
    ) {
      return {
        kind: 'terminal_error',
        error,
        message: TERMINAL_ERROR_MESSAGES[error],
      };
    }

    // Unknown shape — surface as a generic network/server error and stop.
    const snippet = error ?? `status ${res.status}`;
    return {
      kind: 'terminal_error',
      error: 'network',
      message: `Server returned ${res.status}: ${snippet}`,
    };
  }
}
