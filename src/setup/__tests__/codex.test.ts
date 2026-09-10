import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import {
  copyCodexSkills,
  codexSkillsDir,
  codexConfigPath,
  planCodexMcp,
  writeCodexMcp,
} from '../codex.js';
import {
  runSetup,
  runSetupInteractive,
  writeRemoteMcpEntryOnly,
} from '../../cli/commands/setup.js';
import { syncInstalledAssets } from '../../cli/commands/self-update.js';

let home: string;
let source: string;
function write(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft codex home '));
  source = path.join(home, 'package');
  write(path.join(source, 'tasks-show-task/SKILL.md'), 'first version');
  write(path.join(source, '.wood-fired-tasks/references/contract.md'), 'contract v1');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('Codex owned skill installation', () => {
  it('is idempotent, refreshes owned files and restores missing references', () => {
    const dest = codexSkillsDir(home);
    expect(copyCodexSkills(dest, source).written).toHaveLength(2);
    expect(copyCodexSkills(dest, source).written).toEqual([]);
    write(path.join(source, 'tasks-show-task/SKILL.md'), 'second version');
    fs.unlinkSync(path.join(dest, '.wood-fired-tasks/references/contract.md'));
    expect(copyCodexSkills(dest, source).written).toHaveLength(2);
    expect(fs.readFileSync(path.join(dest, 'tasks-show-task/SKILL.md'), 'utf8')).toBe(
      'second version',
    );
  });
  it('preserves unrelated and user-modified files and fails before any writes', () => {
    const dest = codexSkillsDir(home);
    copyCodexSkills(dest, source);
    write(path.join(dest, 'personal/SKILL.md'), 'personal');
    write(path.join(dest, 'tasks-show-task/notes.txt'), 'notes');
    write(path.join(dest, 'tasks-show-task/SKILL.md'), 'customized');
    write(path.join(source, '.wood-fired-tasks/references/contract.md'), 'new contract');
    expect(() => copyCodexSkills(dest, source)).toThrow('Preserved conflicting');
    expect(
      fs.readFileSync(path.join(dest, '.wood-fired-tasks/references/contract.md'), 'utf8'),
    ).toBe('contract v1');
    expect(fs.readFileSync(path.join(dest, 'tasks-show-task/SKILL.md'), 'utf8')).toBe('customized');
    expect(fs.readFileSync(path.join(dest, 'personal/SKILL.md'), 'utf8')).toBe('personal');
  });
  it('does not adopt a preexisting skill, including newly introduced names on update', () => {
    const dest = codexSkillsDir(home);
    write(path.join(dest, 'tasks-show-task/SKILL.md'), 'first version');
    expect(() => copyCodexSkills(dest, source)).toThrow('Preserved conflicting');
    fs.rmSync(dest, { recursive: true });
    copyCodexSkills(dest, source);
    write(path.join(source, 'tasks-new/SKILL.md'), 'new');
    write(path.join(dest, 'tasks-new/notes.txt'), 'user notes');
    expect(() => copyCodexSkills(dest, source)).toThrow('tasks-new');
    expect(fs.existsSync(path.join(dest, 'tasks-new/SKILL.md'))).toBe(false);
  });
  it('removes retired unmodified owned files but preserves untracked files', () => {
    const dest = codexSkillsDir(home);
    copyCodexSkills(dest, source);
    write(path.join(dest, 'tasks-show-task/notes.txt'), 'personal');
    fs.unlinkSync(path.join(source, '.wood-fired-tasks/references/contract.md'));
    copyCodexSkills(dest, source);
    expect(fs.existsSync(path.join(dest, '.wood-fired-tasks/references/contract.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'tasks-show-task/notes.txt'), 'utf8')).toBe('personal');
  });
  it.skipIf(process.platform === 'win32')(
    'allows trusted ancestor symlinks but rejects skill links, including dangling ones',
    () => {
      const alias = path.join(home, 'home-alias');
      const actual = path.join(home, 'actual');
      fs.mkdirSync(actual);
      fs.symlinkSync(actual, alias);
      const dest = codexSkillsDir(alias);
      copyCodexSkills(dest, source);
      const file = path.join(dest, 'tasks-show-task/SKILL.md');
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(home, 'missing'), file);
      expect(() => copyCodexSkills(dest, source)).toThrow('symlink');
      expect(fs.existsSync(path.join(home, 'missing'))).toBe(false);
    },
  );
  it('rejects corrupt or escaping ownership metadata', () => {
    const dest = codexSkillsDir(home);
    write(
      path.join(dest, '.wood-fired-tasks/manifest.json'),
      JSON.stringify({
        owner: 'wood-fired-tasks',
        schema: 1,
        files: { '../outside': 'a'.repeat(64) },
      }),
    );
    expect(() => copyCodexSkills(dest, source)).toThrow(
      'Invalid Wood Fired Tasks ownership manifest',
    );
  });
});

describe('Codex setup and MCP configuration', () => {
  it.each([true, false])(
    'rejects skill conflicts before remote authentication (token=%s)',
    async (hasToken) => {
      const dest = codexSkillsDir(home);
      copyCodexSkills(dest);
      const skill = path.join(dest, 'tasks-show-task/SKILL.md');
      write(skill, 'personal customization');
      const authenticate = vi.fn(async () => {
        throw new Error('authentication must not start');
      });
      await expect(
        runSetupInteractive({
          home,
          codexHome: path.join(home, '.codex'),
          target: 'codex',
          mode: 'remote',
          remote: 'http://localhost:3000',
          ...(hasToken && { token: 'test-token' }),
          manualPatPersist: authenticate,
          oidcProbe: authenticate,
          isInteractive: () => false,
          log: () => {},
        }),
      ).rejects.toThrow('Preserved conflicting Codex skills');
      expect(authenticate).not.toHaveBeenCalled();
      expect(fs.readFileSync(skill, 'utf8')).toBe('personal customization');
      expect(fs.existsSync(codexConfigPath(home, path.join(home, '.codex')))).toBe(false);
    },
  );

  it('skills-only uses user discovery root and leaves both agent configs untouched', async () => {
    const config = path.join(home, 'custom codex/config.toml');
    write(config, '# existing\nmodel = "custom"\n');
    write(path.join(home, '.claude.json'), '{"unchanged":true}');
    const result = await runSetupInteractive({
      home,
      codexHome: path.dirname(config),
      target: 'codex',
      skillsOnly: true,
      log: () => {},
    });
    expect(result.mode).toBe('skills');
    expect(fs.readFileSync(config, 'utf8')).toBe('# existing\nmodel = "custom"\n');
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"unchanged":true}');
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    const dirs = fs.readdirSync(codexSkillsDir(home)).filter((name) => name.startsWith('tasks-'));
    expect(dirs).toHaveLength(17);
    for (const name of dirs) {
      const text = fs.readFileSync(path.join(codexSkillsDir(home), name, 'SKILL.md'), 'utf8');
      const metadata = parseYaml(text.split('---')[1]!);
      expect(metadata.name).toBe(name);
      expect(metadata.description).toEqual(expect.any(String));
      for (const match of text.matchAll(/\]\(([^)]+)\)/g))
        expect(fs.existsSync(path.resolve(codexSkillsDir(home), name, match[1]!))).toBe(true);
    }
    for (const ref of ['loop-shared', '_enums', 'wsjf-rubric'])
      expect(dirs).not.toContain(`tasks-${ref}`);
    const shared = path.join(codexSkillsDir(home), '.wood-fired-tasks/references');
    for (const role of ['tasks-verifier', 'integration-auditor'])
      expect(fs.existsSync(path.join(shared, 'skills/agents', `${role}.md`))).toBe(true);
  });
  it('local setup preserves unrelated TOML bytes and is idempotent without Claude files', () => {
    const codexHome = path.join(home, 'custom codex');
    const file = codexConfigPath(home, codexHome);
    const original =
      '# personal settings\nmodel = "my-model"\n[mcp_servers.other]\ncommand = "other-command"\n';
    write(file, original);
    const options = { home, codexHome, target: 'codex' as const, log: () => {} };
    runSetup(options);
    const first = fs.readFileSync(file, 'utf8');
    expect(first.startsWith(original)).toBe(true);
    expect(
      (parseToml(first).mcp_servers as Record<string, unknown>)['wood-fired-tasks'],
    ).toBeDefined();
    runSetup(options);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });
  it('remote setup writes only URL, preserves config, and rejects a mode switch', () => {
    const codexHome = path.join(home, '.codex');
    const options = {
      home,
      codexHome,
      target: 'codex' as const,
      remote: 'http://localhost:3000',
      log: () => {},
    };
    writeRemoteMcpEntryOnly(options);
    const file = codexConfigPath(home, codexHome);
    const initial = fs.readFileSync(file, 'utf8');
    const server = (
      parseToml(initial).mcp_servers as Record<string, { env: Record<string, string> }>
    )['wood-fired-tasks-remote'];
    expect(server?.env).toMatchObject({ WFT_API_URL: 'http://localhost:3000' });
    expect(server?.env.WFT_CREDENTIALS_PATH).toEqual(expect.any(String));
    expect(server?.env.WFT_API_KEY).toBeUndefined();
    expect(() => runSetup({ home, codexHome, target: 'codex', log: () => {} })).toThrow(
      'codex mcp remove wood-fired-tasks-remote',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(initial);
  });
  it('pins setup database and credentials overrides when the host filters environment', () => {
    const codexHome = path.join(home, '.codex');
    const database = path.join(home, 'custom data/tasks.db');
    runSetup({
      home,
      codexHome,
      target: 'codex',
      dbEnv: { DATABASE_PATH: database },
      log: () => {},
    });
    const config = parseToml(fs.readFileSync(codexConfigPath(home, codexHome), 'utf8'));
    const local = (config.mcp_servers as Record<string, { env: Record<string, string> }>)[
      'wood-fired-tasks'
    ];
    expect(local?.env).toEqual({ DATABASE_PATH: database });
    fs.unlinkSync(codexConfigPath(home, codexHome));
    const credentialsPath = path.join(home, 'private creds/credentials');
    writeRemoteMcpEntryOnly({
      home,
      codexHome,
      target: 'codex',
      remote: 'http://localhost:3000',
      credentialsPath,
      log: () => {},
    });
    const remote = parseToml(fs.readFileSync(codexConfigPath(home, codexHome), 'utf8'));
    const server = (remote.mcp_servers as Record<string, { env: Record<string, string> }>)[
      'wood-fired-tasks-remote'
    ];
    expect(server?.env).toEqual({
      WFT_API_URL: 'http://localhost:3000',
      WFT_CREDENTIALS_PATH: credentialsPath,
    });
  });

  it('does not overwrite customized MCP entries or leak malformed config in errors', () => {
    const codexHome = path.join(home, '.codex');
    const file = codexConfigPath(home, codexHome);
    const options = {
      home,
      codexHome,
      serverName: 'wood-fired-tasks',
      entry: { command: 'node', args: ['server.js'], env: {} },
    };
    write(file, '[mcp_servers.wood-fired-tasks]\ncommand = "custom"\n');
    expect(() => planCodexMcp(options)).toThrow('differs and was preserved');
    write(file, 'secret = "never-show-this');
    expect(() => planCodexMcp(options)).toThrow('Cannot parse');
    try {
      planCodexMcp(options);
    } catch (error) {
      expect(String(error)).not.toContain('never-show-this');
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('secret = "never-show-this');
  });
  it('produces valid TOML for executable and argument paths with spaces', () => {
    const options = {
      home,
      codexHome: path.join(home, '.codex'),
      serverName: 'wood-fired-tasks',
      entry: {
        command: 'C:\\Program Files\\node.exe',
        args: ['C:\\Users\\A B\\server.js'],
        env: {},
      },
    };
    writeCodexMcp(planCodexMcp(options));
    const config = parseToml(fs.readFileSync(codexConfigPath(home, options.codexHome), 'utf8'));
    expect((config.mcp_servers as Record<string, unknown>)['wood-fired-tasks']).toEqual(
      options.entry,
    );
  });
  it('refreshes a detected Codex-only install without creating Claude files', () => {
    copyCodexSkills(codexSkillsDir(home));
    const reference = path.join(
      codexSkillsDir(home),
      '.wood-fired-tasks/references/skills/tasks/loop-shared.md',
    );
    fs.unlinkSync(reference);
    const result = syncInstalledAssets(undefined, home);
    expect(result.codex?.written).toContain(
      '.wood-fired-tasks/references/skills/tasks/loop-shared.md',
    );
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    expect(syncInstalledAssets('codex', home).codex?.written).toEqual([]);
  });
});
