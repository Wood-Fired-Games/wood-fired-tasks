import { describe, it, expect } from 'vitest';
import { CycleDetector } from '../cycle-detector.js';

describe('CycleDetector', () => {
  it('should detect no cycle in empty graph', () => {
    const detector = new CycleDetector([]);
    expect(detector.wouldCreateCycle(1, 2)).toBe(false);
  });

  it('should detect no cycle in linear chain', () => {
    // A -> B -> C
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 2, blocks_task_id: 3 },
    ]);

    // Adding D -> A should not create cycle
    expect(detector.wouldCreateCycle(4, 1)).toBe(false);
  });

  it('should detect cycle when closing a linear chain', () => {
    // A -> B -> C
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 2, blocks_task_id: 3 },
    ]);

    // Adding C -> A creates cycle: A -> B -> C -> A
    expect(detector.wouldCreateCycle(3, 1)).toBe(true);
  });

  it('should detect self-reference as cycle', () => {
    const detector = new CycleDetector([]);

    // A -> A is a cycle
    expect(detector.wouldCreateCycle(1, 1)).toBe(true);
  });

  it('should detect no cycle in diamond graph', () => {
    // A -> B, A -> C, B -> D, C -> D (diamond)
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 1, blocks_task_id: 3 },
      { task_id: 2, blocks_task_id: 4 },
      { task_id: 3, blocks_task_id: 4 },
    ]);

    // No cycle present - multiple paths to D is OK
    expect(detector.wouldCreateCycle(5, 4)).toBe(false);
  });

  it('should detect cycle when closing diamond graph', () => {
    // A -> B, A -> C, B -> D, C -> D (diamond)
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 1, blocks_task_id: 3 },
      { task_id: 2, blocks_task_id: 4 },
      { task_id: 3, blocks_task_id: 4 },
    ]);

    // Adding D -> A creates cycle: A -> B -> D -> A (or A -> C -> D -> A)
    expect(detector.wouldCreateCycle(4, 1)).toBe(true);
  });

  it('should detect cycle in disconnected components', () => {
    // Component 1: A -> B -> C
    // Component 2: D -> E (separate)
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 2, blocks_task_id: 3 },
      { task_id: 4, blocks_task_id: 5 },
    ]);

    // Adding C -> A creates cycle in component 1
    expect(detector.wouldCreateCycle(3, 1)).toBe(true);

    // Adding E -> D creates cycle in component 2
    expect(detector.wouldCreateCycle(5, 4)).toBe(true);
  });

  it('should not detect cycle when connecting disconnected components', () => {
    // Component 1: A -> B
    // Component 2: C -> D (separate)
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 3, blocks_task_id: 4 },
    ]);

    // Connecting B -> C just merges components, no cycle
    expect(detector.wouldCreateCycle(2, 3)).toBe(false);
  });

  it('should detect immediate two-node cycle', () => {
    // A -> B
    const detector = new CycleDetector([{ task_id: 1, blocks_task_id: 2 }]);

    // Adding B -> A creates cycle
    expect(detector.wouldCreateCycle(2, 1)).toBe(true);
  });

  it('should handle multiple edges from same node', () => {
    // A -> B, A -> C, A -> D (fan-out)
    const detector = new CycleDetector([
      { task_id: 1, blocks_task_id: 2 },
      { task_id: 1, blocks_task_id: 3 },
      { task_id: 1, blocks_task_id: 4 },
    ]);

    // Adding another fan-out edge is fine
    expect(detector.wouldCreateCycle(1, 5)).toBe(false);

    // But closing a loop creates cycle
    expect(detector.wouldCreateCycle(2, 1)).toBe(true);
  });
});
