import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  LinuxSystemdBackend,
  getServiceBackend,
  defaultRunner,
  SERVICE_NAME,
  SERVICE_UNIT_NAME,
  type CommandRunner,
} from '../service.js';

function withTempConfigBase<T>(fn: (base: string) => T): T {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-service-cfg-'));
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

  it("throws a clear 'not yet implemented' for 'darwin'", () => {
    expect(() => getServiceBackend('darwin')).toThrowError(
      /not yet implemented on 'darwin'/
    );
  });

  it("throws a clear 'not yet implemented' for 'win32'", () => {
    expect(() => getServiceBackend('win32')).toThrowError(
      /not yet implemented on 'win32'/
    );
  });
});

describe('defaultRunner elevation guard', () => {
  it.each(ELEVATION)('refuses to run %s', (cmd) => {
    expect(() => defaultRunner(cmd, ['anything'])).toThrowError(
      /refusing to run elevated command/
    );
  });
});
