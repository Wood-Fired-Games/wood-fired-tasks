import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  runSetup,
  runSetupInteractive,
  fixNpmPrefix,
  buildLocalMcpEntry,
  resolveMcpEntryPoint,
  commandsDestDir,
  agentsDestDir,
  settingsJsonPath,
  buildStatuslineConfig,
  statuslineEmbedSnippet,
  wireStatusline,
  offerStatuslineWiring,
  type SetupMode,
} from '../commands/setup.js';
import { buildNpmInvocation } from '../util/npm-spawn.js';
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
          2,
        ) + '\n',
        'utf8',
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
          fs.readFileSync(path.join(tasksSkillsDir, name)),
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
          fs.readFileSync(path.join(agentsSourceDir, name)),
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
        .map((name) => [name, fs.readFileSync(path.join(agentsDest, name), 'utf8')]);
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
        .map((name) => [name, fs.readFileSync(path.join(agentsDest, name), 'utf8')]);
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
      expect(ran).toEqual([{ cmd: 'npm', args: ['config', 'set', 'prefix', result.prefix] }]);

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

  // Regression (task #794): on Windows npm is `npm.cmd` (EINVAL if spawned
  // without a shell since CVE-2024-27980), and the home path can contain spaces
  // (C:\Users\John Doe\.npm-global) which a naive shell:true would split.
  // fixNpmPrefix routes its npm call through buildNpmInvocation; assert the
  // exact args it emits produce a well-formed, non-splitting win32 invocation.
  it('--fix-npm-prefix emits a Windows-safe npm invocation for a spaced home', () => {
    withTempHome((tmp) => {
      // A home path with a space, mimicking C:\Users\John Doe.
      const home = path.join(tmp, 'John Doe');
      fs.mkdirSync(home, { recursive: true });
      const ran: Array<{ cmd: string; args: string[] }> = [];
      const result = fixNpmPrefix({
        home,
        runner: (cmd, args) => ran.push({ cmd, args }),
        log: () => {},
      });

      // The logical call fixNpmPrefix makes (prefix carries the space).
      expect(ran).toEqual([{ cmd: 'npm', args: ['config', 'set', 'prefix', result.prefix] }]);
      expect(result.prefix).toContain('John Doe');

      // What the default runner hands to the OS on win32: npm.cmd via a shell,
      // with the spaced prefix quoted so cmd.exe keeps it a single token.
      const inv = buildNpmInvocation(ran[0].args, 'win32');
      expect(inv.command).toBe('npm.cmd');
      expect(inv.shell).toBe(true);
      expect(inv.args[inv.args.length - 1]).toBe(`"${result.prefix}"`);
      expect(`${inv.command} ${inv.args.join(' ')}`).toBe(
        `npm.cmd config set prefix "${result.prefix}"`,
      );
    });
  });
});

// A FAKE token — never a real secret.
const FAKE_PAT = 'wft_pat_FAKE_TEST_TOKEN_0123456789';

// Async-safe temp HOME: the sync withTempHome above tears down in a sync
// finally that would fire before an async callback settles, so the mode tests
// (all async) use this awaited variant.
async function withTempHomeAsync<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-mode-home-'));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('tasks setup — modes (task #805)', () => {
  it('no args on a simulated TTY presents the Local/Service/Remote menu', async () => {
    await withTempHomeAsync(async (home) => {
      const presented: ReadonlyArray<{ label: string; value: SetupMode }>[] = [];
      const result = await runSetupInteractive({
        home,
        log: () => {},
        // Simulate a TTY so the menu path is taken.
        isInteractive: () => true,
        // Stub the selector but capture that a 3-option menu would be shown,
        // mirroring the labels selectSetupMode renders.
        selectMode: async () => {
          presented.push([
            { label: 'Local', value: 'local' },
            { label: 'Service', value: 'service' },
            { label: 'Remote', value: 'remote' },
          ]);
          return 'local';
        },
      });

      // The menu was consulted exactly once and offered all three modes.
      expect(presented).toHaveLength(1);
      expect(presented[0].map((o) => o.value).sort()).toEqual(['local', 'remote', 'service']);
      // And the chosen path actually ran (local install happened).
      expect(result.mode).toBe('local');
      if (result.mode !== 'service') {
        expect(result.remote).toBe(false);
        expect(result.claudeJsonChanged).toBe(true);
      }
    });
  });

  it('the real menu (selectSetupMode) reads a choice from an injected input stream', async () => {
    const { PassThrough } = await import('node:stream');
    await withTempHomeAsync(async (home) => {
      const input = new PassThrough();
      const outChunks: string[] = [];
      const output = { write: (s: string) => (outChunks.push(s), true) };
      // Select option 2 (Service) by index.
      input.write('2\n');

      const captured: Array<'local' | 'service' | 'remote'> = [];
      await runSetupInteractive({
        home,
        log: () => {},
        isInteractive: () => true,
        promptIO: { input, output },
        // Service path is the simplest to assert routing without disk work.
        serviceInstall: () => captured.push('service'),
      });

      // The rendered menu contained all three labels.
      const rendered = outChunks.join('');
      expect(rendered).toContain('Local');
      expect(rendered).toContain('Service');
      expect(rendered).toContain('Remote');
      // Index "2" routed to the service path.
      expect(captured).toEqual(['service']);
    });
  });

  it('--local runs the Local path without prompting (the MODE menu)', async () => {
    await withTempHomeAsync(async (home) => {
      let modePrompted = false;
      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        // A TTY is simulated, but with an EXPLICIT --local mode the MODE menu
        // must never be consulted (selectMode is the real mode-menu seam).
        isInteractive: () => true,
        selectMode: async () => {
          modePrompted = true;
          return 'remote';
        },
        // The Local path now also offers the opt-in statusline wiring (#798);
        // decline it here so this test stays focused on mode routing.
        confirmStatusline: async () => false,
      });

      // The MODE menu was never shown (mode was explicit).
      expect(modePrompted).toBe(false);
      expect(result.mode).toBe('local');
      if (result.mode !== 'service') {
        expect(result.remote).toBe(false);
        // Local entry was written to ~/.claude.json.
        const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
        expect(doc.mcpServers['wood-fired-tasks']).toEqual(buildLocalMcpEntry());
      }
    });
  });

  it('--service runs the user-scoped service install without prompting', async () => {
    await withTempHomeAsync(async (home) => {
      let prompted = false;
      let installed = false;
      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'service',
        isInteractive: () => {
          prompted = true;
          return true;
        },
        serviceInstall: () => {
          installed = true;
        },
      });

      expect(prompted).toBe(false);
      expect(installed).toBe(true);
      expect(result.mode).toBe('service');
      // The service path does NOT touch ~/.claude.json.
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });

  it('--service uses the DEFAULT user-scoped install from service.ts (system:false)', async () => {
    // No injected serviceInstall: exercise the real default wiring
    // (`() => getServiceBackend().install({ system: false })`). Spy on the
    // service module's getServiceBackend so no systemctl/launchd/schtasks runs.
    const service = await import('../commands/service.js');
    const calls: Array<{ system?: boolean } | undefined> = [];
    const fakeBackend = {
      install: (o?: { system?: boolean }) => {
        calls.push(o);
      },
      uninstall: () => {},
      status: () => ({
        running: false,
        enabled: false,
        activeState: 'inactive',
        enabledState: 'disabled',
        installed: false,
      }),
    };
    const spy = vi.spyOn(service, 'getServiceBackend').mockReturnValue(fakeBackend);
    try {
      await withTempHomeAsync(async (home) => {
        const result = await runSetupInteractive({
          home,
          log: () => {},
          mode: 'service',
          isInteractive: () => false,
          // NOTE: serviceInstall intentionally NOT injected — assert the default.
        });
        expect(result.mode).toBe('service');
      });
      // The default path requested a user-scoped (non-elevated) install.
      expect(calls).toEqual([{ system: false }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('--remote runs the Remote path without prompting', async () => {
    await withTempHomeAsync(async (home) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-mode-cfg-'));
      try {
        let prompted = false;
        const result = await runSetupInteractive({
          home,
          configDir,
          log: () => {},
          mode: 'remote',
          remote: 'http://tasks.example.local:3000',
          token: FAKE_PAT,
          // Inject the OIDC probe so this test stays deterministic (no network).
          // `disabled` routes to the manual-PAT path, which — given --token —
          // validates+persists the PAT then writes the URL-only remote MCP entry.
          oidcProbe: async () => ({ ok: true, oidc: 'disabled' }),
          // Inject the credentials-writer seam so the manual path never makes a
          // real /api/v1/me fetch (#809). The branch hands it the --token PAT.
          manualPatPersist: async () => ({
            ok: true,
            identity: { id: 1, displayName: 'Test User', email: null },
          }),
          isInteractive: () => {
            prompted = true;
            return true;
          },
          selectMode: async () => {
            prompted = true;
            return 'local';
          },
        });

        // The mode menu was never consulted (mode was explicit). The manual-PAT
        // path here uses the provided --token, so no secret prompt is needed.
        expect(prompted).toBe(false);
        expect(result.mode).toBe('remote');
        if (result.mode === 'remote') {
          expect(result.method).toBe('manual-pat');
          expect(result.ok).toBe(true);
          expect(result.setup?.remote).toBe(true);
          const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
          expect(doc.mcpServers['wood-fired-tasks-remote']).toBeDefined();
        }
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  it('no args + non-TTY defaults to the Local path (back-compat)', async () => {
    await withTempHomeAsync(async (home) => {
      let prompted = false;
      const result = await runSetupInteractive({
        home,
        log: () => {},
        // Non-interactive environment, no explicit mode.
        isInteractive: () => false,
        selectMode: async () => {
          prompted = true;
          return 'remote';
        },
      });

      // Menu was NEVER consulted; defaulted to local.
      expect(prompted).toBe(false);
      expect(result.mode).toBe('local');
      if (result.mode !== 'service') {
        expect(result.remote).toBe(false);
        const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
        expect(doc.mcpServers['wood-fired-tasks']).toEqual(buildLocalMcpEntry());
      }
    });
  });
});

describe('tasks setup — statusline wiring (task #798)', () => {
  // Branch 1: no existing statusLine + consent → setup WRITES a statusLine that
  // runs `tasks statusline`, against a TEMP settings.json (never the real one).
  it('writes a statusLine on consent when none exists', async () => {
    await withTempHomeAsync(async (home) => {
      const settingsPath = settingsJsonPath(home);
      expect(settingsPath).toBe(path.join(home, '.claude', 'settings.json'));
      expect(fs.existsSync(settingsPath)).toBe(false);

      const result = await offerStatuslineWiring({
        home,
        log: () => {},
        isInteractive: () => true,
        // Consent.
        confirm: async () => true,
      });

      expect(result.action).toBe('written');
      if (result.action === 'written') expect(result.changed).toBe(true);

      // The TEMP settings.json now carries a statusLine running `tasks statusline`.
      const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(doc.statusLine).toEqual(buildStatuslineConfig());
      expect(doc.statusLine.command).toBe('tasks statusline');
      expect(doc.statusLine.command).toContain('tasks statusline');
    });
  });

  // The single wiring preserves unrelated keys and is idempotent on re-run.
  it('preserves other settings keys and is idempotent on re-run', async () => {
    await withTempHomeAsync(async (home) => {
      const settingsPath = settingsJsonPath(home);
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ theme: 'dark', model: 'opus' }, null, 2) + '\n',
        'utf8',
      );

      const first = wireStatusline({ home, log: () => {} });
      expect(first.action).toBe('written');
      if (first.action === 'written') expect(first.changed).toBe(true);

      const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(doc.theme).toBe('dark');
      expect(doc.model).toBe('opus');
      expect(doc.statusLine).toEqual(buildStatuslineConfig());

      const after = fs.readFileSync(settingsPath, 'utf8');
      const second = wireStatusline({ home, log: () => {} });
      expect(second.action).toBe('written');
      if (second.action === 'written') expect(second.changed).toBe(false);
      // Byte-stable: a re-run leaves settings.json untouched.
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(after);
    });
  });

  // Branch 2: an EXISTING statusLine → setup PRINTS the embed snippet and does
  // NOT modify settings.json.
  it('prints the embed snippet and does NOT modify an existing statusLine', async () => {
    await withTempHomeAsync(async (home) => {
      const settingsPath = settingsJsonPath(home);
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const existing =
        JSON.stringify(
          { statusLine: { type: 'command', command: 'my-custom-statusline' } },
          null,
          2,
        ) + '\n';
      fs.writeFileSync(settingsPath, existing, 'utf8');

      const lines: string[] = [];
      const result = await offerStatuslineWiring({
        home,
        log: (l) => lines.push(l),
        isInteractive: () => true,
        confirm: async () => true,
      });

      expect(result.action).toBe('embed-snippet');
      if (result.action === 'embed-snippet') {
        expect(result.snippet).toBe(statuslineEmbedSnippet());
      }
      // The existing statusLine is untouched (byte-identical).
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(existing);
      // The embed snippet was printed for the user to splice in themselves.
      expect(lines.join('\n')).toContain(statuslineEmbedSnippet());
    });
  });

  // Branch 2b: an UNPARSEABLE settings.json → setup PRINTS the embed snippet and
  // does NOT overwrite the file (no silent data loss of a broken-but-recoverable
  // config).
  it('does NOT overwrite an unparseable settings.json (prints embed snippet)', async () => {
    await withTempHomeAsync(async (home) => {
      const settingsPath = settingsJsonPath(home);
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const broken = '{ "statusLine": not valid json,,, ';
      fs.writeFileSync(settingsPath, broken, 'utf8');

      const lines: string[] = [];
      const result = await offerStatuslineWiring({
        home,
        log: (l) => lines.push(l),
        isInteractive: () => true,
        confirm: async () => true,
      });

      expect(result.action).toBe('embed-snippet');
      // The broken file is left byte-for-byte untouched.
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(broken);
      expect(lines.join('\n')).toContain(statuslineEmbedSnippet());
    });
  });

  // Branch 3: declining the offer → NO change (no settings.json written).
  it('declining the offer makes no change', async () => {
    await withTempHomeAsync(async (home) => {
      const settingsPath = settingsJsonPath(home);

      const result = await offerStatuslineWiring({
        home,
        log: () => {},
        isInteractive: () => true,
        // Decline.
        confirm: async () => false,
      });

      expect(result.action).toBe('declined');
      // No file was created.
      expect(fs.existsSync(settingsPath)).toBe(false);
    });
  });

  // The offer is silently skipped on a non-TTY (never blocks, never writes).
  it('non-TTY skips the offer silently (declined, no write)', async () => {
    await withTempHomeAsync(async (home) => {
      let prompted = false;
      const result = await offerStatuslineWiring({
        home,
        log: () => {},
        isInteractive: () => false,
        confirm: async () => {
          prompted = true;
          return true;
        },
      });

      expect(prompted).toBe(false);
      expect(result.action).toBe('declined');
      expect(fs.existsSync(settingsJsonPath(home))).toBe(false);
    });
  });

  // End-to-end through the Local interactive path: consent wires the statusLine
  // into the temp settings.json alongside the normal local install.
  it('runSetupInteractive Local path offers + wires the statusline on consent', async () => {
    await withTempHomeAsync(async (home) => {
      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        isInteractive: () => true,
        confirmStatusline: async () => true,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.statusline.action).toBe('written');
        const doc = JSON.parse(fs.readFileSync(settingsJsonPath(home), 'utf8'));
        expect(doc.statusLine).toEqual(buildStatuslineConfig());
      }
    });
  });
});
