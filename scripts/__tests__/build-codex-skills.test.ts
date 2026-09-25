import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { buildCodexSkills } from '../build-codex-skills.js';

describe('Codex adapter generation', () => {
  it('bundles transitive relative documents using portable paths and parses only valid metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex build fixture '));
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    try {
      write('package.json', JSON.stringify({ version: '1.2.3' }));
      write(
        'skills/tasks/show-task.md',
        '---\nname: show-task\ndescription: "Inspect a task"\nargument-hint: [task-id] [comment]\n---\nRead [contract](../../docs/contract.md).\n',
      );
      write(
        'skills/tasks/loop-shared.md',
        '---\ndisable-model-invocation: true\n---\nShared reference\n',
      );
      write('skills/agents/tasks-verifier.md', '# Verifier role');
      write('docs/contract.md', 'Read [nested](nested/details.md).');
      write('docs/nested/details.md', 'Read [sibling](../other.md).');
      write('docs/other.md', '# Final transitive reference');
      buildCodexSkills(root);
      const out = path.join(root, 'dist/skills/codex');
      const skill = fs.readFileSync(path.join(out, 'tasks-show-task/SKILL.md'), 'utf8');
      expect(parse(skill.split('---')[1]!)).toEqual({
        name: 'tasks-show-task',
        description: 'Wood Fired Tasks: Inspect a task',
      });
      expect(fs.existsSync(path.join(out, 'tasks-loop-shared'))).toBe(false);
      for (const file of [
        'docs/contract.md',
        'docs/nested/details.md',
        'docs/other.md',
        'skills/tasks/show-task.md',
        'skills/tasks/loop-shared.md',
        'skills/agents/tasks-verifier.md',
      ]) {
        expect(fs.readFileSync(path.join(out, '.wood-fired-tasks/references', file), 'utf8')).toBe(
          fs.readFileSync(path.join(root, file), 'utf8'),
        );
      }
      expect(fs.readFileSync(path.join(out, '.wood-fired-tasks/references/VERSION'), 'utf8')).toBe(
        '1.2.3\n',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
