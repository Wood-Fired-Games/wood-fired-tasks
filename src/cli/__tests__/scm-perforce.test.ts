/**
 * Perforce SCM CLI-envelope coverage (task #1542) — proves the three AC cases
 * (§4.2 collapse, §4.2 renumber capture, §4.3 submit-conflict policy) at the
 * **wire-envelope** boundary rather than only against the backend's raw return
 * data. Each case constructs the §4.1 {@link ScmSuccessEnvelope} the CLI would
 * print from the `PerforceBackend` return value and asserts on the
 * `envelope.data.changeId` / `change-id` `ids` `p4:<cl>` values.
 *
 * The `tasks scm` CLI command (task #1536) is a CONCURRENT sibling not present
 * in this base tree, so these tests drive {@link PerforceBackend} directly with
 * an injected mock exec (no real p4 server, no real p4 binary) and build the
 * envelope locally — mirroring the CLI's success-path wrapping.
 *
 * Complementary (not duplicative) to `src/scm/__tests__/perforce.test.ts`:
 * that file asserts on backend return shapes; this file adds the envelope
 * projection plus edge cases it does not cover — publish-off shelve durability
 * across a follow-up `change-id`, a non-renumbering ("partial") submit whose
 * final CL equals the pending CL, and two concurrent `--context`s carrying
 * independent numbered changelists to distinct `p4:<cl>` envelopes.
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * §4.1–§4.3.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecScmResult } from '../../scm/exec.js';
import { PerforceBackend } from '../../scm/perforce.js';
import {
  ScmError,
  type ScmSuccessEnvelope,
  type ScmVerb,
  type ScmVerbContext,
  type ScmVerbDataMap,
} from '../../scm/types.js';

// ---------------------------------------------------------------------------
// Mock p4 exec layer — no real p4 server / binary (task constraint).
// ---------------------------------------------------------------------------

/** Build an ExecScmResult with sensible defaults (exit 0, empty output). */
function result(over: Partial<ExecScmResult> = {}): ExecScmResult {
  return {
    binary: 'p4',
    args: [],
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...over,
  };
}

interface Rule {
  match: (args: readonly string[]) => boolean;
  reply: (args: readonly string[]) => Partial<ExecScmResult>;
}

/**
 * Router-style mock exec: each call is matched against `rules` in order; the
 * first matching rule's `reply` merges onto a zero-exit default. Every argv is
 * recorded so tests can assert the exact p4 commands invoked.
 */
function mockExec(rules: Rule[]) {
  const calls: string[][] = [];
  const exec = async (_binary: string, args: readonly string[]): Promise<ExecScmResult> => {
    calls.push([...args]);
    for (const rule of rules) {
      if (rule.match(args)) return result({ args, ...rule.reply(args) });
    }
    return result({ args });
  };
  return { exec, calls };
}

/** True when `argv` starts with `verb` tokens, ignoring leading `--field X` global-option pairs. */
function isVerb(args: readonly string[], ...verb: string[]): boolean {
  const positional = args.filter((a, i) => {
    if (a === '--field') return false;
    if (i > 0 && args[i - 1] === '--field') return false;
    return true;
  });
  return verb.every((tok, i) => positional[i] === tok);
}

const OK_LOGIN: Rule = { match: (a) => isVerb(a, 'login', '-s'), reply: () => ({ code: 0 }) };

/**
 * Project a backend return value into the §4.1 success envelope the CLI would
 * print. This is exactly the shape asserted below — the AC requires the
 * `p4:<cl>` claim to survive the envelope wrapping, not just the raw return.
 */
function successEnvelope<V extends ScmVerb>(
  verb: V,
  ctx: ScmVerbContext,
  data: ScmVerbDataMap[V],
): ScmSuccessEnvelope<V> {
  return { ok: true, verb, backend: 'perforce', context: ctx.context, data, warnings: [] };
}

const repos: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-p4-cli-'));
  repos.push(dir);
  return dir;
}
function ctxFor(repo: string, context = 'task-1542'): ScmVerbContext {
  return { repo, context };
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC 1 — collapse: record+publish is ONE submit / ONE CL, and the envelope
//        carries the single final p4:<cl>.
// ---------------------------------------------------------------------------

describe('scm perforce envelope — §4.2 collapse (single changelist)', () => {
  it('stage→record→publish collapses to exactly ONE submit / ONE CL and the publish envelope carries that single p4:<cl>', async () => {
    const { exec, calls } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 900 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({ stdout: '//depot/x#1 - edit' }) },
      {
        match: (a) => isVerb(a, 'submit'),
        reply: () => ({ stdout: 'Change 900 renamed change 901 and submitted.' }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['src/x.ts']);
    const rec = await backend.record(ctx, 'task #1542: collapse');
    // commit on + publish on → record defers the submit; no durable id yet.
    expect(rec).toMatchObject({ recorded: true, changeId: null, mode: 'submit' });

    const pubData = await backend.publish(ctx);
    const envelope = successEnvelope('publish', ctx, pubData);

    // The whole record+publish act collapsed to a SINGLE submit against a SINGLE CL.
    expect(calls.filter((c) => isVerb(c, 'submit'))).toHaveLength(1);
    // Non-interactive form fields live on the `change -o` capture (task #1555)
    // — `change -i` just reads that captured form from stdin, no `--field`.
    const createdCls = calls.filter(
      (c) =>
        isVerb(c, 'change', '-o') &&
        c.some((t) => t.startsWith('Description=')) &&
        !c.some((t) => t.startsWith('Change=')),
    );
    expect(createdCls).toHaveLength(1);

    // Envelope-level assertion on the single final p4:<cl>.
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('publish');
    expect(envelope.backend).toBe('perforce');
    expect(envelope.data.published).toBe(true);
    expect(envelope.data.changeId).toBe('p4:901');
  });
});

// ---------------------------------------------------------------------------
// AC 2 — renumber capture: pending 123 → final p4:456 on the envelope, and the
//        follow-up change-id envelope reports the POST-renumber CL. Also covers
//        the additive "partial"/non-renumbering submit where final == pending.
// ---------------------------------------------------------------------------

describe('scm perforce envelope — §4.2 renumber capture', () => {
  it('captures the renumbered CL: pending 123 submits as p4:456 on both the publish and change-id envelopes', async () => {
    const { exec } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 123 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      {
        match: (a) => isVerb(a, 'submit'),
        reply: () => ({ stdout: 'Change 123 renamed change 456 and submitted.' }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['f.txt']);
    await backend.record(ctx, 'renumber');
    const pubEnvelope = successEnvelope('publish', ctx, await backend.publish(ctx));

    // The pending CL (123) is NEVER quoted; the FINAL renumbered CL is the id.
    expect(pubEnvelope.data.changeId).toBe('p4:456');
    expect(pubEnvelope.data.changeId).not.toBe('p4:123');

    // change-id envelope now reflects the post-renumber CL as evidence.
    const idEnvelope = successEnvelope('change-id', ctx, await backend.changeId(ctx));
    expect(idEnvelope.data.ids).toContain('p4:456');
    expect(idEnvelope.data.ids).not.toContain('p4:123');
  });

  it('a non-renumbering (partial) submit reports the pending CL unchanged as p4:<cl>', async () => {
    // A submit whose output has no "renamed change N" clause → final == pending.
    const { exec } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 777 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      { match: (a) => isVerb(a, 'submit'), reply: () => ({ stdout: 'Change 777 submitted.' }) },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['g.txt']);
    await backend.record(ctx, 'no-renumber');
    const pubEnvelope = successEnvelope('publish', ctx, await backend.publish(ctx));

    expect(pubEnvelope.data.changeId).toBe('p4:777');
    const idEnvelope = successEnvelope('change-id', ctx, await backend.changeId(ctx));
    expect(idEnvelope.data.ids).toEqual(['p4:777']);
  });

  it('publish-off keeps a durable shelved p4:<cl>: the record envelope id survives an intervening change-id with no renumber and no submit', async () => {
    const repo = makeRepo();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '.tasks'), { recursive: true });
    writeFileSync(
      join(repo, '.tasks', 'scm.json'),
      JSON.stringify({ version: 1, backend: 'perforce', behaviors: { publish: false } }),
    );

    const { exec, calls } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 250 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      { match: (a) => isVerb(a, 'shelve'), reply: () => ({ stdout: 'Change 250 files shelved.' }) },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(repo);

    await backend.stage(ctx, ['a.txt']);
    const recEnvelope = successEnvelope('record', ctx, await backend.record(ctx, 'wip'));
    expect(recEnvelope.data.changeId).toBe('p4:250');
    expect(recEnvelope.data.mode).toBe('shelve');

    // publish off → no-op publish, never submits; the shelved CL is durable.
    const pubEnvelope = successEnvelope('publish', ctx, await backend.publish(ctx));
    expect(pubEnvelope.data).toEqual({ published: false, changeId: null });
    expect(calls.some((c) => isVerb(c, 'submit'))).toBe(false);

    // change-id still reports the same durable p4:250 — a shelve never renumbers.
    const idEnvelope = successEnvelope('change-id', ctx, await backend.changeId(ctx));
    expect(idEnvelope.data.ids).toEqual(['p4:250']);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — submit-conflict policy (§4.3): sync + resolve -as + retry ONCE. On
//        retry success the envelope carries the renumbered p4:<cl>; on a
//        remaining conflict, ScmError SUBMIT_CONFLICT with no -at/-ay/revert.
// ---------------------------------------------------------------------------

describe('scm perforce envelope — §4.3 submit-conflict policy', () => {
  /** Rules where the FIRST submit conflicts and the SECOND returns `secondSubmit`. */
  function conflictThenSubmit(secondSubmit: Partial<ExecScmResult>): Rule[] {
    let submitCount = 0;
    return [
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 400 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      { match: (a) => isVerb(a, 'sync'), reply: () => ({ code: 0 }) },
      { match: (a) => isVerb(a, 'resolve', '-as'), reply: () => ({ code: 0 }) },
      {
        match: (a) => isVerb(a, 'submit'),
        reply: () => {
          submitCount += 1;
          if (submitCount === 1) {
            return {
              code: 1,
              stderr:
                'Submit failed -- fix problems then use p4 submit -c 400.\nout of date files must be resolved.',
            };
          }
          return secondSubmit;
        },
      },
    ];
  }

  it('retry-success: after sync + resolve -as the second submit lands and the publish envelope carries the renumbered p4:<cl>', async () => {
    const { exec, calls } = mockExec(
      conflictThenSubmit({ code: 0, stdout: 'Change 400 renamed change 618 and submitted.' }),
    );
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['f.txt']);
    await backend.record(ctx, 'conflict-then-ok');
    const pubEnvelope = successEnvelope('publish', ctx, await backend.publish(ctx));

    // Envelope carries the final renumbered CL from the retried submit.
    expect(pubEnvelope.data).toEqual({ published: true, changeId: 'p4:618' });

    // change-id envelope agrees post-renumber.
    const idEnvelope = successEnvelope('change-id', ctx, await backend.changeId(ctx));
    expect(idEnvelope.data.ids).toEqual(['p4:618']);

    // §4.3 remediation ran: sync, then resolve -as, then exactly one retry submit.
    expect(calls.some((c) => isVerb(c, 'sync'))).toBe(true);
    expect(calls.some((c) => isVerb(c, 'resolve', '-as'))).toBe(true);
    expect(calls.filter((c) => isVerb(c, 'submit'))).toHaveLength(2);
    // NEVER accept-theirs / accept-yours; NEVER revert.
    expect(calls.some((c) => c.includes('-at') || c.includes('-ay'))).toBe(false);
    expect(calls.some((c) => isVerb(c, 'revert'))).toBe(false);
  });

  it('remaining-conflict: a still-conflicting retry throws ScmError SUBMIT_CONFLICT naming the numbered CL, with no -at/-ay and no revert', async () => {
    const { exec, calls } = mockExec(
      conflictThenSubmit({ code: 1, stderr: 'out of date files must be resolved.' }),
    );
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['f.txt']);
    await backend.record(ctx, 'conflict-then-conflict');

    const err = await backend.publish(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScmError);
    const scmErr = err as ScmError;
    expect(scmErr.code).toBe('SUBMIT_CONFLICT');
    // Files remain opened in the numbered CL — the id is reported so nothing is orphaned.
    expect(scmErr.message).toContain('400');

    // Retried exactly once (two submits), never -at/-ay, never reverted.
    expect(calls.filter((c) => isVerb(c, 'submit'))).toHaveLength(2);
    expect(calls.some((c) => c.includes('-at') || c.includes('-ay'))).toBe(false);
    expect(calls.some((c) => isVerb(c, 'revert'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additive — concurrent --contexts carry independent numbered CLs to distinct
//            p4:<cl> envelopes (no cross-contamination of the default CL, §4.3).
// ---------------------------------------------------------------------------

describe('scm perforce envelope — concurrent contexts (§4.3 numbered CLs)', () => {
  it('two contexts submit into their OWN changelists and surface distinct p4:<cl> envelopes', async () => {
    // Deterministic per-context CL numbering: alpha → 500/560, beta → 600/660.
    let created = 0;
    const { exec, calls } = mockExec([
      OK_LOGIN,
      {
        match: (a) => isVerb(a, 'change', '-i'),
        reply: () => {
          created += 1;
          const cl = created === 1 ? 500 : 600;
          return { stdout: `Change ${cl} created.` };
        },
      },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      {
        match: (a) => isVerb(a, 'submit'),
        reply: (a) => {
          // The submit's -c <cl> tells us which context's CL is landing.
          const idx = a.indexOf('-c');
          const cl = idx >= 0 ? a[idx + 1] : undefined;
          const finalCl = cl === '500' ? 560 : 660;
          return { stdout: `Change ${cl} renamed change ${finalCl} and submitted.` };
        },
      },
    ]);
    const backend = new PerforceBackend(exec);
    const repo = makeRepo();
    const alpha = ctxFor(repo, 'ctx-alpha');
    const beta = ctxFor(repo, 'ctx-beta');

    await backend.stage(alpha, ['alpha.txt']);
    await backend.record(alpha, 'a');
    await backend.stage(beta, ['beta.txt']);
    await backend.record(beta, 'b');

    const alphaEnvelope = successEnvelope('publish', alpha, await backend.publish(alpha));
    const betaEnvelope = successEnvelope('publish', beta, await backend.publish(beta));

    expect(alphaEnvelope.context).toBe('ctx-alpha');
    expect(alphaEnvelope.data.changeId).toBe('p4:560');
    expect(betaEnvelope.context).toBe('ctx-beta');
    expect(betaEnvelope.data.changeId).toBe('p4:660');
    expect(alphaEnvelope.data.changeId).not.toBe(betaEnvelope.data.changeId);

    // Two distinct numbered CLs were created — one per context, not the default
    // CL. Non-interactive form fields live on the `change -o` capture (task
    // #1555) — `change -i` just reads that captured form from stdin.
    const createdCls = calls.filter(
      (c) =>
        isVerb(c, 'change', '-o') &&
        c.some((t) => t.startsWith('Description=')) &&
        !c.some((t) => t.startsWith('Change=')),
    );
    expect(createdCls).toHaveLength(2);
  });
});
