import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WFT #2531 clause 3: docs/SLACK.md states the mapped-user rule for Slack
 * archive and unarchive (design §2.6). The handler refuses an unmapped Slack
 * user and writes nothing; the mapped tracker user is recorded as
 * `archived_by`. This pins the doc so the rule cannot silently drop out.
 */
const SLACK_DOC = resolve(__dirname, '../../../docs/SLACK.md');

describe('docs/SLACK.md: archive and unarchive (WFT #2531)', () => {
  const doc = readFileSync(SLACK_DOC, 'utf8');

  it('lists both commands in the project command table', () => {
    expect(doc).toContain('`/tasks project-archive <id> [reason]`');
    expect(doc).toContain('`/tasks project-unarchive <id>`');
  });

  it('states the mapped-user rule: unmapped refused, nothing written, no fallback, archived_by is the mapped user', () => {
    const start = doc.indexOf('### Archive and unarchive need a mapped user');
    expect(start).toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf('\n## ', start));
    expect(section).toContain('findBySlackUserId');
    expect(section).toContain('Only a Slack user linked to a tracker user can archive a');
    expect(section).toMatch(/nothing is written/);
    expect(section).toMatch(/no fall-back to the `slack-bot` account/);
    expect(section).toMatch(/`archived_by`[\s\S]*mapped tracker user's display name/);
  });
});
