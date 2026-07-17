import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecScmOptions, ExecScmResult } from '../exec.js';
import { PerforceBackend, isSubmitConflict, parseSubmittedChange } from '../perforce.js';
import { ScmError, type ScmVerbContext } from '../types.js';

// ---------------------------------------------------------------------------
// Mock p4 exec layer — no real p4 server is available (task constraint).
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
 * A router-style mock exec: each call is matched against `rules` in order; the
 * first matching rule's `reply` is merged onto a zero-exit default. Every call's
 * argv is recorded so tests can assert the exact p4 commands invoked. `optsCalls`
 * parallels `calls` (same index) so tests can also assert on the exec options —
 * notably `stdinData`, the change -o | change -i piping vehicle (task #1555).
 */
function mockExec(rules: Rule[]) {
  const calls: string[][] = [];
  const optsCalls: ExecScmOptions[] = [];
  const exec = async (
    _binary: string,
    args: readonly string[],
    opts: ExecScmOptions = { cwd: '' },
  ): Promise<ExecScmResult> => {
    calls.push([...args]);
    optsCalls.push(opts);
    for (const rule of rules) {
      if (rule.match(args)) return result({ args, ...rule.reply(args) });
    }
    return result({ args });
  };
  return { exec, calls, optsCalls };
}

/** True when `argv` starts with the given verb tokens (ignoring leading `--field` global opts). */
function isVerb(args: readonly string[], ...verb: string[]): boolean {
  const positional = args.filter((a, i) => {
    // Drop `--field X` global-option pairs so `p4 --field ... change -i` matches `change`.
    if (a === '--field') return false;
    if (i > 0 && args[i - 1] === '--field') return false;
    return true;
  });
  return verb.every((tok, i) => positional[i] === tok);
}

const OK_LOGIN: Rule = { match: (a) => isVerb(a, 'login', '-s'), reply: () => ({ code: 0 }) };

const repos: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-p4-'));
  repos.push(dir);
  return dir;
}
function ctxFor(repo: string, context = 'task-1541'): ScmVerbContext {
  return { repo, context };
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure parsing helpers
// ---------------------------------------------------------------------------

describe('perforce — renumber parsing (§4.2)', () => {
  it('captures the renamed (final) CL from a renumbering submit', () => {
    expect(parseSubmittedChange('Change 123 renamed change 456 and submitted.')).toBe(456);
  });

  it('captures the CL from a non-renumbering submit', () => {
    expect(parseSubmittedChange('Change 789 submitted.')).toBe(789);
  });

  it('flags an out-of-date submit as a conflict but a clean submit as not', () => {
    expect(
      isSubmitConflict(
        result({ code: 1, stderr: 'Some file(s) could not be transferred: out of date' }),
      ),
    ).toBe(true);
    expect(
      isSubmitConflict(result({ code: 1, stderr: 'must resolve //depot/f#4 before submitting' })),
    ).toBe(true);
    expect(isSubmitConflict(result({ code: 0, stdout: 'Change 5 submitted.' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC: implements every ScmBackend verb
// ---------------------------------------------------------------------------

describe('PerforceBackend — ScmBackend surface', () => {
  it('implements every ScmBackend verb with name "perforce"', () => {
    const backend = new PerforceBackend(mockExec([]).exec);
    expect(backend.name).toBe('perforce');
    for (const verb of [
      'detect',
      'baseline',
      'status',
      'changedFiles',
      'stage',
      'record',
      'changeId',
      'publish',
      'openReview',
      'isolate',
      'teardownIsolation',
      'resetHard',
    ] as const) {
      expect(typeof (backend as unknown as Record<string, unknown>)[verb]).toBe('function');
    }
  });

  it('preflight maps a not-logged-in session to AUTH_EXPIRED (exit 3)', async () => {
    const { exec } = mockExec([
      {
        match: (a) => isVerb(a, 'login', '-s'),
        reply: () => ({ code: 1, stderr: 'Your session has expired, please login again.' }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    await expect(backend.baseline(ctxFor(makeRepo()))).rejects.toMatchObject({
      name: 'ScmError',
      code: 'AUTH_EXPIRED',
    });
  });

  it('preflight maps an unreachable server to BACKEND_UNAVAILABLE (exit 3)', async () => {
    const { exec } = mockExec([
      {
        match: (a) => isVerb(a, 'login', '-s'),
        reply: () => ({
          code: 1,
          stderr: 'Perforce client error:\nConnect to server failed; check $P4PORT.',
        }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    await expect(backend.status(ctxFor(makeRepo()))).rejects.toMatchObject({
      name: 'ScmError',
      code: 'BACKEND_UNAVAILABLE',
    });
  });

  it('detect reports perforce + serialized isolation when no client template is configured', async () => {
    const prev = process.env['P4CLIENT_TEMPLATE'];
    delete process.env['P4CLIENT_TEMPLATE'];
    try {
      const backend = new PerforceBackend(mockExec([OK_LOGIN]).exec);
      const data = await backend.detect(ctxFor(makeRepo()));
      expect(data.backend).toBe('perforce');
      expect(data.capabilities.isolation).toBe('serialized');
      expect(data.behaviors.commit).toBe(true);
      expect(data.behaviors.publish).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['P4CLIENT_TEMPLATE'];
      else process.env['P4CLIENT_TEMPLATE'] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// AC: collapse yields a single CL; submit captures the renumbered CL as p4:<cl>
// ---------------------------------------------------------------------------

describe('PerforceBackend — §4.2 collapse + renumber capture', () => {
  it('stage→record→publish collapses to a SINGLE changelist and captures the renumbered CL', async () => {
    const { exec, calls } = mockExec([
      OK_LOGIN,
      // Lazy CL creation on first stage → pending CL 123 (change -o | change -i).
      { match: (a) => isVerb(a, 'change', '-o'), reply: () => ({ stdout: 'Change: new\n' }) },
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 123 created.' }) },
      {
        match: (a) => isVerb(a, 'reconcile'),
        reply: () => ({ stdout: '//depot/f.txt#1 - opened for edit' }),
      },
      // Submit renumbers 123 → 456.
      {
        match: (a) => isVerb(a, 'submit'),
        reply: () => ({ stdout: 'Change 123 renamed change 456 and submitted.' }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    const staged = await backend.stage(ctx, ['src/f.txt']);
    expect(staged.staged).toEqual(['src/f.txt']);

    // commit on + publish on → record defers the submit (mode "submit"), no durable id yet.
    const rec = await backend.record(ctx, 'task #1541: work');
    expect(rec).toMatchObject({ recorded: true, changeId: null, mode: 'submit' });

    const pub = await backend.publish(ctx);
    expect(pub).toEqual({ published: true, changeId: 'p4:456' });

    // Exactly one submit ran (single act — commit=submit=publish collapsed).
    const submits = calls.filter((c) => isVerb(c, 'submit'));
    expect(submits).toHaveLength(1);

    // Only ONE numbered changelist was ever created (the pending CL, submitted
    // once) — the creating `change -o` form-read carries the Description
    // field and no Change field (fields live on `-o` now, not `-i`, task #1555).
    const created = calls.filter(
      (c) =>
        isVerb(c, 'change', '-o') &&
        c.some((t) => t.startsWith('Description=')) &&
        !c.some((t) => t.startsWith('Change=')),
    );
    expect(created).toHaveLength(1);

    // change-id now reflects the POST-renumber CL (evidence is the final CL).
    const ids = await backend.changeId(ctx);
    expect(ids.ids).toEqual(['p4:456']);
  });

  it('records a shelved (unpublished) CL when publish is off — durable pending CL id, no renumber', async () => {
    const repo = makeRepo();
    // publish off, commit on via .tasks/scm.json.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '.tasks'), { recursive: true });
    writeFileSync(
      join(repo, '.tasks', 'scm.json'),
      JSON.stringify({ version: 1, backend: 'perforce', behaviors: { publish: false } }),
    );

    const { exec, calls } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 200 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
      { match: (a) => isVerb(a, 'shelve'), reply: () => ({ stdout: 'Change 200 files shelved.' }) },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(repo);

    await backend.stage(ctx, ['a.txt']);
    const rec = await backend.record(ctx, 'wip');
    expect(rec).toEqual({ recorded: true, changeId: 'p4:200', mode: 'shelve' });

    // publish is off → publish() is a no-op and NEVER submits.
    const pub = await backend.publish(ctx);
    expect(pub).toEqual({ published: false, changeId: null });
    expect(calls.some((c) => isVerb(c, 'submit'))).toBe(false);
  });

  it('record is a no-op when commit is off (reconcile-only)', async () => {
    const repo = makeRepo();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '.tasks'), { recursive: true });
    writeFileSync(
      join(repo, '.tasks', 'scm.json'),
      JSON.stringify({ version: 1, backend: 'perforce', behaviors: { commit: false } }),
    );
    const backend = new PerforceBackend(mockExec([OK_LOGIN]).exec);
    const rec = await backend.record(ctxFor(repo), 'ignored');
    expect(rec).toEqual({ recorded: false, changeId: null, mode: 'noop' });
  });
});

// ---------------------------------------------------------------------------
// AC (task #1555): non-interactive changelist forms via `change -o` captured,
// piped to `change -i` — `p4 change -i` reads its form from STDIN, and
// `--field` only rewrites the OUTPUT of a form command (`change -o`), so a
// bare `--field … change -i` against stdin pinned to 'ignore' cannot work
// against a real server. Both form-writing helpers must go through
// `change -o` (capturing stdout) then `change -i` fed that capture via the
// §6.1 exec wrapper's `stdinData` option.
// ---------------------------------------------------------------------------

describe('PerforceBackend — non-interactive changelist forms (task #1555)', () => {
  it('ensureContextChangelist issues `p4 change -o` then `p4 change -i` with the captured form on stdin', async () => {
    const form = 'Change:\tnew\n\nDescription:\n\twft-scm context task-1541\n';
    const { exec, calls, optsCalls } = mockExec([
      OK_LOGIN,
      {
        match: (a) =>
          isVerb(a, 'change', '-o') && a.includes('Description=wft-scm context task-1541'),
        reply: () => ({ stdout: form }),
      },
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 123 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    const staged = await backend.stage(ctx, ['a.txt']);
    expect(staged.staged).toEqual(['a.txt']);

    const withOpts = calls.map((args, i) => ({ args, opts: optsCalls[i] }));

    // Exactly two `change` invocations: the `-o` form read, then the `-i` write.
    const formRead = withOpts.find((c) => isVerb(c.args, 'change', '-o'));
    const formWrite = withOpts.find((c) => isVerb(c.args, 'change', '-i'));
    expect(formRead).toBeDefined();
    expect(formWrite).toBeDefined();

    // `-o` carries the `--field Description=…` global option that pre-fills the form.
    expect(formRead?.args).toEqual([
      '--field',
      'Description=wft-scm context task-1541',
      'change',
      '-o',
    ]);
    // `-i` carries NO `--field` args — it just reads the form from stdin.
    expect(formWrite?.args).toEqual(['change', '-i']);
    // The exact captured `-o` stdout is what got piped to `-i` on stdin.
    expect(formWrite?.opts.stdinData).toBe(form);
  });

  it('setChangelistDescription issues `p4 change -o` (scoped to the CL) then `p4 change -i` with the captured form on stdin', async () => {
    const createForm = 'Change:\tnew\n\nDescription:\n\twft-scm context task-1541\n';
    const updateForm = 'Change:\t123\n\nDescription:\n\ttask #1541: work\n';
    const { exec, calls, optsCalls } = mockExec([
      OK_LOGIN,
      {
        match: (a) => isVerb(a, 'change', '-o') && a.includes('Change=123'),
        reply: () => ({ stdout: updateForm }),
      },
      { match: (a) => isVerb(a, 'change', '-o'), reply: () => ({ stdout: createForm }) },
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 123 created.' }) },
      { match: (a) => isVerb(a, 'reconcile'), reply: () => ({}) },
    ]);
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['a.txt']);
    const rec = await backend.record(ctx, 'task #1541: work');
    expect(rec).toMatchObject({ recorded: true, mode: 'submit' });

    const changeOCalls = calls
      .map((args, i) => ({ args, opts: optsCalls[i] }))
      .filter((c) => isVerb(c.args, 'change', '-o'));
    const changeICalls = calls
      .map((args, i) => ({ args, opts: optsCalls[i] }))
      .filter((c) => isVerb(c.args, 'change', '-i'));

    // Two `-o`/`-i` pairs ran: one to create the CL (ensureContextChangelist),
    // one to set its description (setChangelistDescription) — both via the
    // same form-capture-then-pipe path.
    expect(changeOCalls).toHaveLength(2);
    expect(changeICalls).toHaveLength(2);

    const descriptionUpdate = changeOCalls.find((c) => c.args.includes('Change=123'));
    expect(descriptionUpdate?.args).toEqual([
      '--field',
      'Change=123',
      '--field',
      'Description=task #1541: work',
      'change',
      '-o',
    ]);

    // The `-i` call following the description-update `-o` carries NO `--field`
    // args and received exactly that `-o` call's captured stdout on stdin.
    const updateWrite = changeICalls[1];
    expect(updateWrite?.args).toEqual(['change', '-i']);
    expect(updateWrite?.opts.stdinData).toBe(updateForm);
  });
});

// ---------------------------------------------------------------------------
// AC: submit-conflict path applies the §4.3 policy
// ---------------------------------------------------------------------------

describe('PerforceBackend — §4.3 submit-conflict policy', () => {
  function conflictThenSubmitRules(secondSubmit: Partial<ExecScmResult>): Rule[] {
    let submitCount = 0;
    return [
      OK_LOGIN,
      { match: (a) => isVerb(a, 'change', '-i'), reply: () => ({ stdout: 'Change 300 created.' }) },
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
                'Submit failed -- fix problems then use p4 submit -c 300.\nout of date files must be resolved or reverted.',
            };
          }
          return secondSubmit;
        },
      },
    ];
  }

  it('on conflict: runs sync + resolve -as (accept-safe), retries submit ONCE, then succeeds with renumbered CL', async () => {
    const { exec, calls } = mockExec(
      conflictThenSubmitRules({ code: 0, stdout: 'Change 300 renamed change 512 and submitted.' }),
    );
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['f.txt']);
    await backend.record(ctx, 'm');
    const pub = await backend.publish(ctx);
    expect(pub).toEqual({ published: true, changeId: 'p4:512' });

    // §4.3 remediation ran in order: sync, then resolve -as, then a 2nd submit.
    const order = calls.map((c) => c.filter((t) => t !== '--field' && !t.includes('=')).join(' '));
    expect(order.some((c) => c.startsWith('sync'))).toBe(true);
    expect(order.some((c) => c === 'resolve -as')).toBe(true);
    expect(calls.filter((c) => isVerb(c, 'submit'))).toHaveLength(2);
    // NEVER accept-theirs / accept-yours.
    expect(calls.some((c) => c.includes('-at') || c.includes('-ay'))).toBe(false);
  });

  it('on a remaining conflict after the single retry: throws SUBMIT_CONFLICT and leaves files opened (no revert)', async () => {
    const { exec, calls } = mockExec(
      conflictThenSubmitRules({
        code: 1,
        stderr: 'out of date files must be resolved or reverted.',
      }),
    );
    const backend = new PerforceBackend(exec);
    const ctx = ctxFor(makeRepo());

    await backend.stage(ctx, ['f.txt']);
    await backend.record(ctx, 'm');

    await expect(backend.publish(ctx)).rejects.toMatchObject({
      name: 'ScmError',
      code: 'SUBMIT_CONFLICT',
    });

    // Retried exactly once (two submits total), never reverted the conflicted CL.
    expect(calls.filter((c) => isVerb(c, 'submit'))).toHaveLength(2);
    expect(calls.some((c) => isVerb(c, 'revert'))).toBe(false);
    expect(calls.some((c) => c.includes('-at') || c.includes('-ay'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exclusion invariant (§4.4) — stage rejects, changed-files filters
// ---------------------------------------------------------------------------

describe('PerforceBackend — §4.4 exclusion invariant', () => {
  it('stage REJECTS an excluded path (CONFIG_INVALID) before opening anything', async () => {
    const { exec, calls } = mockExec([OK_LOGIN]);
    const backend = new PerforceBackend(exec);
    await expect(backend.stage(ctxFor(makeRepo()), ['LOOP-RUN.md'])).rejects.toMatchObject({
      name: 'ScmError',
      code: 'CONFIG_INVALID',
    });
    // No reconcile ran — the whole call was rejected.
    expect(calls.some((c) => isVerb(c, 'reconcile'))).toBe(false);
  });

  it('changed-files silently filters excluded paths', async () => {
    const { exec } = mockExec([
      OK_LOGIN,
      {
        match: (a) => isVerb(a, 'opened'),
        reply: () => ({
          stdout: [
            'src/keep.ts#2 - edit change 7 (text)',
            'bin/tool#1 - add change 7 (binary)',
            '.gitignore#3 - edit change 7 (text)',
          ].join('\n'),
        }),
      },
    ]);
    const backend = new PerforceBackend(exec);
    const data = await backend.changedFiles(ctxFor(makeRepo()), 'p4:6');
    expect(data.files.map((f) => f.path)).toEqual(['src/keep.ts']);
    expect(data.files[0]?.change).toBe('modified');
  });
});

// ---------------------------------------------------------------------------
// reset-hard (§4 table) — p4 revert -a + p4 sync @<cl>
// ---------------------------------------------------------------------------

describe('PerforceBackend — reset-hard', () => {
  it('reverts then syncs to the requested CL, stripping the p4: prefix', async () => {
    const { exec, calls } = mockExec([
      OK_LOGIN,
      { match: (a) => isVerb(a, 'revert', '-a'), reply: () => ({ code: 0 }) },
      { match: (a) => isVerb(a, 'sync'), reply: () => ({ code: 0 }) },
    ]);
    const backend = new PerforceBackend(exec);
    const data = await backend.resetHard(ctxFor(makeRepo()), 'p4:88');
    expect(data).toEqual({ reset: true });
    expect(calls.some((c) => isVerb(c, 'revert', '-a'))).toBe(true);
    expect(calls.some((c) => c[0] === 'sync' && c[1] === '@88')).toBe(true);
  });
});
