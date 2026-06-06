import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import type { App } from '../../index.js';
import { ValidationError } from '../errors.js';
import { resetConfig } from '../../config/env.js';
import {
  validateVerificationEvidence,
  type EvidenceValidationContext,
} from '../evidence-validation.js';
import type { VerificationEvidence } from '../../types/task.js';

/**
 * task #608 (PIECE A) — server-side anti-fabrication validation of
 * verification_evidence behind the default-OFF WFT_STRICT_EVIDENCE flag.
 *
 * Two layers of coverage:
 *  - The pure validator function (no DB) for each accept/reject path.
 *  - The service-layer integration: flag-off permissive, flag-on accept,
 *    flag-on reject for each path. Uses the env save/restore pattern from
 *    src/api/__tests__/swagger-production.test.ts, resetting the lazy config
 *    Proxy before and after each test.
 */

const VALID_EVIDENCE: VerificationEvidence = {
  verdict: 'PASS',
  checks: [
    {
      name: 'unit',
      status: 'PASS',
      evidence_url_or_text: 'https://ci.example/run/123 — 412 passed, 0 failed',
    },
  ],
  verifier_session_id: 'critic-session-9f3a',
  verifier_request_id: 'req-abc',
  verified_at: '2026-05-31T12:00:00.000Z',
};

describe('validateVerificationEvidence (pure)', () => {
  const baseCtx: EvidenceValidationContext = {
    taskAssignee: 'agent-alpha',
    taskAssigneeUserId: 42,
    callerId: 7,
  };

  it('accepts valid evidence with a distinct verifier and real check text', () => {
    expect(validateVerificationEvidence(VALID_EVIDENCE, baseCtx)).toEqual([]);
  });

  it('rejects missing verifier_session_id', () => {
    const ev = { ...VALID_EVIDENCE, verifier_session_id: undefined };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('verifier_session_id is required'))).toBe(true);
  });

  it('rejects whitespace-only verifier_session_id', () => {
    const ev = { ...VALID_EVIDENCE, verifier_session_id: '   ' };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('verifier_session_id is required'))).toBe(true);
  });

  it('rejects self-grading session ids (orchestrator/self/main-loop)', () => {
    for (const sid of ['orchestrator-7', 'self', 'SELF-2', 'main-loop-3']) {
      const ev = { ...VALID_EVIDENCE, verifier_session_id: sid };
      const v = validateVerificationEvidence(ev, baseCtx);
      expect(v.some((m) => m.includes('self-grading'))).toBe(true);
    }
  });

  it('rejects verifier == task assignee', () => {
    const ev = { ...VALID_EVIDENCE, verifier_session_id: 'agent-alpha' };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('equals the task assignee'))).toBe(true);
  });

  it('rejects verifier == task assignee_user_id', () => {
    const ev = { ...VALID_EVIDENCE, verifier_session_id: '42' };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('assignee user id'))).toBe(true);
  });

  it('rejects verifier == caller id (only when callerId provided)', () => {
    const ev = { ...VALID_EVIDENCE, verifier_session_id: '7' };
    expect(
      validateVerificationEvidence(ev, baseCtx).some((m) =>
        m.includes('equals the calling identity'),
      ),
    ).toBe(true);
    // callerId omitted → that sub-check is skipped
    expect(validateVerificationEvidence(ev, { ...baseCtx, callerId: null })).toEqual([]);
  });

  it('rejects empty check evidence_url_or_text', () => {
    const ev: VerificationEvidence = {
      ...VALID_EVIDENCE,
      checks: [{ name: 'lint', status: 'PASS', evidence_url_or_text: '  ' }],
    };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('evidence_url_or_text is empty'))).toBe(true);
  });

  it('rejects placeholder check evidence (denylist, case-insensitive)', () => {
    for (const ph of ['ok', 'PASS', 'Done', 'n/a', 'NA', 'tbd']) {
      const ev: VerificationEvidence = {
        ...VALID_EVIDENCE,
        checks: [{ name: 'c', status: 'PASS', evidence_url_or_text: ph }],
      };
      const v = validateVerificationEvidence(ev, baseCtx);
      expect(v.some((m) => m.includes('is a placeholder'))).toBe(true);
    }
  });

  it('rejects PASS verdict with no checks', () => {
    const ev: VerificationEvidence = {
      verdict: 'PASS',
      verifier_session_id: 'critic-1',
    };
    const v = validateVerificationEvidence(ev, baseCtx);
    expect(v.some((m) => m.includes('verdict PASS requires at least one'))).toBe(true);
  });

  it('allows NOT_VERIFIED with no checks (only PASS requires checks)', () => {
    const ev: VerificationEvidence = {
      verdict: 'NOT_VERIFIED',
      verifier_session_id: 'critic-1',
    };
    expect(validateVerificationEvidence(ev, baseCtx)).toEqual([]);
  });
});

describe('TaskService strict-evidence integration (#608)', () => {
  let app: App;
  let projectId: number;
  const originalStrict = process.env.WFT_STRICT_EVIDENCE;

  beforeEach(async () => {
    resetConfig();
    app = await createTestApp();
    projectId = app.projectService.createProject({ name: 'strict-608' }).id;
  });

  afterEach(() => {
    app.dispose();
    if (originalStrict === undefined) delete process.env.WFT_STRICT_EVIDENCE;
    else process.env.WFT_STRICT_EVIDENCE = originalStrict;
    resetConfig();
  });

  function newTask(): number {
    return app.taskService.createTask({
      title: 't',
      project_id: projectId,
      created_by: 'tester',
    }).id;
  }

  // A piece of evidence that would FAIL strict mode: bare PASS, no checks,
  // self-grading session id.
  const FABRICATED: VerificationEvidence = {
    verdict: 'PASS',
    verifier_session_id: 'orchestrator-main',
  };

  it('flag OFF (default): accepts evidence that would fail strict mode', () => {
    delete process.env.WFT_STRICT_EVIDENCE;
    resetConfig();
    const id = newTask();
    const updated = app.taskService.updateTask(id, {
      verification_evidence: FABRICATED,
    });
    expect(updated.verification_evidence).toEqual(FABRICATED);
  });

  it('flag ON: accepts valid evidence (distinct verifier + real check text)', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    const updated = app.taskService.updateTask(id, {
      verification_evidence: VALID_EVIDENCE,
    });
    expect(updated.verification_evidence).toEqual(VALID_EVIDENCE);
  });

  it('flag ON: rejects empty verifier_session_id', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          checks: [{ name: 'u', status: 'PASS', evidence_url_or_text: 'real' }],
          verifier_session_id: '   ',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('flag ON: rejects self-grading session pattern', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          checks: [{ name: 'u', status: 'PASS', evidence_url_or_text: 'real' }],
          verifier_session_id: 'main-loop-3',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('flag ON: rejects verifier == assignee', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    // Set the assignee so the equality check has something to match.
    app.taskService.updateTask(id, { assignee: 'agent-bob' });
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          checks: [{ name: 'u', status: 'PASS', evidence_url_or_text: 'real' }],
          verifier_session_id: 'agent-bob',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('flag ON: rejects placeholder evidence_url_or_text', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          checks: [{ name: 'u', status: 'PASS', evidence_url_or_text: 'n/a' }],
          verifier_session_id: 'critic-1',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('flag ON: rejects PASS with no checks', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(id, {
        verification_evidence: {
          verdict: 'PASS',
          verifier_session_id: 'critic-1',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('flag ON: rejects verifier == callerId when threaded', () => {
    process.env.WFT_STRICT_EVIDENCE = 'true';
    resetConfig();
    const id = newTask();
    expect(() =>
      app.taskService.updateTask(
        id,
        {
          verification_evidence: {
            verdict: 'PASS',
            checks: [{ name: 'u', status: 'PASS', evidence_url_or_text: 'real' }],
            verifier_session_id: 'caller-xyz',
          },
        },
        'user',
        'caller-xyz',
      ),
    ).toThrow(ValidationError);
  });
});
