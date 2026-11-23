import type { KnownBlock, SectionBlock, HeaderBlock, DividerBlock } from '@slack/types';
import type { Project } from '../../types/task.js';
import { escapeSlackMrkdwn } from '../mrkdwn.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// formatProjectList
// ---------------------------------------------------------------------------

/**
 * Formats an array of projects into a Block Kit KnownBlock[] for Slack.
 *
 * Empty array → single SectionBlock with "_No projects found._"
 * Non-empty → HeaderBlock "Projects (N)" + one SectionBlock per project,
 *             with a DividerBlock between items (not after the last).
 */
export function formatProjectList(projects: Project[]): KnownBlock[] {
  if (projects.length === 0) {
    const empty: SectionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: '_No projects found._' },
    };
    return [empty];
  }

  const header: HeaderBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: `Projects (${projects.length})`,
      emoji: true,
    },
  };

  const blocks: KnownBlock[] = [header];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (project === undefined) continue;
    const descPreview = project.description
      ? escapeSlackMrkdwn(truncate(project.description, 100))
      : '_no description_';

    const section: SectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*#${project.id} ${escapeSlackMrkdwn(project.name)}*${
          project.archived ? ' _(archived)_' : ''
        }\n${descPreview}`,
      },
    };
    blocks.push(section);

    // Add divider between projects, but NOT after the last one
    if (i < projects.length - 1) {
      const divider: DividerBlock = { type: 'divider' };
      blocks.push(divider);
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// formatProjectDetail
// ---------------------------------------------------------------------------

/**
 * Formats a single project into a Block Kit KnownBlock[] for Slack.
 *
 * Returns:
 *   - HeaderBlock: project name (truncated to 150 chars, plain_text, emoji: true)
 *   - SectionBlock with fields: ID, Description (truncated to 200 chars or "_none_"),
 *     Created, Updated, and Archived (date, actor, reason) when the project is archived
 */
export function formatProjectDetail(project: Project): KnownBlock[] {
  const nameText = project.name.length > 147 ? project.name.slice(0, 147) + '...' : project.name;

  const header: HeaderBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: escapeSlackMrkdwn(nameText),
      emoji: true,
    },
  };

  const descText = project.description
    ? escapeSlackMrkdwn(truncate(project.description, 200))
    : '_none_';

  const fieldsSection: SectionBlock = {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*ID*\n#${project.id}` },
      { type: 'mrkdwn', text: `*Description*\n${descText}` },
      { type: 'mrkdwn', text: `*Created*\n${project.created_at}` },
      { type: 'mrkdwn', text: `*Updated*\n${project.updated_at}` },
    ],
  };

  // Archived project state: when, by whom and (if given) why. The actor and
  // the reason are user-supplied text, so both are escaped.
  if (project.archived) {
    const by = project.archived_by ? ` by ${escapeSlackMrkdwn(project.archived_by)}` : '';
    const reason = project.archive_reason
      ? `\n_${escapeSlackMrkdwn(truncate(project.archive_reason, 200))}_`
      : '';
    fieldsSection.fields?.push({
      type: 'mrkdwn',
      text: `*Archived*\n${project.archived_at ?? 'unknown'}${by}${reason}`,
    });
  }

  return [header, fieldsSection];
}
