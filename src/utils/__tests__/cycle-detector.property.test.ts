import { test, fc } from '@fast-check/vitest';
import { describe } from 'vitest';
import { CycleDetector } from '../cycle-detector.js';

const nodeArb = fc.integer({ min: 1, max: 100 });

const edgeArb = fc.record({
  task_id: nodeArb,
  blocks_task_id: nodeArb,
}).filter(e => e.task_id !== e.blocks_task_id);

describe('CycleDetector property tests', () => {
  test.prop([nodeArb, nodeArb])(
    'empty graph has no cycles for distinct nodes',
    (a, b) => {
      fc.pre(a !== b);
      const detector = new CycleDetector([]);
      return detector.wouldCreateCycle(a, b) === false;
    }
  );

  test.prop([nodeArb])(
    'self-loop is always a cycle',
    (a) => {
      const detector = new CycleDetector([]);
      return detector.wouldCreateCycle(a, a) === true;
    }
  );

  test.prop([fc.array(edgeArb, { maxLength: 20 }), nodeArb, nodeArb])(
    'wouldCreateCycle always returns a boolean',
    (edges, from, to) => {
      const detector = new CycleDetector(edges);
      return typeof detector.wouldCreateCycle(from, to) === 'boolean';
    }
  );

  test.prop([nodeArb, nodeArb])(
    'mutual edge creates a cycle',
    (a, b) => {
      fc.pre(a !== b);
      const detector = new CycleDetector([{ task_id: a, blocks_task_id: b }]);
      return detector.wouldCreateCycle(b, a) === true;
    }
  );
});
