import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  runSetup,
  runRemoteOnboarding,
  selectRemoteOnboardingMethod,
  probeOidcState,
  buildRemoteMcpEntry,
  commandsDestDir,
  patCachePath,
  type OidcProbeResult,
  type RunSetupInteractiveOptions,
} from '../commands/setup.js';
import { resolveAssetPath } from '../../assets/resolve.js';
import { dataDir } from '../../config/paths.js';
import { startDeviceFlowServer } from './helpers/device-flow-server.js';
import { Readable } from 'node:stream';

const tasksSkillsDir = resolveAssetPath('dist', 'skills', 'tasks');

// A FAKE token — never a real secret.
const FAKE_PAT = 'wft_pat_FAKE_TEST_TOKEN_0123456789';
const REMOTE_URL = 'http://tasks.example.local:3000';

function withSandbox<T>(fn: (home: string, configDir: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cfg-'));
  try {
    return fn(home, configDir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

/** Async sandbox: awaits `fn` before tearing down the temp dirs. */
async function withSandboxAsync<T>(
  fn: (home: string, configDir: string) => Promise<T>,
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-home-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cfg-'));
  try {
    return await fn(home, configDir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

describe('tasks setup --remote', () => {
  it('writes a URL-only wood-fired-tasks-remote MCP entry (WFT_API_URL, no token), copies skills, and caches the PAT under the config dir', () => {
    withSandbox((home, configDir) => {
      // Pre-seed an unrelated mcpServer to prove preservation.
      const claudeJson = path.join(home, '.claude.json');
      fs.writeFileSync(
        claudeJson,
        JSON.stringify({ mcpServers: { 'some-other': { type: 'stdio', command: 'x' } } }, null, 2) +
          '\n',
        'utf8',
      );

      const result = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });

      // (1) Remote entry present and correctly shaped.
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      expect(doc.mcpServers['some-other']).toEqual({
        type: 'stdio',
        command: 'x',
      });
      const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
      expect(remoteEntry).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(remoteEntry.type).toBe('stdio');
      expect(remoteEntry.env.WFT_API_URL).toBe(REMOTE_URL);
      // #810: URL-only entry — the token is NEVER persisted in claude.json.
      // The bridge reads it at runtime from the credentials file / WFT_API_KEY.
      expect(remoteEntry.env.WFT_API_KEY).toBeUndefined();
      // The local entry is NOT written in the remote path.
      expect(doc.mcpServers['wood-fired-tasks']).toBeUndefined();
      expect(result.serverName).toBe('wood-fired-tasks-remote');
      expect(result.remote).toBe(true);

      // (2) Skills copied in the remote path too.
      const destDir = commandsDestDir(home);
      const copied = fs
        .readdirSync(destDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const sourceSet = fs
        .readdirSync(tasksSkillsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      expect(copied).toEqual(sourceSet);
      expect(copied.length).toBeGreaterThan(0);

      // (3) PAT cached under the CONFIG dir (NOT the data dir).
      const patPath = patCachePath(configDir);
      expect(result.patCache?.path).toBe(patPath);
      expect(fs.existsSync(patPath)).toBe(true);
      expect(fs.readFileSync(patPath, 'utf8')).toBe(FAKE_PAT);
      // It lives under the injected config dir...
      expect(patPath.startsWith(configDir)).toBe(true);
      // ...and NOT under the real data dir.
      expect(patPath.startsWith(dataDir)).toBe(false);

      // POSIX: file is 0600 (owner-only).
      if (process.platform !== 'win32') {
        const mode = fs.statSync(patPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  it('remote-entry write + PAT cache are idempotent on re-run (no spurious changes)', () => {
    withSandbox((home, configDir) => {
      const first = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });
      expect(first.claudeJsonChanged).toBe(true);
      expect(first.patCache?.changed).toBe(true);

      const claudeJson = path.join(home, '.claude.json');
      const jsonAfterFirst = fs.readFileSync(claudeJson, 'utf8');
      const patPath = patCachePath(configDir);
      const patAfterFirst = fs.readFileSync(patPath, 'utf8');

      const second = runSetup({
        home,
        configDir,
        remote: REMOTE_URL,
        token: FAKE_PAT,
        log: () => {},
      });

      // No second-run write to either artifact.
      expect(second.claudeJsonChanged).toBe(false);
      expect(second.patCache?.changed).toBe(false);
      expect(second.skills.written).toEqual([]);

      // Byte-stable on disk.
      expect(fs.readFileSync(claudeJson, 'utf8')).toBe(jsonAfterFirst);
      expect(fs.readFileSync(patPath, 'utf8')).toBe(patAfterFirst);
    });
  });

  it('--remote without --token throws (cannot author a usable WFT_API_KEY)', () => {
    withSandbox((home, configDir) => {
      expect(() => runSetup({ home, configDir, remote: REMOTE_URL, log: () => {} })).toThrow(
        /--token/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Task #807 — /health/detailed OIDC-state probe + branch selector.
// ---------------------------------------------------------------------------

describe('selectRemoteOnboardingMethod', () => {
  it('routes ready→device-flow, disabled/degraded→manual, probe-failure→manual', () => {
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'ready' })).toBe('device-flow');
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'disabled' })).toBe('manual-pat');
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'degraded' })).toBe('manual-pat');
    expect(selectRemoteOnboardingMethod({ ok: false, reason: 'boom' })).toBe('manual-pat');
  });
});

describe('probeOidcState (GET /health/detailed)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('issues a GET to /health/detailed and reads oidc.state', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://tasks.example.local:3000/health/detailed');
      expect(init?.method ?? 'GET').toBe('GET');
      return new Response(JSON.stringify({ oidc: { state: 'ready' } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeOidcState(REMOTE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, oidc: 'ready' });
  });

  it('treats a non-2xx response as a probe failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as never;
    const result = await probeOidcState(REMOTE_URL);
    expect(result.ok).toBe(false);
  });

  it('treats a network error as a probe failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    const result = await probeOidcState(REMOTE_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ECONNREFUSED/);
  });
});

describe('runRemoteOnboarding — probe + branch matrix (task #807)', () => {
  /** Capture the GET that the probe issues, regardless of branch. */
  function recordingProbe(oidc: OidcProbeResult): {
    probe: NonNullable<RunSetupInteractiveOptions['oidcProbe']>;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      probe: async (baseUrl: string) => {
        calls.push(baseUrl);
        return oidc;
      },
    };
  }

  it('oidc=ready selects the device-flow path (runDeviceLogin) and writes a URL-only entry (#808)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: true, oidc: 'ready' });
      const deviceLogin = vi.fn(async () => ({ ok: true as const, user: undefined as never }));

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      // Probe happened BEFORE the onboarding action.
      expect(calls).toEqual([REMOTE_URL]);
      expect(result.method).toBe('device-flow');
      expect(result.oidc).toBe('ready');
      expect(result.ok).toBe(true);
      // Device flow was invoked with the remote base URL; manual path NOT taken.
      expect(deviceLogin).toHaveBeenCalledTimes(1);
      expect(deviceLogin.mock.calls[0]![0]).toMatchObject({ baseUrl: REMOTE_URL });

      // #808: after a successful device login the branch writes the URL-only
      // remote MCP entry (#810). The credentials writer (inside runDeviceLogin)
      // owns PAT persistence — there is NO host token-mint path and NO token in
      // claude.json.
      const claudeJson = path.join(home, '.claude.json');
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
      expect(remoteEntry).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(remoteEntry.env.WFT_API_URL).toBe(REMOTE_URL);
      // URL-only: no embedded token of any kind.
      expect(remoteEntry.env.WFT_API_KEY).toBeUndefined();
      expect(JSON.stringify(remoteEntry)).not.toContain(FAKE_PAT);
      expect(result.setup?.serverName).toBe('wood-fired-tasks-remote');
      expect(result.setup?.remote).toBe(true);
      // The device-flow branch does NOT double-cache a PAT under the config dir
      // (the credentials writer is the single owner of the minted PAT).
      expect(result.setup?.patCache).toBeUndefined();
      expect(fs.existsSync(patCachePath(configDir))).toBe(false);
    });
  });

  it('device-flow failure writes nothing (no claude.json entry)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'ready' });
      const deviceLogin = vi.fn(async () => ({ ok: false as const }));

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      expect(result.method).toBe('device-flow');
      expect(result.ok).toBe(false);
      expect(result.setup).toBeUndefined();
      // Nothing persisted when the device flow fails.
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });

  it('oidc=ready drives the real device flow against the mock device-flow server', async () => {
    const credPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cred-'));
    const credFile = path.join(credPath, 'credentials');
    const prevCred = process.env['WFT_CREDENTIALS_PATH'];
    process.env['WFT_CREDENTIALS_PATH'] = credFile;

    const server = await startDeviceFlowServer({
      tokenResponses: [
        {
          status: 200,
          body: {
            token: FAKE_PAT,
            token_type: 'PAT',
            token_id: 1,
            user: {
              id: 1,
              displayName: 'Test User',
              email: null,
              isLegacy: false,
              isServiceAccount: false,
            },
          },
        },
      ],
    });

    try {
      await withSandboxAsync(async (home, configDir) => {
        const { probe } = recordingProbe({ ok: true, oidc: 'ready' });
        const result = await runRemoteOnboarding({
          home,
          configDir,
          log: () => {},
          remote: server.baseUrl,
          oidcProbe: probe,
        });
        expect(result.method).toBe('device-flow');
        expect(result.ok).toBe(true);
        // The device flow POSTed to /code and /token on the mock server.
        const reqs = server.getRequests();
        expect(reqs.code.length).toBeGreaterThan(0);
        expect(reqs.token.length).toBeGreaterThan(0);
        // The provisioned PAT is persisted via the credentials writer (#806),
        // NOT under the setup config-dir PAT cache (which stays empty here).
        expect(fs.existsSync(credFile)).toBe(true);
        expect(fs.readFileSync(credFile, 'utf8')).toContain(FAKE_PAT);
        expect(fs.existsSync(patCachePath(configDir))).toBe(false);

        // #808/#810: the claude.json entry written by the device-flow branch is
        // URL-only — it carries WFT_API_URL and embeds NO token.
        const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
        const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
        expect(remoteEntry).toEqual(buildRemoteMcpEntry(server.baseUrl));
        expect(remoteEntry.env.WFT_API_URL).toBe(server.baseUrl);
        expect(remoteEntry.env.WFT_API_KEY).toBeUndefined();
        // The minted PAT never lands in claude.json.
        expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).not.toContain(FAKE_PAT);
      });
    } finally {
      // The CLI's `fetch` poll leaves a pooled keep-alive socket open; Fastify's
      // graceful close would block on it. Race the close against a short timer so
      // teardown never hangs the suite (the OS reclaims the port regardless).
      await Promise.race([server.close(), new Promise((r) => setTimeout(r, 250))]);
      if (prevCred === undefined) delete process.env['WFT_CREDENTIALS_PATH'];
      else process.env['WFT_CREDENTIALS_PATH'] = prevCred;
      fs.rmSync(credPath, { recursive: true, force: true });
    }
  });

  it('oidc=disabled selects manual PAT (uses --token, persists remote entry)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: true, oidc: 'disabled' });
      const deviceLogin = vi.fn();

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      expect(calls).toEqual([REMOTE_URL]);
      expect(result.method).toBe('manual-pat');
      expect(result.oidc).toBe('disabled');
      expect(result.ok).toBe(true);
      // Device flow NEVER invoked on the disabled branch.
      expect(deviceLogin).not.toHaveBeenCalled();
      // Manual path persisted the URL-only remote MCP entry (#810); the PAT
      // is cached separately, never embedded in claude.json.
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(result.setup?.patCache?.path).toBe(patCachePath(configDir));
    });
  });

  it('oidc=disabled with no --token prompts for the PAT on a TTY (promptSecret)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const deviceLogin = vi.fn();
      // Drive the injected prompt stream: type the PAT + newline.
      const input = Readable.from([`${FAKE_PAT}\n`]);

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        isInteractive: () => true,
        promptIO: { input: input as never, output: { write: () => true } },
      });

      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(true);
      expect(deviceLogin).not.toHaveBeenCalled();
      // #810: the prompted PAT is cached to the config-dir file, NOT embedded
      // in claude.json (the entry is URL-only).
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote'].env.WFT_API_KEY).toBeUndefined();
      expect(fs.readFileSync(patCachePath(configDir), 'utf8')).toBe(FAKE_PAT);
    });
  });

  it('oidc=degraded informs then offers manual PAT', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: true, oidc: 'degraded' });
      const deviceLogin = vi.fn();
      const logs: string[] = [];

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      expect(calls).toEqual([REMOTE_URL]);
      expect(result.method).toBe('manual-pat');
      expect(result.oidc).toBe('degraded');
      expect(result.ok).toBe(true);
      expect(deviceLogin).not.toHaveBeenCalled();
      // User was informed about the degraded state before the manual offer.
      expect(logs.some((l) => /degraded/i.test(l))).toBe(true);
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toBeDefined();
    });
  });

  it('probe failure falls back to manual PAT entry', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: false, reason: 'ECONNREFUSED' });
      const deviceLogin = vi.fn();
      const logs: string[] = [];

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      expect(calls).toEqual([REMOTE_URL]);
      expect(result.method).toBe('manual-pat');
      expect(result.oidc).toBeNull();
      expect(result.ok).toBe(true);
      expect(deviceLogin).not.toHaveBeenCalled();
      // The failure reason was surfaced before falling back.
      expect(logs.some((l) => /ECONNREFUSED/.test(l))).toBe(true);
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toBeDefined();
    });
  });

  it('manual path with no --token on a non-TTY returns ok:false with guidance', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const logs: string[] = [];

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        oidcProbe: probe,
        isInteractive: () => false,
      });

      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(false);
      expect(logs.some((l) => /--token/.test(l))).toBe(true);
      // Nothing persisted when no token could be obtained.
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });
});
