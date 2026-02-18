import { describe, it, expect } from 'vitest';
import { formatProjectList, formatProjectDetail } from '../project-formatter.js';
import type { Project } from '../../../types/task.js';

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Wood Fired Bugs',
    description: 'Bug tracking for wood-fired games',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatProjectList
// ---------------------------------------------------------------------------

describe('formatProjectList', () => {
  it('returns a single SectionBlock with "no projects" message for empty array', () => {
    const blocks = formatProjectList([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('section');
    const section = blocks[0] as { type: string; text: { type: string; text: string } };
    expect(section.text.text).toBe('_No projects found._');
    expect(section.text.type).toBe('mrkdwn');
  });

  it('returns a HeaderBlock "Projects (N)" for non-empty array', () => {
    const projects = [makeProject({ id: 1, name: 'Alpha' })];
    const blocks = formatProjectList(projects);
    const header = blocks[0] as { type: string; text: { type: string; text: string; emoji: boolean } };
    expect(header.type).toBe('header');
    expect(header.text.text).toBe('Projects (1)');
    expect(header.text.type).toBe('plain_text');
    expect(header.text.emoji).toBe(true);
  });

  it('returns one SectionBlock per project with id and name in bold', () => {
    const projects = [
      makeProject({ id: 1, name: 'Alpha', description: 'First project' }),
      makeProject({ id: 2, name: 'Beta', description: 'Second project' }),
    ];
    const blocks = formatProjectList(projects);
    // header + section1 + divider + section2 = 4 blocks
    // (no divider after last item)
    expect(blocks).toHaveLength(4);

    const section1 = blocks[1] as { type: string; text: { type: string; text: string } };
    expect(section1.type).toBe('section');
    expect(section1.text.text).toContain('*#1 Alpha*');
    expect(section1.text.text).toContain('First project');

    const divider = blocks[2] as { type: string };
    expect(divider.type).toBe('divider');

    const section2 = blocks[3] as { type: string; text: { type: string; text: string } };
    expect(section2.type).toBe('section');
    expect(section2.text.text).toContain('*#2 Beta*');
    expect(section2.text.text).toContain('Second project');
  });

  it('shows "_no description_" when project has no description', () => {
    const projects = [makeProject({ description: null })];
    const blocks = formatProjectList(projects);
    const section = blocks[1] as { type: string; text: { type: string; text: string } };
    expect(section.text.text).toContain('_no description_');
  });

  it('truncates description to 100 chars with "..." when longer', () => {
    const longDesc = 'A'.repeat(150);
    const projects = [makeProject({ description: longDesc })];
    const blocks = formatProjectList(projects);
    const section = blocks[1] as { type: string; text: { type: string; text: string } };
    // truncate(text, 100) = 97 content chars + '...' = 100 chars total
    expect(section.text.text).toContain('A'.repeat(97) + '...');
    expect(section.text.text).not.toContain('A'.repeat(98));
  });

  it('does NOT add a divider after the last project', () => {
    const projects = [makeProject({ id: 1 }), makeProject({ id: 2 })];
    const blocks = formatProjectList(projects);
    const lastBlock = blocks[blocks.length - 1] as { type: string };
    expect(lastBlock.type).toBe('section');
  });

  it('adds a DividerBlock between projects (not after last)', () => {
    const projects = [
      makeProject({ id: 1 }),
      makeProject({ id: 2 }),
      makeProject({ id: 3 }),
    ];
    const blocks = formatProjectList(projects);
    // header + section + divider + section + divider + section = 6
    expect(blocks).toHaveLength(6);
    const dividers = blocks.filter((b) => (b as { type: string }).type === 'divider');
    expect(dividers).toHaveLength(2);
  });

  it('returns correct block count for single project (no divider)', () => {
    const projects = [makeProject({ id: 1 })];
    const blocks = formatProjectList(projects);
    // header + section = 2 blocks (no divider for single item)
    expect(blocks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatProjectDetail
// ---------------------------------------------------------------------------

describe('formatProjectDetail', () => {
  it('returns a HeaderBlock with the project name', () => {
    const project = makeProject({ name: 'My Project' });
    const blocks = formatProjectDetail(project);
    const header = blocks[0] as { type: string; text: { type: string; text: string; emoji: boolean } };
    expect(header.type).toBe('header');
    expect(header.text.type).toBe('plain_text');
    expect(header.text.text).toBe('My Project');
    expect(header.text.emoji).toBe(true);
  });

  it('truncates project name to 150 chars with "..." in HeaderBlock when longer', () => {
    const longName = 'N'.repeat(200);
    const project = makeProject({ name: longName });
    const blocks = formatProjectDetail(project);
    const header = blocks[0] as { type: string; text: { type: string; text: string } };
    expect(header.text.text.length).toBe(150);
    expect(header.text.text).toBe('N'.repeat(147) + '...');
  });

  it('returns a SectionBlock with fields containing ID, Description, Created, Updated', () => {
    const project = makeProject({
      id: 42,
      description: 'A test project',
      created_at: '2026-01-15T10:00:00.000Z',
      updated_at: '2026-02-10T12:00:00.000Z',
    });
    const blocks = formatProjectDetail(project);

    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const fieldsSection = blocks[1] as {
      type: string;
      fields: Array<{ type: string; text: string }>;
    };
    expect(fieldsSection.type).toBe('section');
    expect(Array.isArray(fieldsSection.fields)).toBe(true);
    expect(fieldsSection.fields.length).toBe(4);

    const fieldTexts = fieldsSection.fields.map((f) => f.text);
    expect(fieldTexts.some((t) => t.includes('#42'))).toBe(true);
    expect(fieldTexts.some((t) => t.includes('A test project'))).toBe(true);
    expect(fieldTexts.some((t) => t.includes('2026-01-15T10:00:00.000Z'))).toBe(true);
    expect(fieldTexts.some((t) => t.includes('2026-02-10T12:00:00.000Z'))).toBe(true);
  });

  it('shows "_none_" in Description field when description is null', () => {
    const project = makeProject({ description: null });
    const blocks = formatProjectDetail(project);
    const fieldsSection = blocks[1] as {
      type: string;
      fields: Array<{ type: string; text: string }>;
    };
    const fieldTexts = fieldsSection.fields.map((f) => f.text);
    expect(fieldTexts.some((t) => t.includes('_none_'))).toBe(true);
  });

  it('truncates description to 200 chars with "..." in fields when longer', () => {
    const longDesc = 'D'.repeat(250);
    const project = makeProject({ description: longDesc });
    const blocks = formatProjectDetail(project);
    const fieldsSection = blocks[1] as {
      type: string;
      fields: Array<{ type: string; text: string }>;
    };
    // truncate(text, 200) = 197 content chars + '...' = 200 chars total
    const descField = fieldsSection.fields.find((f) => f.text.includes('D'.repeat(197)));
    expect(descField).toBeDefined();
    expect(descField!.text).toContain('D'.repeat(197) + '...');
  });

  it('all fields in SectionBlock use mrkdwn type', () => {
    const project = makeProject();
    const blocks = formatProjectDetail(project);
    const fieldsSection = blocks[1] as {
      type: string;
      fields: Array<{ type: string; text: string }>;
    };
    for (const field of fieldsSection.fields) {
      expect(field.type).toBe('mrkdwn');
    }
  });
});
