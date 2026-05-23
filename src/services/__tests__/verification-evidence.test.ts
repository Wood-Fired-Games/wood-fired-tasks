import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import type { App } from '../../index.js';
import { ValidationError } from '../errors.js';

/**
 * Wave 1.4 (task #312) — service-layer coverage for the verification_evidence
 * lifecycle and the auto-NOT_VERIFIED materialization on a closing transition.
 *
 * Verifies:
 *  - Patching evidence via updateTask round-trips deeply.
 *  - status → 'done' WITHOUT explicit evidence and WITHOUT prior evidence
 *    auto-materializes {verdict: 'NOT_VERIFIED'} — no other fields.
 *  - status → 'closed' (the other closing transition) has the same behavior.
 *  - Existing evidence is preserved across a close transition when no patch
 *    is supplied — we do not clobber a real PASS/FAIL.
 *  - Non-closing transitions (in_progress, blocked, backlogged) do NOT
 *    materialize anything.
 *  - Unknown verdicts are rejected with ValidationError (the "unknown verdict
 *    → 400" boundary contract).
 *  - Closing a task with an explicit verification_evidence in the patch uses
 *    the patch (no auto-fill).
 */
describe('TaskService — verification_evidence (#312)', () => {
  let app: App;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectId = app.projectService.createProject({ name: 'wave-1-4' }).id;
  });

  afterEach(() => {
    app.dispose();
  });

  function newTask(): number {
    return app.taskService.createTask({
      title: 't',
      project_id: projectId,
      created_by: 'tester',
    }).id;
  }

  it('updateTask round-trips a full evidence object verbatim', () => {
    const id = newTask();
    const evidence = {
      verdict: 'PASS' as const,
      checks: [
        { name: 'unit', status: 'PASS' as const, evidence_url_or_text: 'green' },
        { name: 'lint', status: 'SKIP' as const, evidence_url_or_text: 'n/a' },
      ],
      verifier_session_id: 'sess-1',
      verifier_request_id: 'req-1',
      verified_at: '2026-05-23T12:00:00.000Z',
    };

    const updated = app.taskService.updateTask(id, {
      verification_evidence: evidence,
    });

    expect(updated.verification_evidence).toEqual(evidence);

    // Re-fetch confirms persistence + parse-on-read.
    const fetched = app.taskService.getTask(id);
    expect(fetched.verification_evidence).toEqual(evidence);
  });

  it('status -> done without explicit evidence auto-materializes NOT_VERIFIED', () => {
    const id = newTask();
    // Transition open -> in_progress -> done to land on a valid path.
    app.taskService.updateTask(id, { status: 'in_progress' });
    const closed = app.taskService.updateTask(id, { status: 'done' });

    expect(closed.verification_evidence).toEqual({ verdict: 'NOT_VERIFIED' });
    // Defensive: no other fields fabricated (especially no verified_at).
    expect(Object.keys(closed.verification_evidence ?? {})).toEqual(['verdict']);
  });

  it('status -> closed without explicit evidence also auto-materializes NOT_VERIFIED', () => {
    const id = newTask();
    // open -> closed is in VALID_STATUS_TRANSITIONS.
    const closed = app.taskService.updateTask(id, { status: 'closed' });

    expect(closed.verification_evidence).toEqual({ verdict: 'NOT_VERIFIED' });
  });

  it('existing evidence is preserved across a close transition with no patch', () => {
    const id = newTask();
    app.taskService.updateTask(id, {
      verification_evidence: {
        verdict: 'PASS',
        verifier_session_id: 'real-verifier',
      },
    });
    app.taskService.updateTask(id, { status: 'in_progress' });
    const closed = app.taskService.updateTask(id, { status: 'done' });

    // The PASS verdict survives — auto-NOT_VERIFIED only fires when evidence
    // is currently NULL.
    expect(closed.verification_evidence?.verdict).toBe('PASS');
    expect(closed.verification_evidence?.verifier_session_id).toBe('real-verifier');
  });

  it('non-closing transitions do NOT materialize evidence', () => {
    const id = newTask();

    // open -> in_progress
    const inProgress = app.taskService.updateTask(id, { status: 'in_progress' });
    expect(inProgress.verification_evidence).toBeNull();

    // in_progress -> blocked
    const blocked = app.taskService.updateTask(id, { status: 'blocked' });
    expect(blocked.verification_evidence).toBeNull();

    // blocked -> open
    const reopened = app.taskService.updateTask(id, { status: 'open' });
    expect(reopened.verification_evidence).toBeNull();

    // open -> backlogged
    const backlogged = app.taskService.updateTask(id, { status: 'backlogged' });
    expect(backlogged.verification_evidence).toBeNull();
  });

  it('closing with explicit verification_evidence uses the supplied object (no auto-fill)', () => {
    const id = newTask();
    app.taskService.updateTask(id, { status: 'in_progress' });
    const closed = app.taskService.updateTask(id, {
      status: 'done',
      verification_evidence: { verdict: 'FAIL' },
    });

    expect(closed.verification_evidence).toEqual({ verdict: 'FAIL' });
  });

  it('closing with explicit null clears whatever was there (no auto-fill)', () => {
    const id = newTask();
    app.taskService.updateTask(id, {
      verification_evidence: { verdict: 'PASS' },
    });
    app.taskService.updateTask(id, { status: 'in_progress' });
    const closed = app.taskService.updateTask(id, {
      status: 'done',
      verification_evidence: null,
    });

    // Explicit null wins — the caller signalled "drop the evidence" and we
    // honor it. The auto-fill only applies when the field is `undefined`.
    expect(closed.verification_evidence).toBeNull();
  });

  it('unknown verdict is rejected with ValidationError', () => {
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'BOGUS',
        } as unknown as { verdict: 'PASS' },
      })
    ).toThrow(ValidationError);
  });

  it('per-check unknown status is rejected with ValidationError', () => {
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          checks: [
            {
              name: 'unit',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              status: 'NOPE' as any,
              evidence_url_or_text: 'x',
            },
          ],
        },
      })
    ).toThrow(ValidationError);
  });
});
