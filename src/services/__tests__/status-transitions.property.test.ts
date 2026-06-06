import { test, fc } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { VALID_STATUS_TRANSITIONS, TASK_STATUSES } from '../../types/task.js';
import type { TaskStatus } from '../../types/task.js';

const statusArb = fc.constantFrom(...TASK_STATUSES);

describe('Status transition state machine properties', () => {
  test.prop([statusArb])('every status has defined transitions', (status) => {
    return Array.isArray(VALID_STATUS_TRANSITIONS[status]);
  });

  test.prop([statusArb])('all transition targets are valid statuses', (status) => {
    const targets = VALID_STATUS_TRANSITIONS[status];
    return targets.every((target: TaskStatus) => TASK_STATUSES.includes(target));
  });

  test.prop([statusArb])('backlogged only transitions to open', (status) => {
    if (status === 'backlogged') {
      const targets = VALID_STATUS_TRANSITIONS[status];
      return targets.length === 1 && targets[0] === 'open';
    }
    return true;
  });

  test.prop([statusArb])('no self-transitions', (status) => {
    return !VALID_STATUS_TRANSITIONS[status].includes(status);
  });

  test.prop([fc.constant('backlogged' as TaskStatus)])(
    'open is reachable from backlogged',
    (status) => {
      return VALID_STATUS_TRANSITIONS[status].includes('open');
    },
  );
});
