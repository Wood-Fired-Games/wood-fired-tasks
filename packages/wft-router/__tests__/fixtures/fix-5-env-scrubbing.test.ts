import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ENV_ALLOWLIST,
  buildChildEnv,
  shellExec,
} from '../../src/handlers/shell-exec.js';
import type { HandlerContext } from '../../src/handlers/index.js';
import { createFixtureStore, silentLogger, taskEvent, type FixtureStore } from './harness.js';

describe('fix-5 / env-scrubbing', () => {
  let fx: FixtureStore;
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, ORIGINAL);
    fx?.dispose();
  });

  // fix-5 / env-scrubbing: a `shell_exec` rule is fired with one `token_env`
  // set; the child process sees its own token but NOT any other rule's
  // `*_token_env`, NOT `WFT_API_KEY`.
  it('the spawned child sees its own token_env but not foreign tokens or WFT_API_KEY', async () => {
    fx = createFixtureStore();
    process.env.RULE_A_TOKEN_ENV = 'a-secret';
    process.env.RULE_B_TOKEN_ENV = 'b-secret';
    process.env.WFT_API_KEY = 'master-key';

    // The child exits 0 ONLY when: its own token is visible AND the foreign
    // token AND WFT_API_KEY are both absent. stdout is ignored by the handler,
    // so the exit code is the observable scrub proof.
    const probe =
      'process.exit(' +
      "process.env.RULE_A_TOKEN_ENV === 'a-secret' && " +
      'process.env.RULE_B_TOKEN_ENV === undefined && ' +
      'process.env.WFT_API_KEY === undefined ? 0 : 1)';

    const ctx: HandlerContext = {
      store: fx.store,
      logger: silentLogger(),
      identity: {
        rule_name: 'rule-a',
        event_id: 'evt-scrub-1',
        task_id: 1,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      },
      event: taskEvent('evt-scrub-1', 'task.status_changed', { id: 1, status: 'done' }),
      withBlock: { command: process.execPath, argv: ['-e', probe] },
      tokenEnv: 'RULE_A_TOKEN_ENV',
    };

    const outcome = await shellExec(ctx);
    // Exit 0 → child env was scrubbed exactly as required.
    expect(outcome.kind).toBe('succeeded');

    // Pure-function cross-check: only the rule's own token survives; no foreign
    // *_token_env and no WFT_API_KEY leak through. (The default allowlist never
    // includes secrets.)
    const env = buildChildEnv(undefined, 'RULE_A_TOKEN_ENV', process.env);
    expect(env.RULE_A_TOKEN_ENV).toBe('a-secret');
    expect(env.RULE_B_TOKEN_ENV).toBeUndefined();
    expect(env.WFT_API_KEY).toBeUndefined();
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain('WFT_API_KEY');
  });
});
