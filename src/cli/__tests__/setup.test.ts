import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  runSetup,
  fixNpmPrefix,
  buildLocalMcpEntry,
  resolveMcpEntryPoint,
  commandsDestDir,
  agentsDestDir,
} from '../commands/setup.js';
import { resolveAssetPath, packageRoot } from '../../assets/resolve.js';

// The packaged task-skill .md files SHIP under dist/skills/tasks/ (the asset
// resolver's `resolveAssetPath('dist','skills','tasks')`) — that is the only
// `skills/` location included in the npm tarball's `files`, so setup must copy
// from there for a global install to work.
const tasksSkillsDir = resolveAssetPath('dist', 'skills', 'tasks');

// Subagent definitions ship under dist/skills/agents/ (resolved via the SAME
// asset resolver, not cwd). README.md is authoring-only and excluded from copy.
const agentsSourceDir = resolveAssetPath('dist', 'skills', 'agents');

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

      // (c) subagent definitions copied into ~/.claude/agents/ from the asset
      // resolver (NOT cwd), excluding README.md (task #751).
      const agentsDest = agentsDestDir(home);
      expect(agentsDest).toBe(path.join(home, '.claude', 'agents'));
      const copiedAgents = fs
        .readdirSync(agentsDest)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const agentSourceSet = fs
        .readdirSync(agentsSourceDir)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort();
      expect(copiedAgents).toEqual(agentSourceSet);
      expect(copiedAgents).toContain('tasks-verifier.md');
      expect(copiedAgents).toContain('integration-auditor.md');
      // README.md is excluded from the shipped/copied set.
      expect(copiedAgents).not.toContain('README.md');
      expect(result.agents.sourceDir).toBe(agentsSourceDir);
      expect(result.agents.files).not.toContain('README.md');

      // Bytes match the source (copied verbatim).
      for (const name of copiedAgents) {
        expect(fs.readFileSync(path.join(agentsDest, name))).toEqual(
          fs.readFileSync(path.join(agentsSourceDir, name))
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

      const agentsDest = agentsDestDir(home);
      const agentSnapshot = fs
        .readdirSync(agentsDest)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(agentsDest, name), 'utf8'),
        ]);
      expect(agentSnapshot.length).toBeGreaterThan(0);

      const second = runSetup({ home, log: () => {} });

      // No second-run write.
      expect(second.claudeJsonChanged).toBe(false);
      expect(second.skills.written).toEqual([]);
      expect(second.agents.written).toEqual([]);

      // Byte-stable on disk.
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(jsonAfterFirst);
      const skillSnapshot2 = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(destDir, name), 'utf8')]);
      expect(skillSnapshot2).toEqual(skillSnapshot);

      const agentSnapshot2 = fs
        .readdirSync(agentsDest)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(agentsDest, name), 'utf8'),
        ]);
      expect(agentSnapshot2).toEqual(agentSnapshot);
    });
  });

  it('writes an MCP entry resolving to the INSTALLED package, not a cwd path (task #752)', () => {
    const entry = buildLocalMcpEntry();
    const entryPoint = resolveMcpEntryPoint();

    // command is the running Node binary (absolute), args[0] is the resolved
    // entry point — both absolute, neither cwd-relative.
    expect(path.isAbsolute(entry.command as string)).toBe(true);
    expect(entry.args).toBeDefined();
    const arg0 = (entry.args as string[])[0];
    expect(path.isAbsolute(arg0)).toBe(true);
    expect(arg0).toBe(entryPoint);

    // Resolves under the package root, which is derived from import.meta.url
    // (the asset resolver) — NOT joined onto process.cwd(). This is the
    // load-bearing assertion: a cwd-relative dist path would break a global
    // install spawned from an arbitrary directory. We prove resolver-origin by
    // running the resolver under a DIFFERENT working directory and confirming
    // the path is unchanged.
    expect(arg0.startsWith(packageRoot + path.sep)).toBe(true);
    expect(arg0).toBe(resolveAssetPath('dist', 'mcp', 'index.js'));

    const origCwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      // Same absolute path regardless of cwd — i.e. NOT cwd-relative.
      expect(resolveMcpEntryPoint()).toBe(arg0);
      expect(buildLocalMcpEntry().args?.[0]).toBe(arg0);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('tightens ~/.claude.json to 0600 on POSIX after setup (task #752)', () => {
    withTempHome((home) => {
      const result = runSetup({ home, log: () => {} });
      const claudeJson = result.claudeJsonPath;
      expect(fs.existsSync(claudeJson)).toBe(true);

      if (process.platform !== 'win32') {
        const mode = fs.statSync(claudeJson).mode & 0o777;
        expect(mode).toBe(0o600);
      }
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
