/**
 * Vitest benchmarks for TaskRepository hot paths (task #212).
 *
 * These are advisory perf benchmarks — they DO NOT fail the build on regression.
 * Shared CI runners are noisy and the audit (LOW #3) explicitly calls out that
 * hard pass/fail gates would flap. We keep a soft 250ms ceiling per the audit
 * and emit a console warning if the mean exceeds it. Nightly runs upload the
 * raw bench output as an artifact for trend inspection.
 *
 * Run with:  npm run test:bench
 * (vitest auto-excludes *.bench.ts from the normal `npm test` run.)
 *
 * NOTE: Vitest 4's bench mode does not reliably execute `beforeAll` for
 * per-iteration state; we seed at module-load time instead (one-shot,
 * synchronous, runs before any bench iteration starts).
 */
import { bench, describe } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
import type { CreateTaskDTO } from '../../types/task.js';

// Scaled-down sizes per acceptance criteria — 10k tasks + ~50k tags fits well
// under 60s locally (the spec allows whatever runs in <60s). Adjusting these
// constants is safe; the bench is advisory.
const TASK_COUNT = 10_000;
const TAGS_PER_TASK_MIN = 3;
const TAGS_PER_TASK_MAX = 7;
// Soft ceiling per the audit. Crossing it logs a warning but does not fail.
const SOFT_CEILING_MS = 250;

const TAG_POOL = [
  'bug',
  'urgent',
  'backend',
  'frontend',
  'security',
  'perf',
  'ux',
  'docs',
  'tech-debt',
  'investigation',
  'refactor',
  'spike',
];

// ---- module-level seeding (runs once before any bench iteration) ----
const db: Database.Database = initDatabase(':memory:');
await runMigrations(db);

const projectRepo = new ProjectRepository(db);
const taskRepo = new TaskRepository(db);

const projects = [1, 2, 3].map((i) => projectRepo.create({ name: `Bench Project ${i}` }));

const statuses = ['open', 'in_progress', 'done', 'backlogged'] as const;
const priorities = ['low', 'medium', 'high', 'urgent'] as const;
let totalTagsInserted = 0;

db.transaction(() => {
  for (let i = 0; i < TASK_COUNT; i++) {
    const dto: CreateTaskDTO = {
      title: `Bench task ${i}`,
      description: `Auto-generated task ${i} for perf bench`,
      status: statuses[i % statuses.length],
      priority: priorities[i % priorities.length],
      project_id: projects[i % projects.length].id,
      created_by: `bench-user-${i % 10}`,
    };
    const tagCount = TAGS_PER_TASK_MIN + (i % (TAGS_PER_TASK_MAX - TAGS_PER_TASK_MIN + 1));
    const tags: string[] = [];
    for (let t = 0; t < tagCount; t++) {
      tags.push(TAG_POOL[(i + t) % TAG_POOL.length]);
    }
    // Deduplicate (some i+t collisions land on the same tag).
    const uniqueTags = Array.from(new Set(tags));
    taskRepo.create(dto, uniqueTags);
    totalTagsInserted += uniqueTags.length;
  }
})();

// eslint-disable-next-line no-console
console.log(
  `[bench seed] tasks=${TASK_COUNT} tags=${totalTagsInserted} ` +
    `soft_ceiling_ms=${SOFT_CEILING_MS}`,
);

describe('TaskRepository.findByFilters (bench)', () => {
  // Page 1, no filter — exercises the LIMIT/OFFSET + GROUP_CONCAT path.
  bench(
    'findByFilters() — no filter, default page',
    () => {
      taskRepo.findByFilters({});
    },
    { time: 2000 },
  );

  // status filter — common indexed path.
  bench(
    'findByFilters({ status: "open" })',
    () => {
      taskRepo.findByFilters({ status: 'open' });
    },
    { time: 2000 },
  );

  // Tag filter — joins through task_tags via EXISTS clause; hottest path
  // since the audit specifically calls out the tag filter.
  bench(
    'findByFilters({ tags: ["bug", "perf"] })',
    () => {
      taskRepo.findByFilters({ tags: ['bug', 'perf'] });
    },
    { time: 2000 },
  );

  // Compound filter — project + status + tag (what most UI views send).
  bench(
    'findByFilters({ project_id, status, tags })',
    () => {
      taskRepo.findByFilters({
        project_id: 1,
        status: 'in_progress',
        tags: ['urgent'],
      });
    },
    { time: 2000 },
  );
});
