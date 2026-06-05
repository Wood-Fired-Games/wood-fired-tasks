import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  LinuxSystemdBackend,
  MacLaunchdBackend,
  WindowsScheduledTaskBackend,
  getServiceBackend,
  defaultRunner,
  SERVICE_NAME,
  SERVICE_UNIT_NAME,
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_NAME,
  WINDOWS_TASK_NAME,
  type CommandRunner,
} from '../service.js';

/** Recording elevation helper. Tracks whether the `--system` path invoked it. */
function recordingElevatedRunner(responses: Record<string, string> = {}): {
  runner: CommandRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  return recordingRunner(responses);
}

function withTempConfigBase<T>(fn: (base: string) => T): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-service-cfg-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function withTempBase<T>(prefix: string, fn: (base: string) => T): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const ELEVATION = ['sudo', 'runas', 'pkexec', 'doas'];

/** Build a recording runner with scripted stdout responses keyed by argv. */
function recordingRunner(responses: Record<string, string> = {}): {
  runner: CommandRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    return responses[args.join(' ')] ?? '';
  };
  return { runner, calls };
}

describe('tasks service — Linux systemd --user backend', () => {
  it('install writes a systemctl --user unit and NEVER elevates', () => {
    withTempConfigBase((configBase) => {
      const { runner, calls } = recordingRunner();
      const backend = new LinuxSystemdBackend({
        configBase,
        runner,
        cliEntryPoint: '/opt/wft/dist/cli/bin/tasks.js',
        nodeBin: '/usr/bin/node',
        log: () => {},
      });

      backend.install();

      // Unit file written under <base>/systemd/user/.
      const unitPath = path.join(
        configBase,
        'systemd',
        'user',
        SERVICE_UNIT_NAME
      );
      expect(fs.existsSync(unitPath)).toBe(true);
      const unit = fs.readFileSync(unitPath, 'utf8');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      // ExecStart runs the installed CLI `serve` subcommand.
      expect(unit).toContain(
        'ExecStart=/usr/bin/node /opt/wft/dist/cli/bin/tasks.js serve'
      );

      // Runner driven with exact `systemctl --user` argv.
      expect(calls).toEqual([
        { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
        { cmd: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_NAME] },
      ]);

      // Hard assertion: no elevated command anywhere.
      for (const { cmd } of calls) {
        expect(ELEVATION).not.toContain(cmd.toLowerCase());
      }
      const haystack = JSON.stringify(calls).toLowerCase();
      for (const banned of ELEVATION) {
        expect(haystack).not.toContain(banned);
      }
    });
  });

  it('uninstall disables --now and removes the unit, never elevating', () => {
    withTempConfigBase((configBase) => {
      const { runner, calls } = recordingRunner();
      const backend = new LinuxSystemdBackend({
        configBase,
        runner,
        log: () => {},
      });

      // Seed an installed unit first.
      backend.install();
      expect(fs.existsSync(backend.unitPath)).toBe(true);

      calls.length = 0;
      backend.uninstall();

      expect(fs.existsSync(backend.unitPath)).toBe(false);
      expect(calls).toEqual([
        { cmd: 'systemctl', args: ['--user', 'disable', '--now', SERVICE_NAME] },
        { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      ]);
      for (const { cmd } of calls) {
        expect(ELEVATION).not.toContain(cmd.toLowerCase());
      }
    });
  });

  it('status returns a structured running/stopped result', () => {
    withTempConfigBase((configBase) => {
      const { runner, calls } = recordingRunner({
        '--user is-active wood-fired-tasks': 'active',
        '--user is-enabled wood-fired-tasks': 'enabled',
      });
      const backend = new LinuxSystemdBackend({
        configBase,
        runner,
        log: () => {},
      });
      backend.install();
      calls.length = 0;

      const status = backend.status();
      expect(status).toEqual({
        running: true,
        enabled: true,
        activeState: 'active',
        enabledState: 'enabled',
        installed: true,
      });
      expect(calls).toEqual([
        { cmd: 'systemctl', args: ['--user', 'is-active', SERVICE_NAME] },
        { cmd: 'systemctl', args: ['--user', 'is-enabled', SERVICE_NAME] },
      ]);
    });
  });

  it('status reports stopped/disabled when systemctl says so', () => {
    withTempConfigBase((configBase) => {
      const { runner } = recordingRunner({
        '--user is-active wood-fired-tasks': 'inactive',
        '--user is-enabled wood-fired-tasks': 'disabled',
      });
      const backend = new LinuxSystemdBackend({
        configBase,
        runner,
        log: () => {},
      });
      // No install -> not on disk.
      const status = backend.status();
      expect(status.running).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.activeState).toBe('inactive');
      expect(status.enabledState).toBe('disabled');
      expect(status.installed).toBe(false);
    });
  });
});

describe('getServiceBackend dispatch seam', () => {
  it("returns the Linux backend for 'linux'", () => {
    expect(getServiceBackend('linux')).toBeInstanceOf(LinuxSystemdBackend);
  });

  it("returns the macOS launchd backend for 'darwin'", () => {
    expect(getServiceBackend('darwin')).toBeInstanceOf(MacLaunchdBackend);
  });

  it("returns the Windows scheduled-task backend for 'win32'", () => {
    expect(getServiceBackend('win32')).toBeInstanceOf(
      WindowsScheduledTaskBackend
    );
  });

  it('still throws for an unsupported platform', () => {
    expect(() => getServiceBackend('aix' as NodeJS.Platform)).toThrowError(
      /not yet implemented on 'aix'/
    );
  });
});

describe('tasks service — macOS launchd LaunchAgent backend', () => {
  it('install writes a per-user plist and NEVER elevates', () => {
    withTempBase('wft-service-mac-', (launchAgentsBase) => {
      const { runner, calls } = recordingRunner();
      const backend = new MacLaunchdBackend({
        launchAgentsBase,
        runner,
        cliEntryPoint: '/opt/wft/dist/cli/bin/tasks.js',
        nodeBin: '/usr/bin/node',
        log: () => {},
      });

      backend.install();

      // Plist written under the injected user LaunchAgents dir.
      const plistPath = path.join(launchAgentsBase, LAUNCHD_PLIST_NAME);
      expect(fs.existsSync(plistPath)).toBe(true);
      const plist = fs.readFileSync(plistPath, 'utf8');
      expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
      expect(plist).toContain('<key>ProgramArguments</key>');
      // ProgramArguments runs the CLI `serve` subcommand.
      expect(plist).toContain('<string>/usr/bin/node</string>');
      expect(plist).toContain(
        '<string>/opt/wft/dist/cli/bin/tasks.js</string>'
      );
      expect(plist).toContain('<string>serve</string>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');

      // Driven via launchctl in the user (GUI) domain — load -w, no sudo.
      expect(calls).toEqual([
        { cmd: 'launchctl', args: ['load', '-w', plistPath] },
      ]);

      // Hard assertion: no elevated command anywhere.
      for (const { cmd } of calls) {
        expect(ELEVATION).not.toContain(cmd.toLowerCase());
      }
      const haystack = JSON.stringify(calls).toLowerCase();
      for (const banned of ELEVATION) {
        expect(haystack).not.toContain(banned);
      }
    });
  });

  it('uninstall unloads and removes the plist, never elevating', () => {
    withTempBase('wft-service-mac-', (launchAgentsBase) => {
      const { runner, calls } = recordingRunner();
      const backend = new MacLaunchdBackend({
        launchAgentsBase,
        runner,
        log: () => {},
      });

      backend.install();
      expect(fs.existsSync(backend.plistPath)).toBe(true);

      calls.length = 0;
      backend.uninstall();

      expect(fs.existsSync(backend.plistPath)).toBe(false);
      expect(calls).toEqual([
        { cmd: 'launchctl', args: ['unload', '-w', backend.plistPath] },
      ]);
      for (const { cmd } of calls) {
        expect(ELEVATION).not.toContain(cmd.toLowerCase());
      }
    });
  });

  it('status reports running when launchctl list shows a PID', () => {
    withTempBase('wft-service-mac-', (launchAgentsBase) => {
      const plistPath = path.join(launchAgentsBase, LAUNCHD_PLIST_NAME);
      const { runner, calls } = recordingRunner({
        [`list ${LAUNCHD_LABEL}`]: '{\n\t"PID" = 4242;\n}',
      });
      const backend = new MacLaunchdBackend({
        launchAgentsBase,
        runner,
        log: () => {},
      });
      backend.install();
      calls.length = 0;

      const status = backend.status();
      expect(status.running).toBe(true);
      expect(status.enabled).toBe(true);
      expect(status.activeState).toBe('running');
      expect(status.enabledState).toBe('enabled');
      expect(status.installed).toBe(true);
      expect(calls).toEqual([
        { cmd: 'launchctl', args: ['list', LAUNCHD_LABEL] },
      ]);
      expect(plistPath).toBe(backend.plistPath);
    });
  });

  it('status reports not-loaded when launchctl list is empty and no plist', () => {
    withTempBase('wft-service-mac-', (launchAgentsBase) => {
      const { runner } = recordingRunner();
      const backend = new MacLaunchdBackend({
        launchAgentsBase,
        runner,
        log: () => {},
      });
      const status = backend.status();
      expect(status.running).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.activeState).toBe('not-loaded');
      expect(status.enabledState).toBe('disabled');
      expect(status.installed).toBe(false);
    });
  });
});

describe('tasks service — Windows per-user Scheduled Task backend', () => {
  it('install builds an at-logon per-user schtasks with NO /RU SYSTEM and NO elevation', () => {
    const { runner, calls } = recordingRunner();
    const backend = new WindowsScheduledTaskBackend({
      runner,
      cliEntryPoint: 'C:\\wft\\dist\\cli\\bin\\tasks.js',
      nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
      log: () => {},
    });

    backend.install();

    const expectedTr =
      'C:\\Program Files\\nodejs\\node.exe C:\\wft\\dist\\cli\\bin\\tasks.js serve';
    expect(calls).toEqual([
      {
        cmd: 'schtasks',
        args: [
          '/Create',
          '/SC',
          'ONLOGON',
          '/TN',
          WINDOWS_TASK_NAME,
          '/TR',
          expectedTr,
          '/F',
        ],
      },
    ]);

    // No SYSTEM run-as, no elevation anywhere in the argv.
    const haystack = JSON.stringify(calls);
    expect(haystack).not.toContain('/RU');
    expect(haystack.toUpperCase()).not.toContain('SYSTEM');
    for (const { cmd } of calls) {
      expect(ELEVATION).not.toContain(cmd.toLowerCase());
    }
    for (const banned of ELEVATION) {
      expect(haystack.toLowerCase()).not.toContain(banned);
    }
  });

  it('uninstall deletes the per-user task with /F, never elevating', () => {
    const { runner, calls } = recordingRunner();
    const backend = new WindowsScheduledTaskBackend({ runner, log: () => {} });

    backend.uninstall();

    expect(calls).toEqual([
      {
        cmd: 'schtasks',
        args: ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'],
      },
    ]);
    for (const { cmd } of calls) {
      expect(ELEVATION).not.toContain(cmd.toLowerCase());
    }
  });

  it('status parses a Running query into a structured result', () => {
    const { runner, calls } = recordingRunner({
      [`/Query /TN ${WINDOWS_TASK_NAME}`]:
        'TaskName  Next Run Time  Status\nWoodFiredTasks  N/A  Running',
    });
    const backend = new WindowsScheduledTaskBackend({ runner, log: () => {} });

    const status = backend.status();
    expect(status).toEqual({
      running: true,
      enabled: true,
      activeState: 'running',
      enabledState: 'enabled',
      installed: true,
    });
    expect(calls).toEqual([
      {
        cmd: 'schtasks',
        args: ['/Query', '/TN', WINDOWS_TASK_NAME],
      },
    ]);
  });

  it('status reports not-found when the task is absent', () => {
    const { runner } = recordingRunner();
    const backend = new WindowsScheduledTaskBackend({ runner, log: () => {} });
    const status = backend.status();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.activeState).toBe('not-found');
    expect(status.enabledState).toBe('not-found');
    expect(status.installed).toBe(false);
  });
});

describe('defaultRunner elevation guard', () => {
  it.each(ELEVATION)('refuses to run %s', (cmd) => {
    expect(() => defaultRunner(cmd, ['anything'])).toThrowError(
      /refusing to run elevated command/
    );
  });
});

// ---------------------------------------------------------------------------
// Task #742: `service install --system` opt-in elevation variant.
//
// Invariants exercised below:
//   1. Default (NO flag) install NEVER invokes the elevation helper on any of
//      the three platforms, and no elevated token appears in any argv.
//   2. `install({ system: true })` is the SOLE path that invokes the elevation
//      helper, and it targets the SYSTEM-scoped unit location per platform.
// ---------------------------------------------------------------------------

describe('tasks service --system opt-in elevation (task #742)', () => {
  describe('Linux: default (no flag) install is provably admin-free', () => {
    it('uses the user runner only and NEVER touches the elevation helper', () => {
      withTempConfigBase((configBase) => {
        const { runner, calls } = recordingRunner();
        const { runner: elevated, calls: elevatedCalls } =
          recordingElevatedRunner();
        const backend = new LinuxSystemdBackend({
          configBase,
          systemUnitDir: path.join(configBase, 'etc-systemd-system'),
          runner,
          elevatedRunner: elevated,
          log: () => {},
        });

        backend.install(); // no flag

        // Elevation helper NEVER called.
        expect(elevatedCalls).toEqual([]);
        // User-scoped unit written; system path untouched.
        expect(fs.existsSync(backend.unitPath)).toBe(true);
        expect(fs.existsSync(backend.systemUnitPath)).toBe(false);
        // Only `systemctl --user` ran.
        expect(calls).toEqual([
          { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
          { cmd: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_NAME] },
        ]);
        // No elevated token anywhere across BOTH runners' argv.
        const haystack = JSON.stringify({ calls, elevatedCalls }).toLowerCase();
        for (const banned of ELEVATION) {
          expect(haystack).not.toContain(banned);
        }
      });
    });
  });

  describe('Linux: --system is the SOLE elevating path', () => {
    it('writes /etc/systemd/system unit + enables via the elevation helper', () => {
      withTempConfigBase((configBase) => {
        const systemUnitDir = path.join(configBase, 'etc-systemd-system');
        const { runner, calls } = recordingRunner();
        const { runner: elevated, calls: elevatedCalls } =
          recordingElevatedRunner();
        const backend = new LinuxSystemdBackend({
          configBase,
          systemUnitDir,
          runner,
          elevatedRunner: elevated,
          log: () => {},
        });

        backend.install({ system: true });

        // SYSTEM-scoped unit written; user-scoped path untouched.
        const systemUnitPath = path.join(systemUnitDir, SERVICE_UNIT_NAME);
        expect(fs.existsSync(systemUnitPath)).toBe(true);
        expect(systemUnitPath).toBe(backend.systemUnitPath);
        expect(fs.existsSync(backend.unitPath)).toBe(false);

        // The elevation helper is the ONLY runner used (no --user calls).
        expect(calls).toEqual([]);
        expect(elevatedCalls).toEqual([
          { cmd: 'systemctl', args: ['daemon-reload'] },
          { cmd: 'systemctl', args: ['enable', '--now', SERVICE_NAME] },
        ]);
        // Crucially: NO `--user` in the system path.
        const haystack = JSON.stringify(elevatedCalls);
        expect(haystack).not.toContain('--user');
      });
    });
  });

  describe('macOS: default (no flag) install is provably admin-free', () => {
    it('uses the user runner only and NEVER touches the elevation helper', () => {
      withTempBase('wft-service-mac-', (launchAgentsBase) => {
        withTempBase('wft-service-macsys-', (launchDaemonsBase) => {
          const { runner, calls } = recordingRunner();
          const { runner: elevated, calls: elevatedCalls } =
            recordingElevatedRunner();
          const backend = new MacLaunchdBackend({
            launchAgentsBase,
            launchDaemonsBase,
            runner,
            elevatedRunner: elevated,
            log: () => {},
          });

          backend.install(); // no flag

          expect(elevatedCalls).toEqual([]);
          expect(fs.existsSync(backend.plistPath)).toBe(true);
          expect(fs.existsSync(backend.daemonPlistPath)).toBe(false);
          expect(calls).toEqual([
            { cmd: 'launchctl', args: ['load', '-w', backend.plistPath] },
          ]);
          const haystack = JSON.stringify({
            calls,
            elevatedCalls,
          }).toLowerCase();
          for (const banned of ELEVATION) {
            expect(haystack).not.toContain(banned);
          }
        });
      });
    });
  });

  describe('macOS: --system is the SOLE elevating path', () => {
    it('writes /Library/LaunchDaemons plist + bootstraps via the helper', () => {
      withTempBase('wft-service-mac-', (launchAgentsBase) => {
        withTempBase('wft-service-macsys-', (launchDaemonsBase) => {
          const { runner, calls } = recordingRunner();
          const { runner: elevated, calls: elevatedCalls } =
            recordingElevatedRunner();
          const backend = new MacLaunchdBackend({
            launchAgentsBase,
            launchDaemonsBase,
            runner,
            elevatedRunner: elevated,
            log: () => {},
          });

          backend.install({ system: true });

          const daemonPlistPath = path.join(
            launchDaemonsBase,
            LAUNCHD_PLIST_NAME
          );
          expect(fs.existsSync(daemonPlistPath)).toBe(true);
          expect(daemonPlistPath).toBe(backend.daemonPlistPath);
          // User LaunchAgent NOT written by the system path.
          expect(fs.existsSync(backend.plistPath)).toBe(false);

          expect(calls).toEqual([]);
          expect(elevatedCalls).toEqual([
            {
              cmd: 'launchctl',
              args: ['bootstrap', 'system', daemonPlistPath],
            },
          ]);
        });
      });
    });
  });

  describe('Windows: default (no flag) install is provably admin-free', () => {
    it('uses the user runner only and NEVER touches the elevation helper', () => {
      const { runner, calls } = recordingRunner();
      const { runner: elevated, calls: elevatedCalls } =
        recordingElevatedRunner();
      const backend = new WindowsScheduledTaskBackend({
        runner,
        elevatedRunner: elevated,
        cliEntryPoint: 'C:\\wft\\dist\\cli\\bin\\tasks.js',
        nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
        log: () => {},
      });

      backend.install(); // no flag

      expect(elevatedCalls).toEqual([]);
      const expectedTr =
        'C:\\Program Files\\nodejs\\node.exe C:\\wft\\dist\\cli\\bin\\tasks.js serve';
      expect(calls).toEqual([
        {
          cmd: 'schtasks',
          args: [
            '/Create',
            '/SC',
            'ONLOGON',
            '/TN',
            WINDOWS_TASK_NAME,
            '/TR',
            expectedTr,
            '/F',
          ],
        },
      ]);
      // No /RU SYSTEM and no elevation token in the default path.
      const haystack = JSON.stringify({ calls, elevatedCalls });
      expect(haystack).not.toContain('/RU');
      expect(haystack.toUpperCase()).not.toContain('SYSTEM');
      for (const banned of ELEVATION) {
        expect(haystack.toLowerCase()).not.toContain(banned);
      }
    });
  });

  describe('Windows: --system is the SOLE elevating path', () => {
    it('creates a /RU SYSTEM /SC ONSTART task via the elevation helper', () => {
      const { runner, calls } = recordingRunner();
      const { runner: elevated, calls: elevatedCalls } =
        recordingElevatedRunner();
      const backend = new WindowsScheduledTaskBackend({
        runner,
        elevatedRunner: elevated,
        cliEntryPoint: 'C:\\wft\\dist\\cli\\bin\\tasks.js',
        nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
        log: () => {},
      });

      backend.install({ system: true });

      const expectedTr =
        'C:\\Program Files\\nodejs\\node.exe C:\\wft\\dist\\cli\\bin\\tasks.js serve';
      // Only the elevation helper ran; the user runner was untouched.
      expect(calls).toEqual([]);
      expect(elevatedCalls).toEqual([
        {
          cmd: 'schtasks',
          args: [
            '/Create',
            '/SC',
            'ONSTART',
            '/TN',
            WINDOWS_TASK_NAME,
            '/TR',
            expectedTr,
            '/RU',
            'SYSTEM',
            '/F',
          ],
        },
      ]);
      // The system path DOES carry /RU SYSTEM (by design).
      const haystack = JSON.stringify(elevatedCalls).toUpperCase();
      expect(haystack).toContain('/RU');
      expect(haystack).toContain('SYSTEM');
    });
  });

  describe('dispatch seam threads --system through to the backend', () => {
    it('getServiceBackend(linux).install({system}) uses the elevation helper', () => {
      withTempConfigBase((configBase) => {
        const { runner, calls } = recordingRunner();
        const { runner: elevated, calls: elevatedCalls } =
          recordingElevatedRunner();
        const backend = getServiceBackend('linux', {
          configBase,
          systemUnitDir: path.join(configBase, 'etc-systemd-system'),
          runner,
          elevatedRunner: elevated,
          log: () => {},
        });
        backend.install({ system: true });
        expect(calls).toEqual([]);
        expect(elevatedCalls.length).toBeGreaterThan(0);
      });
    });
  });
});
