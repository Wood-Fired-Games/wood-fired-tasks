/**
 * REAL-p4d integration suite for {@link PerforceBackend} (task #1563).
 *
 * Every other perforce test in this package (`perforce.test.ts`) mocks
 * `ExecScmFn` — no real `p4` server is involved. This file is the opposite:
 * it boots an actual, dockerized Helix Core server
 * (`src/scm/__tests__/helpers/p4d-docker.ts`) and drives the REAL adapter
 * (`new PerforceBackend()`, i.e. the production `execScm` exec path) against
 * it, over real child processes.
 *
 * ## Skip semantics (read before touching the gate below)
 *
 * `describe.skipIf(!process.env.WFG_TESTS_REAL_P4 || !dockerAvailable() || !p4Available())`
 * governs the whole file:
 *
 * - `WFG_TESTS_REAL_P4` unset → **skip silently**. This is the default —
 *   `npm test` never needs Docker or a `p4` binary.
 * - `WFG_TESTS_REAL_P4` set but `docker` is not on `PATH` → **skip
 *   silently**. Same for a missing `p4` client binary (the adapter spawns
 *   `p4` directly; without it on `PATH` there is nothing to drive).
 * - `WFG_TESTS_REAL_P4` set AND both binaries are present → the suite runs
 *   for real. If the container then fails to boot (image pull failure,
 *   readiness timeout, login failure), `beforeAll` lets that rejection
 *   propagate and the suite **FAILS LOUDLY** rather than skipping — the
 *   operator explicitly asked for the real suite by setting the flag, so a
 *   broken environment is a real failure to report, not something to hide
 *   behind a skip.
 *
 * Two independent, ALWAYS-ON (never gated) unit tests at the bottom of this
 * file exercise the `dockerAvailable()`/`p4Available()` detectors directly
 * with an injected "binary not on PATH" environment, proving the skip
 * mechanism this header describes actually works — without needing an
 * environment that lacks Docker to prove it.
 *
 * Run for real: `WFG_TESTS_REAL_P4=1 npx vitest run src/scm/__tests__/perforce-real-p4d.test.ts`
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerforceBackend } from '../perforce.js';
import { ScmError, type ScmVerbContext } from '../types.js';
import {
  createWorkspace,
  dockerAvailable,
  p4Available,
  p4Env,
  rawP4,
  bootP4d,
  stopP4d,
  type P4dServer,
  type P4Workspace,
} from './helpers/p4d-docker.js';

/** Write `.tasks/scm.json` for `repo`, publish toggle only — everything else stays at perforce defaults. */
function writeScmConfig(repo: string, publish: boolean): void {
  mkdirSync(join(repo, '.tasks'), { recursive: true });
  writeFileSync(
    join(repo, '.tasks', 'scm.json'),
    JSON.stringify({ version: 1, backend: 'perforce', behaviors: { publish } }, null, 2),
    'utf8',
  );
}

const explicitlyRequested = Boolean(process.env.WFG_TESTS_REAL_P4);
const canRun = explicitlyRequested && dockerAvailable() && p4Available();

describe.skipIf(!canRun)(
  'PerforceBackend against a real dockerized p4d (WFG_TESTS_REAL_P4)',
  () => {
    let server: P4dServer;
    let savedEnv: Record<string, string | undefined>;
    const tempDirs: string[] = [];

    function makeTempDir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    }

    /** Point the ADAPTER's exec calls (execScm inherits process.env, §6.1) at `server` as `workspace`. */
    function pointAdapterAt(workspace: P4Workspace): void {
      Object.assign(process.env, p4Env(server, workspace));
    }

    beforeAll(async () => {
      server = await bootP4d();
      savedEnv = {
        P4PORT: process.env.P4PORT,
        P4USER: process.env.P4USER,
        P4CLIENT: process.env.P4CLIENT,
        P4TICKETS: process.env.P4TICKETS,
        PWD: process.env.PWD,
      };
    }, 90_000);

    afterAll(() => {
      for (const [key, value] of Object.entries(savedEnv ?? {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        if (server) stopP4d(server);
      } finally {
        while (tempDirs.length > 0) {
          const dir = tempDirs.pop();
          if (dir) rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('record(publish=OFF) shelves with the pending CL as changeId; record+publish(ON) submits and RENUMBERS', async () => {
      const root = makeTempDir('scm-p4d-real-');
      const ws = createWorkspace(server, 'wft-real-client-a', root);
      pointAdapterAt(ws);
      const backend = new PerforceBackend();

      // --- baseline (§4.1) --------------------------------------------------
      const ctx: ScmVerbContext = { repo: root, context: 'shelve-ctx' };
      writeScmConfig(root, false);
      const baseline = await backend.baseline(ctx);
      expect(baseline.id).toMatch(/^p4:\d+$/);

      // --- stage + record with publish OFF → shelve path ---------------------
      writeFileSync(join(root, 'shelved.txt'), 'shelved content\n', 'utf8');
      const staged = await backend.stage(ctx, ['shelved.txt']);
      expect(staged.staged).toEqual(['shelved.txt']);

      const shelveRecord = await backend.record(ctx, 'shelve this');
      expect(shelveRecord).toMatchObject({ recorded: true, mode: 'shelve' });
      expect(shelveRecord.changeId).toMatch(/^p4:\d+$/);
      const shelvedCl = shelveRecord.changeId;

      // The shelved (unpublished) pending CL IS the durable id for this
      // context — unlike the publish-on path below, there is no submit to
      // renumber it.
      const shelveCtxId = await backend.changeId(ctx);
      expect(shelveCtxId.ids).toEqual([shelvedCl]);

      // --- publish stays OFF for this context → no-op -------------------------
      const noopPublish = await backend.publish(ctx);
      expect(noopPublish).toEqual({ published: false, changeId: null });

      // --- fresh context, publish ON: stage + record defers, then publish submits+RENUMBERS ---
      writeScmConfig(root, true);
      const publishCtx: ScmVerbContext = { repo: root, context: 'publish-ctx' };
      writeFileSync(join(root, 'published.txt'), 'published content\n', 'utf8');
      await backend.stage(publishCtx, ['published.txt']);

      const record = await backend.record(publishCtx, 'submit this');
      expect(record).toMatchObject({ recorded: true, changeId: null, mode: 'submit' });

      // Pending CL captured BEFORE submit (§4.2: a pending CL is never quoted
      // as evidence in a publish-on run — this is exactly the value that must
      // differ from the post-submit id).
      const pending = await backend.changeId(publishCtx);
      expect(pending.ids).toHaveLength(1);
      const pendingCl = pending.ids[0];
      expect(pendingCl).toMatch(/^p4:\d+$/);

      // Force a real renumber: create an unrelated pending changelist on the
      // SAME client between record() and publish() (task-proven: perforce
      // renumbers a submit when a higher-numbered changelist already exists —
      // "Change N renamed change M and submitted."). This simulates ordinary
      // concurrent activity against the depot; it does not touch `publishCtx`'s
      // own changelist or files.
      const env = { ...process.env, ...p4Env(server, ws) };
      const bumpForm = rawP4(['--field', 'Description=bump the counter', 'change', '-o'], {
        cwd: root,
        env,
      });
      expect(bumpForm.status).toBe(0);
      const bumpCreate = rawP4(['change', '-i'], { cwd: root, env, input: bumpForm.stdout });
      expect(bumpCreate.status).toBe(0);

      const published = await backend.publish(publishCtx);
      expect(published.published).toBe(true);
      expect(published.changeId).toMatch(/^p4:\d+$/);
      // The renumber assertion (AC): the durable published id is NEVER the
      // pending CL captured pre-submit.
      expect(published.changeId).not.toBe(pendingCl);

      // --- changed-files / status / reset-hard sanity over the post-submit state ---
      const changed = await backend.changedFiles(publishCtx, pendingCl ?? '');
      expect(changed.files).toEqual([]); // submitted — nothing left opened in this CL

      const status = await backend.status(publishCtx);
      expect(typeof status.dirty).toBe('boolean');

      const reset = await backend.resetHard(publishCtx, published.changeId ?? '');
      expect(reset).toEqual({ reset: true });
    }, 120_000);

    it('publish() retries sync + resolve -as exactly once, then throws SUBMIT_CONFLICT when a second client submitted underneath', async () => {
      const rootA = makeTempDir('scm-p4d-real-conflict-a-');
      const rootB = makeTempDir('scm-p4d-real-conflict-b-');
      const wsA = createWorkspace(server, 'wft-real-client-conflict-a', rootA);
      const wsB = createWorkspace(server, 'wft-real-client-conflict-b', rootB);
      const envA = { ...process.env, ...p4Env(server, wsA) };
      const envB = { ...process.env, ...p4Env(server, wsB) };

      // Seed baseline content via client A, raw (test setup, not adapter behavior).
      writeFileSync(join(rootA, 'conflict.txt'), 'line1\nline2\nline3\n', 'utf8');
      expect(rawP4(['add', 'conflict.txt'], { cwd: rootA, env: envA }).status).toBe(0);
      expect(rawP4(['submit', '-d', 'baseline'], { cwd: rootA, env: envA }).status).toBe(0);

      // Client A, through the REAL adapter: stage + record an overlapping edit
      // (commit+publish on → record() defers the actual submit to publish()).
      pointAdapterAt(wsA);
      writeScmConfig(rootA, true);
      const backend = new PerforceBackend();
      const ctx: ScmVerbContext = { repo: rootA, context: 'conflict-ctx' };
      writeFileSync(join(rootA, 'conflict.txt'), 'line1-EDITED-BY-A\nline2\nline3\n', 'utf8');
      await backend.stage(ctx, ['conflict.txt']);
      await backend.record(ctx, 'client A edit');

      // Client B submits underneath, raw, on the SAME line — a genuine content
      // conflict `resolve -as` (accept-safe / automatic-only) cannot merge away.
      expect(rawP4(['sync'], { cwd: rootB, env: envB }).status).toBe(0);
      expect(rawP4(['edit', 'conflict.txt'], { cwd: rootB, env: envB }).status).toBe(0);
      writeFileSync(join(rootB, 'conflict.txt'), 'line1-EDITED-BY-B\nline2\nline3\n', 'utf8');
      expect(
        rawP4(['submit', '-d', 'client B submits underneath'], { cwd: rootB, env: envB }).status,
      ).toBe(0);

      // publish() must: attempt submit (fails, out of date) → sync + resolve -as
      // (leaves the genuine conflict unresolved) → retry submit once (still
      // fails) → throw SUBMIT_CONFLICT. Never a second retry, never -at/-ay.
      let caught: unknown;
      try {
        await backend.publish(ctx);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ScmError);
      expect((caught as ScmError).code).toBe('SUBMIT_CONFLICT');
    }, 120_000);
  },
);

// ---------------------------------------------------------------------------
// Always-on (never gated): proves the skip mechanism itself, without needing
// an environment that actually lacks Docker/p4 to prove it.
// ---------------------------------------------------------------------------

describe('p4d-docker helper detectors (always run — no Docker/p4 required)', () => {
  it('dockerAvailable() is false when docker is not on PATH', () => {
    expect(dockerAvailable({ PATH: '/nonexistent-bin-dir-for-wft-scm-tests' })).toBe(false);
  });

  it('p4Available() is false when p4 is not on PATH', () => {
    expect(p4Available({ PATH: '/nonexistent-bin-dir-for-wft-scm-tests' })).toBe(false);
  });

  it('dockerAvailable() reflects the real PATH in this process without throwing', () => {
    expect(typeof dockerAvailable()).toBe('boolean');
  });
});
