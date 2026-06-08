import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  runSetupInteractive,
  runRemoteOnboarding,
  selectRemoteOnboardingMethod,
  canUseBrowserSso,
  probeOidcState,
  persistManualPat,
  buildRemoteMcpEntry,
  commandsDestDir,
  type ManualPatPersistResult,
  type OidcProbeResult,
  type RunSetupInteractiveOptions,
} from '../commands/setup.js';
import { getCredentialsPath, resolveAuth, setTokenOverride } from '../auth/credentials.js';
import { resolveAssetPath } from '../../assets/resolve.js';
import { dataDir } from '../../config/paths.js';
import { startDeviceFlowServer } from './helpers/device-flow-server.js';
import { Readable } from 'node:stream';

const tasksSkillsDir = resolveAssetPath('dist', 'skills', 'tasks');

// A FAKE token — never a real secret.
const FAKE_PAT = 'wft_pat_FAKE_TEST_TOKEN_0123456789';
const REMOTE_URL = 'http://tasks.example.local:3000';
// #835: device-flow (browser SSO) only runs for https / localhost URLs. Tests
// that exercise the device-flow path use an https URL; plain-http non-localhost
// URLs (REMOTE_URL) now correctly route to manual-PAT entry instead.
const REMOTE_URL_HTTPS = 'https://tasks.example.com:3000';

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

describe('tasks setup --remote --token (#858: persists a real credential)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    setTokenOverride(null);
    vi.restoreAllMocks();
  });

  /**
   * Sandbox HOME + configDir + an isolated credentials file, run `fn`, tear all
   * down. The credentials path is redirected via WFT_CREDENTIALS_PATH so the
   * test never touches the real ~/.config credentials.
   */
  async function withCredSandbox(
    fn: (ctx: { home: string; configDir: string; credFile: string }) => Promise<void>,
  ): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-home-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cfg-'));
    const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cred-'));
    const credFile = path.join(credDir, 'credentials');
    const prevCred = process.env['WFT_CREDENTIALS_PATH'];
    process.env['WFT_CREDENTIALS_PATH'] = credFile;
    try {
      await fn({ home, configDir, credFile });
    } finally {
      if (prevCred === undefined) delete process.env['WFT_CREDENTIALS_PATH'];
      else process.env['WFT_CREDENTIALS_PATH'] = prevCred;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(credDir, { recursive: true, force: true });
    }
  }

  it('validates the PAT against /api/v1/me, writes credentials, and writes a URL-only MCP entry', async () => {
    await withCredSandbox(async ({ home, configDir, credFile }) => {
      // Mock the identity probe persistManualPat performs.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${REMOTE_URL}/api/v1/me`);
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_PAT}`);
        return new Response(
          JSON.stringify({ id: 42, displayName: 'Remote User', email: 'remote@example.local' }),
          { status: 200 },
        );
      }) as never;

      const result = await runSetupInteractive({
        home,
        configDir,
        log: () => {},
        mode: 'remote',
        remote: REMOTE_URL,
        token: FAKE_PAT,
        // No menu / no prompts on this non-interactive direct path.
        isInteractive: () => false,
      });

      expect(result.mode).toBe('remote');
      if (result.mode !== 'remote') throw new Error('expected remote result');
      expect(result.ok).toBe(true);
      expect(result.method).toBe('manual-pat');

      // (1) The credential is PERSISTED to the credentials file — the bug was
      // that it went to an orphaned cache and nothing read it.
      expect(fs.existsSync(credFile)).toBe(true);
      const credBody = fs.readFileSync(credFile, 'utf8');
      expect(credBody).toContain(FAKE_PAT);
      expect(credBody).toContain('user_id = 42');

      // (2) resolveAuth() yields the token from the FILE (not the --token flag).
      setTokenOverride(null);
      const auth = await resolveAuth();
      expect(auth).toEqual({ kind: 'bearer', token: FAKE_PAT, origin: 'file' });
      // Sanity: the resolver read the sandboxed file we just wrote.
      expect(getCredentialsPath()).toBe(credFile);

      // (3) The claude.json entry is URL-only — the PAT is NEVER embedded.
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
      expect(remoteEntry).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(remoteEntry.env.WFT_API_KEY).toBeUndefined();
      expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).not.toContain(FAKE_PAT);

      // (4) Skills still copied on the remote path.
      const copied = fs
        .readdirSync(commandsDestDir(home))
        .filter((f) => f.endsWith('.md'))
        .sort();
      expect(copied.length).toBeGreaterThan(0);

      // (5) The orphaned PAT cache file is NOT written anywhere under configDir
      // or the data dir (the whole cache path was deleted in #858).
      expect(fs.existsSync(path.join(configDir, 'remote-token'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'remote-token'))).toBe(false);
    });
  });

  it('a rejected PAT (401) writes NO credentials file and NO claude.json entry', async () => {
    await withCredSandbox(async ({ home, configDir, credFile }) => {
      globalThis.fetch = vi.fn(async () => new Response('no', { status: 401 })) as never;

      const result = await runSetupInteractive({
        home,
        configDir,
        log: () => {},
        mode: 'remote',
        remote: REMOTE_URL,
        token: FAKE_PAT,
        isInteractive: () => false,
      });

      expect(result.mode).toBe('remote');
      if (result.mode !== 'remote') throw new Error('expected remote result');
      expect(result.ok).toBe(false);
      // Nothing half-configured: no credentials, no MCP entry.
      expect(fs.existsSync(credFile)).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Task #807 — OIDC-state probe (public /auth/login, #831) + branch selector.
// ---------------------------------------------------------------------------

describe('selectRemoteOnboardingMethod', () => {
  it('routes ready→device-flow, disabled/degraded→manual, probe-failure→manual', () => {
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'ready' })).toBe('device-flow');
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'disabled' })).toBe('manual-pat');
    expect(selectRemoteOnboardingMethod({ ok: true, oidc: 'degraded' })).toBe('manual-pat');
    expect(selectRemoteOnboardingMethod({ ok: false, reason: 'boom' })).toBe('manual-pat');
  });
});

describe('canUseBrowserSso (#835)', () => {
  it('allows https everywhere', () => {
    expect(canUseBrowserSso('https://tasks.example.com')).toBe(true);
    expect(canUseBrowserSso('https://192.168.69.69:3000')).toBe(true);
    expect(canUseBrowserSso('https://tasks.example.com/sub/path')).toBe(true);
  });

  it('allows http ONLY for loopback hosts', () => {
    expect(canUseBrowserSso('http://localhost:3000')).toBe(true);
    expect(canUseBrowserSso('http://127.0.0.1:3000')).toBe(true);
  });

  it('rejects plain-http non-loopback hosts (the Google-SSO blocker)', () => {
    expect(canUseBrowserSso('http://192.168.69.69:3000')).toBe(false);
    expect(canUseBrowserSso('http://tasks.example.com')).toBe(false);
  });

  it('rejects unparseable / non-http(s) input', () => {
    expect(canUseBrowserSso('not a url')).toBe(false);
    expect(canUseBrowserSso('ftp://example.com')).toBe(false);
  });
});

describe('probeOidcState (GET /auth/login — public, unauthenticated)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('probes the PUBLIC /auth/login (not the auth-gated /health/detailed) with manual redirect (#831)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://tasks.example.local:3000/auth/login');
      expect(init?.method ?? 'GET').toBe('GET');
      // Must NOT follow the IdP redirect — only the status matters.
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://idp.example/auth' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeOidcState(REMOTE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 302 → IdP redirect → device-flow available.
    expect(result).toEqual({ ok: true, oidc: 'ready' });
  });

  it('maps a 501 (OIDC-disabled stub) to oidc=disabled → manual PAT', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'oidc_disabled' }), { status: 501 }),
    ) as never;
    const result = await probeOidcState(REMOTE_URL);
    expect(result).toEqual({ ok: true, oidc: 'disabled' });
  });

  it('treats an inconclusive status (e.g. 401/503) as a probe failure → manual PAT', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 }),
    ) as never;
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

describe('runSetupInteractive — Remote menu selection prompts for the base URL', () => {
  // Regression: picking "Remote" from the interactive menu set `mode` but never
  // the base URL (only the `--remote <url>` flag did), so the menu path fell
  // straight into runRemoteOnboarding and threw 'remote onboarding requires a
  // --remote <url> base URL.'. The interactive branch must prompt for the URL.
  it('prompts for the URL when Remote is chosen via the menu (no --remote flag) and uses the typed URL', () => {
    return withSandboxAsync(async (home, configDir) => {
      const PROMPTED_URL = 'https://prompted.example.com:3000';
      // Drive the injected prompt stream: type the base URL + newline.
      const input = Readable.from([`${PROMPTED_URL}\n`]);

      const result = await runSetupInteractive({
        home,
        configDir,
        log: () => {},
        // Simulate the menu resolving to "Remote" with NO --remote flag set.
        selectMode: async () => 'remote',
        isInteractive: () => true,
        // A --token routes to the direct manual-PAT path; stub the persist seam
        // so it succeeds without a live /api/v1/me server. The point under test
        // is that the PROMPTED url threads through to the remote MCP entry.
        token: FAKE_PAT,
        manualPatPersist: async () => ({
          ok: true as const,
          identity: { id: 1, displayName: 'Menu User', email: null },
        }),
        promptIO: { input: input as never, output: { write: () => true } },
      });

      expect(result.mode).toBe('remote');
      // The typed URL — NOT a flag — produced the remote MCP entry.
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(PROMPTED_URL));
    });
  });

  it('end-to-end: menu→prompt URL→device-flow login→working MCP entry (the full interview)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const PROMPTED_URL = 'https://prompted.example.com:3000';
      const input = Readable.from([`${PROMPTED_URL}\n`]);
      // OIDC ready → device-flow path; stub the login so no real browser/server.
      const probeCalls: string[] = [];
      const oidcProbe = async (baseUrl: string): Promise<OidcProbeResult> => {
        probeCalls.push(baseUrl);
        return { ok: true, oidc: 'ready' };
      };
      const deviceLoginCalls: Array<{ baseUrl: string }> = [];
      const deviceLogin = vi.fn(async (opts: { baseUrl: string }) => {
        deviceLoginCalls.push({ baseUrl: opts.baseUrl });
        return { ok: true as const };
      });

      const result = await runSetupInteractive({
        home,
        configDir,
        log: () => {},
        selectMode: async () => 'remote',
        isInteractive: () => true,
        // NO --token: the interview must continue into the device-flow login.
        promptIO: { input: input as never, output: { write: () => true } },
        oidcProbe,
        deviceLogin: deviceLogin as never,
      });

      // The URL the user typed drove BOTH the OIDC probe and the device login,
      // and the interview ended with a working URL-only MCP entry.
      expect(probeCalls).toEqual([PROMPTED_URL]);
      expect(deviceLoginCalls).toEqual([{ baseUrl: PROMPTED_URL }]);
      expect(result).toMatchObject({ mode: 'remote', method: 'device-flow', ok: true });
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(PROMPTED_URL));
    });
  });

  it('does NOT prompt on a non-TTY (programmatic remote with no URL still throws, no hang)', async () => {
    await expect(
      runSetupInteractive({
        log: () => {},
        // Explicit mode (the flag path) so resolution doesn't default to local;
        // non-TTY must skip the URL prompt and fall through to the clear throw.
        mode: 'remote',
        isInteractive: () => false,
      }),
    ).rejects.toThrow('remote onboarding requires a --remote <url> base URL.');
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
        // #835: device flow only runs for https / localhost — use https here.
        remote: REMOTE_URL_HTTPS,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
      });

      // Probe happened BEFORE the onboarding action.
      expect(calls).toEqual([REMOTE_URL_HTTPS]);
      expect(result.method).toBe('device-flow');
      expect(result.oidc).toBe('ready');
      expect(result.ok).toBe(true);
      // Device flow was invoked with the remote base URL; manual path NOT taken.
      expect(deviceLogin).toHaveBeenCalledTimes(1);
      expect(deviceLogin.mock.calls[0]![0]).toMatchObject({ baseUrl: REMOTE_URL_HTTPS });

      // #808: after a successful device login the branch writes the URL-only
      // remote MCP entry (#810). The credentials writer (inside runDeviceLogin)
      // owns PAT persistence — there is NO host token-mint path and NO token in
      // claude.json.
      const claudeJson = path.join(home, '.claude.json');
      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const remoteEntry = doc.mcpServers['wood-fired-tasks-remote'];
      expect(remoteEntry).toEqual(buildRemoteMcpEntry(REMOTE_URL_HTTPS));
      expect(remoteEntry.env.WFT_API_URL).toBe(REMOTE_URL_HTTPS);
      // URL-only: no embedded token of any kind.
      expect(remoteEntry.env.WFT_API_KEY).toBeUndefined();
      expect(JSON.stringify(remoteEntry)).not.toContain(FAKE_PAT);
      expect(result.setup?.serverName).toBe('wood-fired-tasks-remote');
      expect(result.setup?.remote).toBe(true);
      // The device-flow branch does NOT cache a PAT under the config dir — the
      // credentials writer is the single owner of the minted PAT (#858: the
      // orphaned cache path was deleted entirely).
      expect(fs.existsSync(path.join(configDir, 'remote-token'))).toBe(false);
    });
  });

  it('device-flow failure falls back to manual PAT; non-TTY + no token writes nothing (no crash)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'ready' });
      const deviceLogin = vi.fn(async () => ({ ok: false as const }));

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        // https so the device-flow path is reached (then fails → manual).
        remote: REMOTE_URL_HTTPS,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        // Non-TTY, no --token, no env → the manual fallback exits cleanly.
        isInteractive: () => false,
      });

      // #833: a failed device flow now degrades to manual-PAT entry instead of
      // returning a device-flow failure. With no PAT available it ends ok:false
      // and — critically — still persists NOTHING.
      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(false);
      expect(result.setup).toBeUndefined();
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });

  it('#833: device/code that THROWS (e.g. 400 invalid_client) does not crash — falls back to manual PAT', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'ready' });
      // Mirror the real failure: requestDeviceCode throws on a non-200 from
      // /auth/device/code (the invalid_client case that crashed setup).
      const deviceLogin = vi.fn(async () => {
        throw new Error('Failed to start device flow: 400 {"error":"invalid_client"}');
      });
      // Manual PAT supplied so the fallback can complete end-to-end.
      const manualPatPersist = vi.fn(async (baseUrl: string, token: string) => ({
        ok: true as const,
        identity: { id: 7, displayName: 'Fallback User', email: null },
      }));

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        // https so the device-flow path is reached (then throws → manual).
        remote: REMOTE_URL_HTTPS,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
      });

      // Setup did NOT crash; it degraded to manual PAT and finished.
      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(true);
      expect(manualPatPersist).toHaveBeenCalledWith(REMOTE_URL_HTTPS, FAKE_PAT);
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(
        buildRemoteMcpEntry(REMOTE_URL_HTTPS),
      );
    });
  });

  it('#835: oidc=ready but plain-http non-localhost URL → no device login; explains https + falls back to manual PAT', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'ready' });
      const deviceLogin = vi.fn();
      const manualPatPersist = vi.fn(async () => ({
        ok: true as const,
        identity: { id: 7, displayName: 'PAT User', email: null },
      }));
      const logs: string[] = [];

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        // http + non-localhost: Google SSO can't complete here.
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
      });

      // The browser flow was NOT attempted despite oidc=ready…
      expect(deviceLogin).not.toHaveBeenCalled();
      // …the user was told plainly why (https required) and how to mint a PAT…
      const allLogs = logs.join('\n');
      expect(allLogs).toMatch(/https/i);
      expect(allLogs).toContain('tasks db mint-token');
      // …and setup completed via the manual-PAT path.
      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(true);
      expect(manualPatPersist).toHaveBeenCalledWith(REMOTE_URL, FAKE_PAT);
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
        // NOT under any setup config-dir PAT cache (#858 deleted that path).
        expect(fs.existsSync(credFile)).toBe(true);
        expect(fs.readFileSync(credFile, 'utf8')).toContain(FAKE_PAT);
        expect(fs.existsSync(path.join(configDir, 'remote-token'))).toBe(false);

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

  it('oidc=disabled selects manual PAT (uses --token, persists via writeCredentials + URL-only entry)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: true, oidc: 'disabled' });
      const deviceLogin = vi.fn();
      // #809: the manual path persists through the SAME credentials writer the
      // device flow uses. Capture the (baseUrl, token) the branch hands it.
      const persistCalls: Array<[string, string]> = [];
      const manualPatPersist = vi.fn(async (baseUrl: string, token: string) => {
        persistCalls.push([baseUrl, token]);
        return {
          ok: true as const,
          identity: { id: 7, displayName: 'Manual User', email: null },
        } satisfies ManualPatPersistResult;
      });

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
      });

      expect(calls).toEqual([REMOTE_URL]);
      expect(result.method).toBe('manual-pat');
      expect(result.oidc).toBe('disabled');
      expect(result.ok).toBe(true);
      // Device flow NEVER invoked on the disabled branch.
      expect(deviceLogin).not.toHaveBeenCalled();
      // #809: the PAT was persisted via the credentials writer seam, NOT cached
      // under the config dir.
      expect(persistCalls).toEqual([[REMOTE_URL, FAKE_PAT]]);
      expect(result.manualPatIdentity).toEqual({ id: 7, displayName: 'Manual User', email: null });
      expect(fs.existsSync(path.join(configDir, 'remote-token'))).toBe(false);
      // Manual path persisted the SAME URL-only remote MCP entry (#810) the
      // device-flow path writes; the PAT is never embedded in claude.json.
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      expect(doc.mcpServers['wood-fired-tasks-remote'].env.WFT_API_KEY).toBeUndefined();
      expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).not.toContain(FAKE_PAT);
    });
  });

  it('oidc=disabled with no --token prompts for the PAT on a TTY (promptSecret)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const deviceLogin = vi.fn();
      // Drive the injected prompt stream: type the PAT + newline.
      const input = Readable.from([`${FAKE_PAT}\n`]);
      const persistCalls: Array<[string, string]> = [];
      const manualPatPersist = vi.fn(async (baseUrl: string, token: string) => {
        persistCalls.push([baseUrl, token]);
        return {
          ok: true as const,
          identity: { id: 7, displayName: 'Manual User', email: null },
        } satisfies ManualPatPersistResult;
      });

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: () => {},
        remote: REMOTE_URL,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
        isInteractive: () => true,
        promptIO: { input: input as never, output: { write: () => true } },
      });

      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(true);
      expect(deviceLogin).not.toHaveBeenCalled();
      // The prompted PAT was handed to the credentials-writer seam, not cached.
      expect(persistCalls).toEqual([[REMOTE_URL, FAKE_PAT]]);
      // #810: claude.json entry is URL-only — no embedded token.
      const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(doc.mcpServers['wood-fired-tasks-remote'].env.WFT_API_KEY).toBeUndefined();
      expect(fs.existsSync(path.join(configDir, 'remote-token'))).toBe(false);
    });
  });

  it('oidc=disabled on a non-TTY reads the PAT from the WFT_API_KEY env fallback (no hang)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const deviceLogin = vi.fn();
      const persistCalls: Array<[string, string]> = [];
      const manualPatPersist = vi.fn(async (baseUrl: string, token: string) => {
        persistCalls.push([baseUrl, token]);
        return {
          ok: true as const,
          identity: { id: 9, displayName: 'CI Bot', email: null },
        } satisfies ManualPatPersistResult;
      });

      const prev = process.env['WFT_API_KEY'];
      process.env['WFT_API_KEY'] = FAKE_PAT;
      try {
        const result = await runRemoteOnboarding({
          home,
          configDir,
          log: () => {},
          remote: REMOTE_URL,
          // NO --token, NO TTY: must fall back to WFT_API_KEY rather than hang.
          oidcProbe: probe,
          deviceLogin: deviceLogin as never,
          manualPatPersist,
          isInteractive: () => false,
        });

        expect(result.method).toBe('manual-pat');
        expect(result.ok).toBe(true);
        // The env PAT was used and handed to the credentials writer seam.
        expect(persistCalls).toEqual([[REMOTE_URL, FAKE_PAT]]);
        const doc = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
        expect(doc.mcpServers['wood-fired-tasks-remote']).toEqual(buildRemoteMcpEntry(REMOTE_URL));
      } finally {
        if (prev === undefined) delete process.env['WFT_API_KEY'];
        else process.env['WFT_API_KEY'] = prev;
      }
    });
  });

  it('manual path with a rejected PAT writes nothing (no claude.json entry)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const logs: string[] = [];
      const manualPatPersist = vi.fn(
        async () =>
          ({
            ok: false,
            reason: 'the personal access token was rejected (HTTP 401)',
          }) satisfies ManualPatPersistResult,
      );

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        manualPatPersist,
      });

      expect(result.method).toBe('manual-pat');
      expect(result.ok).toBe(false);
      expect(result.setup).toBeUndefined();
      expect(logs.some((l) => /rejected/.test(l))).toBe(true);
      // A rejected PAT leaves no half-configured install.
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    });
  });

  it('oidc=degraded informs then offers manual PAT', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe, calls } = recordingProbe({ ok: true, oidc: 'degraded' });
      const deviceLogin = vi.fn();
      const logs: string[] = [];
      const manualPatPersist = vi.fn(
        async () =>
          ({
            ok: true,
            identity: { id: 7, displayName: 'Manual User', email: null },
          }) satisfies ManualPatPersistResult,
      );

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
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
      const manualPatPersist = vi.fn(
        async () =>
          ({
            ok: true,
            identity: { id: 7, displayName: 'Manual User', email: null },
          }) satisfies ManualPatPersistResult,
      );

      const result = await runRemoteOnboarding({
        home,
        configDir,
        log: (line) => logs.push(line),
        remote: REMOTE_URL,
        token: FAKE_PAT,
        oidcProbe: probe,
        deviceLogin: deviceLogin as never,
        manualPatPersist,
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

  it('manual path with no --token, no env, on a non-TTY returns ok:false with guidance (no hang)', () => {
    return withSandboxAsync(async (home, configDir) => {
      const { probe } = recordingProbe({ ok: true, oidc: 'disabled' });
      const logs: string[] = [];

      // Ensure the documented env fallback is ABSENT so this asserts the
      // "no PAT anywhere" failure rather than silently picking up the env.
      const prev = process.env['WFT_API_KEY'];
      delete process.env['WFT_API_KEY'];
      try {
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
        // Guidance names BOTH documented PAT sources (flag + env fallback).
        expect(logs.some((l) => /--token/.test(l))).toBe(true);
        expect(logs.some((l) => /WFT_API_KEY/.test(l))).toBe(true);
        // Nothing persisted when no token could be obtained.
        expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
      } finally {
        if (prev === undefined) delete process.env['WFT_API_KEY'];
        else process.env['WFT_API_KEY'] = prev;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Task #809 — persistManualPat: validate the PAT against /api/v1/me then
// persist it via the credentials writer.
// ---------------------------------------------------------------------------

describe('persistManualPat (validate + writeCredentials)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function withCredSandbox<T>(fn: () => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-setup-remote-cred-'));
    const credFile = path.join(dir, 'credentials');
    const prev = process.env['WFT_CREDENTIALS_PATH'];
    process.env['WFT_CREDENTIALS_PATH'] = credFile;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env['WFT_CREDENTIALS_PATH'];
        else process.env['WFT_CREDENTIALS_PATH'] = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
  }

  it('GETs /api/v1/me with a Bearer header and writes the credentials file', () => {
    return withCredSandbox(async () => {
      const credFile = process.env['WFT_CREDENTIALS_PATH']!;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('http://tasks.example.local:3000/api/v1/me');
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_PAT}`);
        return new Response(
          JSON.stringify({
            id: 42,
            displayName: 'Manual User',
            email: 'manual@example.local',
            isLegacy: false,
            isServiceAccount: false,
          }),
          { status: 200 },
        );
      }) as never;

      const result = await persistManualPat(REMOTE_URL, FAKE_PAT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity).toEqual({
          id: 42,
          displayName: 'Manual User',
          email: 'manual@example.local',
        });
      }
      // Credentials file written by writeCredentials and contains the PAT.
      expect(fs.existsSync(credFile)).toBe(true);
      const body = fs.readFileSync(credFile, 'utf8');
      expect(body).toContain(FAKE_PAT);
      expect(body).toContain('user_id = 42');
    });
  });

  it('returns ok:false and writes nothing when the PAT is rejected (401)', () => {
    return withCredSandbox(async () => {
      const credFile = process.env['WFT_CREDENTIALS_PATH']!;
      globalThis.fetch = vi.fn(async () => new Response('no', { status: 401 })) as never;

      const result = await persistManualPat(REMOTE_URL, FAKE_PAT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/401/);
      expect(fs.existsSync(credFile)).toBe(false);
    });
  });

  it('returns ok:false on a network error (no credentials written)', () => {
    return withCredSandbox(async () => {
      const credFile = process.env['WFT_CREDENTIALS_PATH']!;
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as never;

      const result = await persistManualPat(REMOTE_URL, FAKE_PAT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/ECONNREFUSED/);
      expect(fs.existsSync(credFile)).toBe(false);
    });
  });
});
