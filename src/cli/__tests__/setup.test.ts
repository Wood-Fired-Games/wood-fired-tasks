import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import {
  runSetup,
  runSetupInteractive,
  fixNpmPrefix,
  buildLocalMcpEntry,
  buildRemoteMcpEntry,
  writeRemoteMcpEntryOnly,
  resolveMcpEntryPoint,
  commandsDestDir,
  agentsDestDir,
  settingsJsonPath,
  buildStatuslineConfig,
  statuslineEmbedSnippet,
  wireStatusline,
  offerStatuslineWiring,
  isLoopbackServerUrl,
  type SetupMode,
} from '../commands/setup.js';
import { buildNpmInvocation } from '../util/npm-spawn.js';
import { resolveAssetPath, packageRoot } from '../../assets/resolve.js';
import { writeCredentials } from '../auth/credentials.js';
import Database from '../../db/driver.js';

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

    // Stronger runtime proof: changing cwd must not change the resolved path.
    // process.chdir() throws inside worker_threads, and Stryker's vitest runner
    // forces pool:'threads' for its mutation dry run (task #823) — so this extra
    // check only runs under the forks pool used by normal `npm test` (main
    // thread). The structural assertions above (arg0 starts with packageRoot,
    // equals resolveAssetPath(...)) already prove resolver-origin without chdir,
    // so the test still fully covers setup.ts under mutation.
    if (isMainThread) {
      const origCwd = process.cwd();
      try {
        process.chdir(os.tmpdir());
        // Same absolute path regardless of cwd — i.e. NOT cwd-relative.
        expect(resolveMcpEntryPoint()).toBe(arg0);
        expect(buildLocalMcpEntry().args?.[0]).toBe(arg0);
      } finally {
        process.chdir(origCwd);
      }
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

/**
 * Sandbox seams for the Local path's conversion-contract steps: the
 * stale-remote-credentials reconcile and the eager DB bootstrap both default to
 * REAL machine paths (`getCredentialsPath()` / the unified DB resolver), so
 * every test that drives runSetupInteractive into the Local branch must pin
 * both under the temp home — never the developer's real ~/.config or app-data.
 */
function localSandboxOpts(home: string): {
  credentialsPath: string;
  dbEnv: NodeJS.ProcessEnv;
} {
  return {
    credentialsPath: path.join(home, 'wft-credentials'),
    dbEnv: { DATABASE_PATH: path.join(home, 'wft-sandbox-tasks.db') },
  };
}

describe('tasks setup — modes (task #805)', () => {
  it('no args on a simulated TTY presents the Local/Service/Remote menu', async () => {
    await withTempHomeAsync(async (home) => {
      const presented: ReadonlyArray<{ label: string; value: SetupMode }>[] = [];
      const result = await runSetupInteractive({
        home,
        log: () => {},
        ...localSandboxOpts(home),
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
        ...localSandboxOpts(home),
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

  it('--remote --token runs the Remote path without prompting and PERSISTS the credential (#858)', async () => {
    await withTempHomeAsync(async (home) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-mode-cfg-'));
      try {
        let prompted = false;
        // An explicit --remote + --token is the NON-INTERACTIVE direct manual-PAT
        // path. It SKIPS the OIDC probe (we already have a PAT) but MUST still
        // validate + persist the credential — the #858 bug was that it persisted
        // nothing, writing an orphaned cache instead. Inject the persist seam to
        // prove the credential write happens; the probe must stay untouched.
        const probeSpy = vi.fn(async () => ({ ok: true, oidc: 'disabled' as const }));
        const persistSpy = vi.fn(async () => ({
          ok: true as const,
          identity: { id: 1, displayName: 'Test User', email: null },
        }));
        const result = await runSetupInteractive({
          home,
          configDir,
          log: () => {},
          mode: 'remote',
          remote: 'http://tasks.example.local:3000',
          token: FAKE_PAT,
          oidcProbe: probeSpy,
          manualPatPersist: persistSpy,
          isInteractive: () => {
            prompted = true;
            return true;
          },
          selectMode: async () => {
            prompted = true;
            return 'local';
          },
        });

        // The mode menu was never consulted (mode was explicit), and the direct
        // --token path skips the OIDC probe...
        expect(prompted).toBe(false);
        expect(probeSpy).not.toHaveBeenCalled();
        // ...but it DOES validate + persist the PAT (the fix).
        expect(persistSpy).toHaveBeenCalledWith('http://tasks.example.local:3000', FAKE_PAT);
        expect(result.mode).toBe('remote');
        if (result.mode === 'remote') {
          expect(result.method).toBe('manual-pat');
          expect(result.ok).toBe(true);
          expect(result.manualPatIdentity).toEqual({
            id: 1,
            displayName: 'Test User',
            email: null,
          });
          expect(result.setup?.remote).toBe(true);
          const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
          const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
          expect(remoteEntry).toBeDefined();
          // #810: the PAT is in the credentials file, never in claude.json.
          expect(remoteEntry.env?.WFT_API_KEY).toBeUndefined();
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
        ...localSandboxOpts(home),
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
        ...localSandboxOpts(home),
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

describe('tasks setup — mode conversion (remote⇄local)', () => {
  const REMOTE_URL = 'http://tasks.example.local:3000';
  const FOREIGN_ENTRY = { type: 'stdio', command: 'x' };

  /** Seed a valid 0600 credentials TOML pointing at `server`. */
  function seedCredentials(credFile: string, server: string): void {
    writeCredentials(
      {
        active: {
          token: FAKE_PAT,
          token_id: 1,
          server,
          user_id: 1,
          display_name: 'Test User',
          email: null,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
      credFile,
    );
  }

  /** Seed ~/.claude.json with a foreign server plus the given wft entries. */
  function seedClaudeJson(home: string, wftEntries: Record<string, unknown>): string {
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify(
        { numStartups: 3, mcpServers: { 'some-other': FOREIGN_ENTRY, ...wftEntries } },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    return claudeJson;
  }

  it('remote→local leaves exactly the local entry (foreign keys preserved)', async () => {
    await withTempHomeAsync(async (home) => {
      const claudeJson = seedClaudeJson(home, {
        'wood-fired-tasks-remote': buildRemoteMcpEntry(REMOTE_URL),
      });

      const lines: string[] = [];
      const result = await runSetupInteractive({
        home,
        log: (l) => lines.push(l),
        mode: 'local',
        ...localSandboxOpts(home),
        isInteractive: () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.staleEntryRemoved).toBe(true);
      }
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      // EXACTLY the local entry remains (plus the preserved foreign key).
      expect(Object.keys(doc.mcpServers).sort()).toEqual(['some-other', 'wood-fired-tasks']);
      expect(doc.mcpServers['wood-fired-tasks']).toEqual(buildLocalMcpEntry());
      expect(doc.mcpServers['some-other']).toEqual(FOREIGN_ENTRY);
      // Non-mcpServers content preserved.
      expect(doc.numStartups).toBe(3);
      // The conversion is announced.
      const joined = lines.join('\n');
      expect(joined).toContain("Removed remote MCP entry ('wood-fired-tasks-remote')");
      expect(joined).toContain('install converted to local');
    });
  });

  it('local→remote leaves exactly the remote entry (foreign keys preserved)', () => {
    withTempHome((home) => {
      const claudeJson = seedClaudeJson(home, { 'wood-fired-tasks': buildLocalMcpEntry() });

      const lines: string[] = [];
      const result = writeRemoteMcpEntryOnly({
        home,
        log: (l) => lines.push(l),
        remote: REMOTE_URL,
      });

      expect(result.staleEntryRemoved).toBe(true);
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      expect(Object.keys(doc.mcpServers).sort()).toEqual(['some-other', 'wood-fired-tasks-remote']);
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(doc.mcpServers['some-other']).toEqual(FOREIGN_ENTRY);
      expect(doc.numStartups).toBe(3);
      const joined = lines.join('\n');
      expect(joined).toContain("Removed local MCP entry ('wood-fired-tasks')");
      expect(joined).toContain('install converted to remote');
    });
  });

  it('re-running the same mode is byte-idempotent (no backup churn from the remove)', () => {
    withTempHome((home) => {
      const claudeJson = seedClaudeJson(home, {
        'wood-fired-tasks-remote': buildRemoteMcpEntry(REMOTE_URL),
      });
      const bakPath = `${claudeJson}.bak`;

      const first = runSetup({ home, log: () => {} });
      expect(first.claudeJsonChanged).toBe(true);
      expect(first.staleEntryRemoved).toBe(true);
      const bytes = fs.readFileSync(claudeJson, 'utf8');
      expect(fs.existsSync(bakPath)).toBe(true);
      const bakBytes = fs.readFileSync(bakPath, 'utf8');
      const bakMtime = fs.statSync(bakPath).mtimeMs;

      const second = runSetup({ home, log: () => {} });
      // Second run: merge is unchanged AND the remove is a strict no-op — no
      // write, no .bak churn, byte-identical file.
      expect(second.claudeJsonChanged).toBe(false);
      expect(second.staleEntryRemoved).toBe(false);
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(bytes);
      expect(fs.readFileSync(bakPath, 'utf8')).toBe(bakBytes);
      expect(fs.statSync(bakPath).mtimeMs).toBe(bakMtime);
      expect(fs.existsSync(`${claudeJson}.tmp`)).toBe(false);
    });
  });

  it('remote→local with non-loopback credentials: interactive accept deletes them', async () => {
    const { PassThrough } = await import('node:stream');
    await withTempHomeAsync(async (home) => {
      const sandbox = localSandboxOpts(home);
      seedCredentials(sandbox.credentialsPath, REMOTE_URL);

      const input = new PassThrough();
      const outChunks: string[] = [];
      const output = { write: (s: string) => (outChunks.push(s), true) };
      // Bare Enter takes the [Y/n] default: yes.
      input.write('\n');

      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        ...sandbox,
        isInteractive: () => true,
        promptIO: { input, output },
        confirmStatusline: async () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.staleCredentials.action).toBe('deleted');
        expect(result.staleCredentials.server).toBe(REMOTE_URL);
      }
      expect(outChunks.join('')).toContain(
        `Remote credentials for ${REMOTE_URL} found — remove them? [Y/n]`,
      );
      // The credentials file is gone.
      expect(fs.existsSync(sandbox.credentialsPath)).toBe(false);
    });
  });

  it('remote→local with non-loopback credentials: declining keeps them', async () => {
    const { PassThrough } = await import('node:stream');
    await withTempHomeAsync(async (home) => {
      const sandbox = localSandboxOpts(home);
      seedCredentials(sandbox.credentialsPath, REMOTE_URL);

      const input = new PassThrough();
      input.write('n\n');

      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        ...sandbox,
        isInteractive: () => true,
        promptIO: { input, output: { write: () => true } },
        confirmStatusline: async () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.staleCredentials.action).toBe('kept');
      }
      expect(fs.existsSync(sandbox.credentialsPath)).toBe(true);
    });
  });

  it('remote→local with non-loopback credentials: --no-input warns and keeps the file', async () => {
    await withTempHomeAsync(async (home) => {
      const sandbox = localSandboxOpts(home);
      seedCredentials(sandbox.credentialsPath, REMOTE_URL);
      const bytesBefore = fs.readFileSync(sandbox.credentialsPath, 'utf8');

      const lines: string[] = [];
      const result = await runSetupInteractive({
        home,
        log: (l) => lines.push(l),
        mode: 'local',
        ...sandbox,
        // --no-input / non-TTY: NEVER delete silently.
        isInteractive: () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.staleCredentials.action).toBe('warned');
      }
      // File intact, byte for byte.
      expect(fs.readFileSync(sandbox.credentialsPath, 'utf8')).toBe(bytesBefore);
      // The warning names the path, the stale server, and the remedy.
      const joined = lines.join('\n');
      expect(joined).toContain('WARNING');
      expect(joined).toContain(sandbox.credentialsPath);
      expect(joined).toContain(REMOTE_URL);
      expect(joined).toContain('tasks logout');
    });
  });

  it('remote→local with loopback-server credentials: untouched, no prompt', async () => {
    const { PassThrough } = await import('node:stream');
    await withTempHomeAsync(async (home) => {
      const sandbox = localSandboxOpts(home);
      const loopbackUrl = 'http://127.0.0.1:3000';
      seedCredentials(sandbox.credentialsPath, loopbackUrl);

      // An input stream with NO data: if the reconcile wrongly prompted, the
      // await would hang and the test would time out.
      const input = new PassThrough();
      const outChunks: string[] = [];
      const output = { write: (s: string) => (outChunks.push(s), true) };

      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        ...sandbox,
        isInteractive: () => true,
        promptIO: { input, output },
        confirmStatusline: async () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.staleCredentials.action).toBe('kept-loopback');
        expect(result.staleCredentials.server).toBe(loopbackUrl);
      }
      // No removal prompt was rendered and the file is untouched.
      expect(outChunks.join('')).not.toContain('remove them?');
      expect(fs.existsSync(sandbox.credentialsPath)).toBe(true);
    });
  });

  it('classifies loopback vs non-loopback server URLs', () => {
    expect(isLoopbackServerUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackServerUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackServerUrl('http://[::1]:3000')).toBe(true);
    expect(isLoopbackServerUrl('http://tasks.example.local:3000')).toBe(false);
    expect(isLoopbackServerUrl('https://tasks.example.com')).toBe(false);
    // Unparseable → treated as non-loopback (stale junk worth surfacing).
    expect(isLoopbackServerUrl('not a url')).toBe(false);
  });

  it('local setup creates + migrates the DB at the resolved path, idempotently', async () => {
    await withTempHomeAsync(async (home) => {
      const dbPath = path.join(home, 'db', 'tasks.db');
      const opts = {
        home,
        log: () => {},
        mode: 'local' as const,
        credentialsPath: path.join(home, 'wft-credentials'),
        dbEnv: { DATABASE_PATH: dbPath },
        isInteractive: () => false,
      };

      const result = await runSetupInteractive(opts);
      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.db.ok).toBe(true);
        expect(result.db.dbPath).toBe(dbPath);
      }
      // The DB file exists and the migrations table is populated.
      expect(fs.existsSync(dbPath)).toBe(true);
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
        name: string;
      }[];
      db.close();
      expect(rows.length).toBeGreaterThan(0);

      // Idempotent on a second run: same migration set, no failure.
      const second = await runSetupInteractive(opts);
      expect(second.mode).toBe('local');
      if (second.mode === 'local') {
        expect(second.db.ok).toBe(true);
        expect(second.db.dbPath).toBe(dbPath);
      }
      const db2 = new Database(dbPath, { readonly: true });
      const rows2 = db2.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
        name: string;
      }[];
      db2.close();
      expect(rows2).toEqual(rows);
    });
  });

  it('honours the deprecated DB_PATH alias for the eager DB bootstrap', async () => {
    await withTempHomeAsync(async (home) => {
      const dbPath = path.join(home, 'alias', 'tasks.db');
      const result = await runSetupInteractive({
        home,
        log: () => {},
        mode: 'local',
        credentialsPath: path.join(home, 'wft-credentials'),
        dbEnv: { DB_PATH: dbPath },
        isInteractive: () => false,
      });

      expect(result.mode).toBe('local');
      if (result.mode === 'local') {
        expect(result.db.ok).toBe(true);
        expect(result.db.dbPath).toBe(dbPath);
      }
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });
});
