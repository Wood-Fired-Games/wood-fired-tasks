import { describe, expect, it } from 'vitest';
import { formatReevaluationFailures, formatUnarchiveResult } from '../project-tool-definitions.js';

/**
 * The unarchive re-evaluation warning shared by the CLI, both MCP transports
 * and Slack (WFT #2542). An absent `reevaluation_failed_task_ids` (a server
 * older than #2542) is not "nothing failed" (WFT #2552 point 2).
 */
describe('formatReevaluationFailures', () => {
  it('names the failed tasks and how to retry', () => {
    expect(formatReevaluationFailures(7, [41, 42])).toBe(
      'Warning: re-evaluation failed for tasks 41, 42; they kept their old state. ' +
        'Unarchive again to retry (tasks project-unarchive 7, or unarchive_project).',
    );
  });

  it('says nothing on a clean pass', () => {
    expect(formatReevaluationFailures(7, [])).toBeNull();
  });

  it('says the result is unknown when the server did not report it', () => {
    const note = formatReevaluationFailures(7, undefined);

    expect(note).toMatch(/^Note: the server did not report/);
    expect(note).toContain('project 7');
  });
});

describe('formatUnarchiveResult', () => {
  it('adds the unknown-result note for a response without the field (remote MCP, older server)', () => {
    const text = formatUnarchiveResult({ id: 7, name: 'Shelved' });

    expect(text.split('\n')).toEqual([
      'Project 7 unarchived: Shelved',
      expect.stringMatching(/^Note: the server did not report/),
    ]);
  });

  it('is the confirmation alone on a clean pass', () => {
    expect(
      formatUnarchiveResult({ id: 7, name: 'Shelved', reevaluation_failed_task_ids: [] }),
    ).toBe('Project 7 unarchived: Shelved');
  });
});
