import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  runSetup,
  fixNpmPrefix,
  buildLocalMcpEntry,
  commandsDestDir,
} from '../commands/setup.js';
import { resolveAssetPath } from '../../assets/resolve.js';

// The packaged task-skill .md files live under skills/tasks/ (the asset
// resolver's `resolveAssetPath('skills','tasks')`); `skillsDir()` is the
// parent skills/ directory.
const tasksSkillsDir = resolveAssetPath('skills', 'tasks');

function withTempHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-home-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('tasks setup', () => {
  it('merges local MCP entry into ~/.claude.json and copies skills', () => {
    withTempHome((home) => {
      // Pre-seed an unrelated key + an unrelated mcpServer to prove preservation.
      const claudeJson = path.join(home, '.claude.json');
      fs.writeFileSync(
        claudeJson,
        JSON.stringify(
          {
            numStartups: 7,
            mcpServers: { 'some-other': { type: 'stdio', command: 'x' } },
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const result = runSetup({ home, log: () => {} });

      // (a) merged local entry present, pre-seeded keys preserved.
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      expect(doc.numStartups).toBe(7);
      expect(doc.mcpServers['some-other']).toEqual({
        type: 'stdio',
        command: 'x',
      });
      expect(doc.mcpServers['wood-fired-tasks']).toEqual(buildLocalMcpEntry());
      expect(doc.mcpServers['wood-fired-tasks'].type).toBe('stdio');

      // (b) skills copied into ~/.claude/commands/tasks/ and match the
      // asset-resolver source set exactly (AC4: resolver, not cwd-relative).
      const destDir = commandsDestDir(home);
      expect(destDir).toBe(path.join(home, '.claude', 'commands', 'tasks'));
      const copied = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const sourceSet = fs
        .readdirSync(tasksSkillsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      expect(copied).toEqual(sourceSet);
      expect(copied).toContain('loop.md');
      expect(copied.length).toBeGreaterThan(0);
      expect(result.skills.sourceDir).toBe(tasksSkillsDir);

      // Bytes match the source (copied verbatim).
      for (const name of copied) {
        expect(fs.readFileSync(path.join(destDir, name))).toEqual(
          fs.readFileSync(path.join(tasksSkillsDir, name))
        );
      }
    });
  });

  it('is idempotent: re-running produces no diff to ~/.claude.json or skills', () => {
    withTempHome((home) => {
      const first = runSetup({ home, log: () => {} });
      expect(first.claudeJsonChanged).toBe(true);

      const claudeJson = path.join(home, '.claude.json');
      const jsonAfterFirst = fs.readFileSync(claudeJson, 'utf8');
      const destDir = commandsDestDir(home);
      const skillSnapshot = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(destDir, name), 'utf8')]);

      const second = runSetup({ home, log: () => {} });

      // No second-run write.
      expect(second.claudeJsonChanged).toBe(false);
      expect(second.skills.written).toEqual([]);

      // Byte-stable on disk.
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(jsonAfterFirst);
      const skillSnapshot2 = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(destDir, name), 'utf8')]);
      expect(skillSnapshot2).toEqual(skillSnapshot);
    });
  });

  it('--fix-npm-prefix advises a user-writable prefix and NEVER uses sudo', () => {
    withTempHome((home) => {
      const ran: Array<{ cmd: string; args: string[] }> = [];
      const lines: string[] = [];
      const result = fixNpmPrefix({
        home,
        runner: (cmd, args) => ran.push({ cmd, args }),
        log: (l) => lines.push(l),
      });

      // Advises ~/.npm-global.
      expect(result.prefix).toBe(path.join(home, '.npm-global'));
      expect(result.binDir).toBe(path.join(home, '.npm-global', 'bin'));
      expect(fs.existsSync(result.binDir)).toBe(true);

      // Configures via npm config set prefix — no elevation.
      expect(ran).toEqual([
        { cmd: 'npm', args: ['config', 'set', 'prefix', result.prefix] },
      ]);

      // Hard assertion: no sudo/runas/pkexec/doas anywhere in invocations
      // or printed guidance.
      const haystack = (
        JSON.stringify(ran) +
        '\n' +
        lines.join('\n') +
        '\n' +
        result.guidance.join('\n')
      ).toLowerCase();
      for (const banned of ['sudo', 'runas', 'pkexec', 'doas']) {
        expect(haystack).not.toContain(banned);
      }
      expect(lines.join('\n')).toContain(result.prefix);
    });
  });
});
