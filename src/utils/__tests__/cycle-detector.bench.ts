/**
 * Vitest benchmarks for CycleDetector.wouldCreateCycle on large graphs (task #212).
 *
 * Soft / advisory bench — see `task.repository.bench.ts` header. Run with
 * `npm run test:bench`; vitest auto-excludes *.bench.ts from `npm test`.
 *
 * We construct two graph shapes:
 *  - Linear chain (1 -> 2 -> 3 -> ... -> N): worst case for DFS depth.
 *  - Wide DAG (each of M sources points at K targets): exercises adjacency
 *    list iteration over many edges per node.
 *
 * NOTE: Vitest 4's bench mode does NOT execute `beforeAll` for benches the
 * same way the test mode does — the hook fires but timing is unreliable for
 * detector construction. We instead seed at module-load time (synchronous,
 * deterministic, no skew).
 */
import { bench, describe } from 'vitest';
import { CycleDetector } from '../cycle-detector.js';

const CHAIN_LENGTH = 1_000;
const WIDE_SOURCES = 500;
const WIDE_FANOUT = 20;
const SOFT_CEILING_MS = 250;

// Linear chain: 1 -> 2 -> ... -> CHAIN_LENGTH
const chainEdges: Array<{ task_id: number; blocks_task_id: number }> = [];
for (let i = 1; i < CHAIN_LENGTH; i++) {
  chainEdges.push({ task_id: i, blocks_task_id: i + 1 });
}
const chainDetector = new CycleDetector(chainEdges);

// Wide DAG: each source 1..M points at sources+1..sources+K (disjoint targets).
const wideEdges: Array<{ task_id: number; blocks_task_id: number }> = [];
for (let s = 1; s <= WIDE_SOURCES; s++) {
  for (let k = 1; k <= WIDE_FANOUT; k++) {
    wideEdges.push({
      task_id: s,
      blocks_task_id: WIDE_SOURCES + ((s + k) % (WIDE_SOURCES * 2)) + 1,
    });
  }
}
const wideDetector = new CycleDetector(wideEdges);

// eslint-disable-next-line no-console
console.log(
  `[bench seed] chain_len=${CHAIN_LENGTH} wide_edges=${wideEdges.length} ` +
    `soft_ceiling_ms=${SOFT_CEILING_MS}`
);

describe('CycleDetector.wouldCreateCycle (bench)', () => {
  // Adding edge that would close the chain into a cycle — worst case: DFS
  // has to walk the full chain to confirm.
  bench(
    'wouldCreateCycle() — closes long chain (cycle = true)',
    () => {
      chainDetector.wouldCreateCycle(CHAIN_LENGTH, 1);
    },
    { time: 2000 }
  );

  // Adding edge that does NOT create a cycle — exercises the no-cycle exit path.
  bench(
    'wouldCreateCycle() — extends chain (cycle = false)',
    () => {
      chainDetector.wouldCreateCycle(CHAIN_LENGTH, CHAIN_LENGTH + 1);
    },
    { time: 2000 }
  );

  bench(
    'wouldCreateCycle() — wide DAG, no cycle',
    () => {
      wideDetector.wouldCreateCycle(1, WIDE_SOURCES * 4);
    },
    { time: 2000 }
  );
});
