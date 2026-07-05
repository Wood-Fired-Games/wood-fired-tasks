import { describe, expect, it } from 'vitest';

import {
  CandidateTaskSchema,
  type CandidateTask,
  DecompositionFrontmatterSchema,
  type DecompositionFrontmatter,
} from '../schema.js';

/**
 * Wave 5 (task #320) — falsifiable tests for the DECOMPOSITION.md
 * frontmatter schema and the per-candidate task schema. Mirrors the
 * constraints documented in `docs/tasks-decompose-design.md` §6 and §7
 * so a future schema drift breaks compilation here AND fails the design
 * doc's static gate in
 * `src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`.
 *
 * Runtime guardrails NOT enforceable by zod (and therefore not tested
 * here — they are tested by the design-doc gate test): blast-radius
 * keyword refusal, ≥ 30% interdependence halt, no-self-rewrite. The
 * schema simply accepts a `goal` string at the type level; the keyword
 * check is Step 1 runtime logic.
 */

const VALID_FRONTMATTER: DecompositionFrontmatter = {
  decomposition_id: '7c1a0b9e-f8c2-4d7b-9d2e-3c8a0f1d4a55',
  project_id: 15,
  generated_at: '2026-05-23T20:20:13Z',
  goal: 'Ship OIDC SSO for the wood-fired-tasks Slack app so internal users can authenticate via Google Workspace.',
  success_criteria: [
    'Slack OAuth flow accepts a Google-issued OIDC token',
    'Session middleware re-uses the existing fastify cookie store',
    'Logout invalidates the token both client- and server-side',
  ],
  domain: 'backend',
  topology: 'DAG',
  advisory: '/tasks:loop-dag',
  candidate_count: 12,
  dependency_edge_count: 7,
  total_usd: 4.18,
  cost_cap_hit: false,
};

const REQUIRED_FRONTMATTER_FIELDS = [
  'decomposition_id',
  'project_id',
  'generated_at',
  'goal',
  'success_criteria',
  'domain',
  'topology',
  'advisory',
  'candidate_count',
  'dependency_edge_count',
  'total_usd',
  'cost_cap_hit',
] as const;

const VALID_CANDIDATE: CandidateTask = {
  draft_id: 1,
  title: 'Wire Google OIDC discovery document into openid-client',
  description:
    'Add a `discoveryUrl` constant pointing at Google’s well-known OIDC config and pass it through openid-client at startup. Cache the resulting Client instance on the fastify decorator so request handlers reuse it.',
  acceptance_criteria: [
    'openid-client.Issuer.discover() succeeds in CI smoke test',
    'GET /auth/login returns 302 to accounts.google.com',
  ],
  suspected_edges: [{ from_draft_id: 2, to_draft_id: 1 }],
  estimated_minutes: 45,
};

const REQUIRED_CANDIDATE_FIELDS = [
  'draft_id',
  'title',
  'description',
  'acceptance_criteria',
  'suspected_edges',
  'estimated_minutes',
] as const;

describe('DecompositionFrontmatterSchema', () => {
  it('accepts a well-formed frontmatter block', () => {
    const result = DecompositionFrontmatterSchema.safeParse(VALID_FRONTMATTER);
    expect(result.success).toBe(true);
  });

  it('accepts an optional aborted_reason on the BLOCKED branch', () => {
    const aborted: DecompositionFrontmatter = {
      ...VALID_FRONTMATTER,
      topology: 'DAG_CYCLIC',
      advisory: 'BLOCKED',
      aborted_reason: 'cycle',
    };
    expect(DecompositionFrontmatterSchema.safeParse(aborted).success).toBe(true);
  });

  it('exposes every required frontmatter field in the schema shape', () => {
    const shapeKeys = new Set(Object.keys(DecompositionFrontmatterSchema.shape));
    for (const required of REQUIRED_FRONTMATTER_FIELDS) {
      expect(shapeKeys.has(required)).toBe(true);
    }
  });

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    it(`rejects frontmatter missing required field "${field}"`, () => {
      const incomplete: Record<string, unknown> = { ...VALID_FRONTMATTER };
      delete incomplete[field];
      expect(DecompositionFrontmatterSchema.safeParse(incomplete).success).toBe(false);
    });
  }

  it('rejects an invalid UUID in decomposition_id', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        decomposition_id: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects success_criteria with only 2 entries (below the lower bound)', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        success_criteria: ['only one', 'and a second'],
      }).success,
    ).toBe(false);
  });

  it('rejects success_criteria with 6 entries (above the upper bound)', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        success_criteria: ['a', 'b', 'c', 'd', 'e', 'f'],
      }).success,
    ).toBe(false);
  });

  it('accepts the boundary cases success_criteria length 3 and 5', () => {
    for (const arr of [
      ['a', 'b', 'c'],
      ['a', 'b', 'c', 'd', 'e'],
    ]) {
      expect(
        DecompositionFrontmatterSchema.safeParse({
          ...VALID_FRONTMATTER,
          success_criteria: arr,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown topology value', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        topology: 'STAR',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown advisory value', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        advisory: '/tasks:bug-smash',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown aborted_reason value', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        aborted_reason: 'because',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown domain value', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        domain: 'iot',
      }).success,
    ).toBe(false);
  });

  it('rejects negative total_usd', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        total_usd: -0.01,
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer project_id', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        project_id: 1.5,
      }).success,
    ).toBe(false);
  });

  it('rejects project_id of 0 (must be positive)', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        project_id: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-RFC3339 generated_at', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        generated_at: 'yesterday',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty goal string', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        goal: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a goal that exceeds the 1500-char schema cap (200 words)', () => {
    const tooLong = 'word '.repeat(400); // ~2000 chars
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        goal: tooLong,
      }).success,
    ).toBe(false);
  });

  it('rejects negative candidate_count', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        candidate_count: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects negative dependency_edge_count', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        dependency_edge_count: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean cost_cap_hit', () => {
    expect(
      DecompositionFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        cost_cap_hit: 'true' as unknown as boolean,
      }).success,
    ).toBe(false);
  });
});

describe('CandidateTaskSchema', () => {
  it('accepts a well-formed candidate', () => {
    expect(CandidateTaskSchema.safeParse(VALID_CANDIDATE).success).toBe(true);
  });

  for (const field of REQUIRED_CANDIDATE_FIELDS) {
    it(`rejects a candidate missing required field "${field}"`, () => {
      const incomplete: Record<string, unknown> = { ...VALID_CANDIDATE };
      delete incomplete[field];
      expect(CandidateTaskSchema.safeParse(incomplete).success).toBe(false);
    });
  }

  it('enforces the Step 7 sizing cap: rejects estimated_minutes > 90', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        estimated_minutes: 91,
      }).success,
    ).toBe(false);
  });

  it('enforces estimated_minutes ≥ 1', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        estimated_minutes: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts the boundary cases estimated_minutes = 1 and 90', () => {
    for (const minutes of [1, 90]) {
      expect(
        CandidateTaskSchema.safeParse({
          ...VALID_CANDIDATE,
          estimated_minutes: minutes,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects non-integer estimated_minutes', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        estimated_minutes: 45.5,
      }).success,
    ).toBe(false);
  });

  it('rejects acceptance_criteria with zero entries', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        acceptance_criteria: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a title longer than 255 chars (matches bugs-db tasks.title cap)', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        title: 'x'.repeat(256),
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive draft_id', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        draft_id: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts an empty suspected_edges array (FLAT topology happy path)', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        suspected_edges: [],
      }).success,
    ).toBe(true);
  });

  it('rejects a suspected edge with non-positive draft ids', () => {
    expect(
      CandidateTaskSchema.safeParse({
        ...VALID_CANDIDATE,
        suspected_edges: [{ from_draft_id: 0, to_draft_id: 1 }],
      }).success,
    ).toBe(false);
  });

  it('accepts optional target_files (≤ 8 repo-relative paths)', () => {
    const candidate = {
      ...VALID_CANDIDATE,
      target_files: ['src/a.ts', 'docs/b.md (new)'],
    };
    expect(CandidateTaskSchema.safeParse(candidate).success).toBe(true);
  });

  it('rejects more than 8 target_files', () => {
    const candidate = {
      ...VALID_CANDIDATE,
      target_files: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
    };
    expect(CandidateTaskSchema.safeParse(candidate).success).toBe(false);
  });
});
