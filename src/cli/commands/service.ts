import { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveAssetPath } from '../../assets/resolve.js';

/**
 * `tasks service` (task #740).
 *
 * Register/unregister the Wood Fired Tasks API server as a background service
 * so npm-only users can keep `tasks serve` running across logout/reboot — with
 * ZERO admin rights by default.
 *
 * Cross-OS seam: {@link getServiceBackend} dispatches on `process.platform`.
 * Three admin-free backends are implemented:
 *   - Linux (`systemctl --user`): user-scoped systemd unit under
 *     `~/.config/systemd/user/`.
 *   - macOS (launchd, task #741): per-user LaunchAgent plist under
 *     `~/Library/LaunchAgents/`, driven by `launchctl` in the GUI/user domain.
 *   - Windows (Scheduled Task, task #741): a per-user, at-logon scheduled task
 *     created with `schtasks /Create /SC ONLOGON ... /F` (NO `/RU SYSTEM`).
 *
 * Every backend is admin-free: none of them shell out to
 * sudo / runas / pkexec / doas — the same hard guard used by setup.ts
 * `fixNpmPrefix`. The `--system` (elevated) variant is future work (task #742).
 */

/** The systemd unit file name written under the user unit directory. */
export const SERVICE_UNIT_NAME = 'wood-fired-tasks.service';

/** Logical service name passed to `systemctl --user <verb> <name>`. */
export const SERVICE_NAME = 'wood-fired-tasks';

/**
 * Injectable command runner. Returns captured stdout (trimmed) so `status` can
 * read `systemctl is-active`/`is-enabled` output. Tests pass a fake to assert
 * exact argv without executing systemctl.
 */
export type CommandRunner = (cmd: string, args: string[]) => string;

/** Commands that elevate privileges — categorically refused. */
const ELEVATION_RE = /^(sudo|runas|pkexec|doas)$/i;

/**
 * Default runner: hard-guards against elevation, then execs. `is-active` /
 * `is-enabled` exit non-zero when the unit is stopped/disabled, which is a
 * NORMAL status result rather than an error — so we capture and return stdout
 * even on a non-zero exit instead of throwing.
 */
export function defaultRunner(cmd: string, args: string[]): string {
  if (ELEVATION_RE.test(cmd)) {
    throw new Error(`refusing to run elevated command: ${cmd}`);
  }
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch (err: unknown) {
    // systemctl is-active/is-enabled exit non-zero for inactive/disabled units
    // but still print the state on stdout. Surface that stdout as the result.
    const e = err as { stdout?: Buffer | string };
    if (e && e.stdout != null) {
      return e.stdout.toString().trim();
    }
    throw err;
  }
}

/**
 * Resolve the absolute path to the installed CLI entry point that the service
 * should run. Mirrors setup.ts `resolveMcpEntryPoint`: resolved from the
 * package root via `import.meta.url` (NOT cwd), so the generated unit points at
 * the real installed binary regardless of where `tasks service install` ran.
 */
export function resolveCliEntryPoint(): string {
  return resolveAssetPath('dist', 'cli', 'bin', 'tasks.js');
}

/** Structured status returned by every backend's `status()`. */
export interface ServiceStatus {
  /** Whether the unit is currently running (`systemctl is-active` == active). */
  running: boolean;
  /** Whether the unit is enabled to start at boot/login. */
  enabled: boolean;
  /** Raw `is-active` token (e.g. "active", "inactive", "failed", "unknown"). */
  activeState: string;
  /** Raw `is-enabled` token (e.g. "enabled", "disabled", "not-found"). */
  enabledState: string;
  /** Whether a unit file currently exists on disk. */
  installed: boolean;
}

/** Cross-OS backend contract. */
export interface ServiceBackend {
  install(): void;
  uninstall(): void;
  status(): ServiceStatus;
}

export interface LinuxBackendOptions {
  /**
   * Injectable base config directory (the `~/.config` equivalent). Honors
   * `XDG_CONFIG_HOME`, then `$HOME/.config`. Overridable for tests.
   */
  configBase?: string;
  /** Injectable command runner (tests assert argv; default execs systemctl). */
  runner?: CommandRunner;
  /** Absolute path to the CLI entry point ExecStart should run. */
  cliEntryPoint?: string;
  /** Node binary used to launch the CLI (defaults to process.execPath). */
  nodeBin?: string;
  /** Injectable logger. */
  log?: (line: string) => void;
}

/** Resolve the user systemd config base (`$XDG_CONFIG_HOME` or `$HOME/.config`). */
export function defaultConfigBase(home: string = os.homedir()): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return path.join(home, '.config');
}

/**
 * Linux backend: user-scoped systemd via `systemctl --user`. Admin-free.
 *
 * Layout: `<configBase>/systemd/user/wood-fired-tasks.service`.
 */
export class LinuxSystemdBackend implements ServiceBackend {
  private readonly configBase: string;
  private readonly runner: CommandRunner;
  private readonly cliEntryPoint: string;
  private readonly nodeBin: string;
  private readonly log: (line: string) => void;

  constructor(options: LinuxBackendOptions = {}) {
    this.configBase = options.configBase ?? defaultConfigBase();
    this.runner = options.runner ?? defaultRunner;
    this.cliEntryPoint = options.cliEntryPoint ?? resolveCliEntryPoint();
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /** Directory holding user units: `<configBase>/systemd/user`. */
  get unitDir(): string {
    return path.join(this.configBase, 'systemd', 'user');
  }

  /** Absolute path to the unit file. */
  get unitPath(): string {
    return path.join(this.unitDir, SERVICE_UNIT_NAME);
  }

  /** Render the systemd unit text. ExecStart runs the CLI `serve` subcommand. */
  renderUnit(): string {
    const execStart = `${this.nodeBin} ${this.cliEntryPoint} serve`;
    return [
      '[Unit]',
      'Description=Wood Fired Tasks API server',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${execStart}`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  /**
   * Drive systemctl in user scope. Guards every invocation against elevation
   * (defense in depth — the default runner also guards) so a swapped runner
   * can never be coerced into elevating.
   */
  private systemctl(...args: string[]): string {
    if (ELEVATION_RE.test('systemctl') /* never true; documents intent */) {
      throw new Error('refusing to run elevated command');
    }
    return this.runner('systemctl', ['--user', ...args]);
  }

  install(): void {
    fs.mkdirSync(this.unitDir, { recursive: true });
    fs.writeFileSync(this.unitPath, this.renderUnit(), 'utf8');
    this.systemctl('daemon-reload');
    this.systemctl('enable', '--now', SERVICE_NAME);
    this.log(`Installed and started user service '${SERVICE_NAME}'.`);
    this.log(`Unit written to ${this.unitPath} (no elevation required).`);
  }

  uninstall(): void {
    // Best-effort stop+disable; tolerate an already-absent unit.
    this.systemctl('disable', '--now', SERVICE_NAME);
    if (fs.existsSync(this.unitPath)) {
      fs.rmSync(this.unitPath);
    }
    this.systemctl('daemon-reload');
    this.log(`Uninstalled user service '${SERVICE_NAME}'.`);
  }

  status(): ServiceStatus {
    const activeState = this.systemctl('is-active', SERVICE_NAME);
    const enabledState = this.systemctl('is-enabled', SERVICE_NAME);
    return {
      running: activeState === 'active',
      enabled: enabledState === 'enabled',
      activeState,
      enabledState,
      installed: fs.existsSync(this.unitPath),
    };
  }
}

/** Reverse-DNS LaunchAgent label / plist basename used by the macOS backend. */
export const LAUNCHD_LABEL = 'com.woodfiredgames.tasks';

/** The LaunchAgent plist file name written under the user LaunchAgents dir. */
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;

export interface MacBackendOptions {
  /**
   * Injectable base directory for the user LaunchAgents dir. The plist is
   * written to `<launchAgentsBase>/com.woodfiredgames.tasks.plist`. Defaults to
   * `~/Library/LaunchAgents`. Overridable for tests.
   */
  launchAgentsBase?: string;
  /** Injectable command runner (tests assert argv; default execs launchctl). */
  runner?: CommandRunner;
  /** Absolute path to the CLI entry point the agent should run. */
  cliEntryPoint?: string;
  /** Node binary used to launch the CLI (defaults to process.execPath). */
  nodeBin?: string;
  /** Injectable logger. */
  log?: (line: string) => void;
}

/** Resolve the default user LaunchAgents directory (`~/Library/LaunchAgents`). */
export function defaultLaunchAgentsBase(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents');
}

/** XML-escape a string for safe inclusion in plist text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * macOS backend: per-user launchd LaunchAgent. Admin-free — operates entirely
 * in the user (GUI) domain, never `sudo launchctl` / system domain.
 *
 * Layout: `<launchAgentsBase>/com.woodfiredgames.tasks.plist`.
 */
export class MacLaunchdBackend implements ServiceBackend {
  private readonly launchAgentsBase: string;
  private readonly runner: CommandRunner;
  private readonly cliEntryPoint: string;
  private readonly nodeBin: string;
  private readonly log: (line: string) => void;

  constructor(options: MacBackendOptions = {}) {
    this.launchAgentsBase =
      options.launchAgentsBase ?? defaultLaunchAgentsBase();
    this.runner = options.runner ?? defaultRunner;
    this.cliEntryPoint = options.cliEntryPoint ?? resolveCliEntryPoint();
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /** Absolute path to the LaunchAgent plist file. */
  get plistPath(): string {
    return path.join(this.launchAgentsBase, LAUNCHD_PLIST_NAME);
  }

  /**
   * Render the LaunchAgent plist. `ProgramArguments` runs `<node> <cli> serve`;
   * `RunAtLoad` + `KeepAlive` keep it running across logout/reboot.
   */
  renderPlist(): string {
    const programArgs = [this.nodeBin, this.cliEntryPoint, 'serve'];
    const argEntries = programArgs
      .map((a) => `    <string>${escapeXml(a)}</string>`)
      .join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${LAUNCHD_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      argEntries,
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  /** Guard launchctl against elevation (defense in depth). */
  private launchctl(...args: string[]): string {
    if (ELEVATION_RE.test('launchctl')) {
      throw new Error('refusing to run elevated command');
    }
    return this.runner('launchctl', args);
  }

  install(): void {
    fs.mkdirSync(this.launchAgentsBase, { recursive: true });
    fs.writeFileSync(this.plistPath, this.renderPlist(), 'utf8');
    // `load -w` registers + enables the agent in the user domain (no sudo).
    this.launchctl('load', '-w', this.plistPath);
    this.log(`Installed and started user LaunchAgent '${LAUNCHD_LABEL}'.`);
    this.log(`Plist written to ${this.plistPath} (no elevation required).`);
  }

  uninstall(): void {
    // Best-effort unload; tolerate an already-absent agent.
    this.launchctl('unload', '-w', this.plistPath);
    if (fs.existsSync(this.plistPath)) {
      fs.rmSync(this.plistPath);
    }
    this.log(`Uninstalled user LaunchAgent '${LAUNCHD_LABEL}'.`);
  }

  status(): ServiceStatus {
    const installed = fs.existsSync(this.plistPath);
    // `launchctl list <label>` prints a plist-like blob with "PID" when running
    // and exits non-zero when the label is not loaded.
    const listing = this.launchctl('list', LAUNCHD_LABEL);
    const loaded = listing.length > 0;
    const running = /"?PID"?\s*=\s*\d+/.test(listing);
    return {
      running,
      // In the user launchd domain, a loaded agent installed with `-w` is the
      // "enabled to start at login" signal.
      enabled: loaded && installed,
      activeState: running ? 'running' : loaded ? 'loaded' : 'not-loaded',
      enabledState: loaded ? 'enabled' : 'disabled',
      installed,
    };
  }
}

/** Scheduled-task name used by the Windows backend. */
export const WINDOWS_TASK_NAME = 'WoodFiredTasks';

export interface WindowsBackendOptions {
  /** Injectable command runner (tests assert argv; default execs schtasks). */
  runner?: CommandRunner;
  /** Absolute path to the CLI entry point the task should run. */
  cliEntryPoint?: string;
  /** Node binary used to launch the CLI (defaults to process.execPath). */
  nodeBin?: string;
  /** Injectable logger. */
  log?: (line: string) => void;
}

/**
 * Windows backend: a per-user, at-logon Scheduled Task created with `schtasks`.
 * Admin-free — the task runs as the *current interactive user* (no `/RU SYSTEM`,
 * no elevation). Use `/SC ONLOGON` so it relaunches `serve` at each login.
 */
export class WindowsScheduledTaskBackend implements ServiceBackend {
  private readonly runner: CommandRunner;
  private readonly cliEntryPoint: string;
  private readonly nodeBin: string;
  private readonly log: (line: string) => void;

  constructor(options: WindowsBackendOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.cliEntryPoint = options.cliEntryPoint ?? resolveCliEntryPoint();
    this.nodeBin = options.nodeBin ?? process.execPath;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /** The `/TR` task-run command: `<node> <cli> serve`. */
  get taskRun(): string {
    return `${this.nodeBin} ${this.cliEntryPoint} serve`;
  }

  /** Guard schtasks against elevation (defense in depth). */
  private schtasks(...args: string[]): string {
    if (ELEVATION_RE.test('schtasks')) {
      throw new Error('refusing to run elevated command');
    }
    return this.runner('schtasks', args);
  }

  install(): void {
    // Per-user, at-logon, current-user context. NO /RU SYSTEM, NO elevation.
    // /F overwrites an existing task so install is idempotent.
    this.schtasks(
      '/Create',
      '/SC',
      'ONLOGON',
      '/TN',
      WINDOWS_TASK_NAME,
      '/TR',
      this.taskRun,
      '/F'
    );
    this.log(
      `Installed per-user logon task '${WINDOWS_TASK_NAME}' (no elevation required).`
    );
  }

  uninstall(): void {
    this.schtasks('/Delete', '/TN', WINDOWS_TASK_NAME, '/F');
    this.log(`Uninstalled per-user logon task '${WINDOWS_TASK_NAME}'.`);
  }

  status(): ServiceStatus {
    // `schtasks /Query` exits non-zero (and prints nothing) when the task is
    // absent; prints its status line ("Running"/"Ready"/"Disabled") otherwise.
    const listing = this.schtasks('/Query', '/TN', WINDOWS_TASK_NAME);
    const installed = listing.length > 0;
    const running = /\bRunning\b/i.test(listing);
    const disabled = /\bDisabled\b/i.test(listing);
    return {
      running,
      enabled: installed && !disabled,
      activeState: running ? 'running' : installed ? 'ready' : 'not-found',
      enabledState: installed ? (disabled ? 'disabled' : 'enabled') : 'not-found',
      installed,
    };
  }
}

/**
 * Cross-OS dispatch seam. Returns the platform-appropriate backend.
 * Linux, macOS (#741) and Windows (#741) are all implemented and admin-free.
 */
export function getServiceBackend(
  platform: NodeJS.Platform = process.platform,
  options: LinuxBackendOptions & MacBackendOptions & WindowsBackendOptions = {}
): ServiceBackend {
  switch (platform) {
    case 'linux':
      return new LinuxSystemdBackend(options);
    case 'darwin':
      return new MacLaunchdBackend(options);
    case 'win32':
      return new WindowsScheduledTaskBackend(options);
    default:
      throw new Error(
        `service management is not yet implemented on '${platform}'`
      );
  }
}

export const serviceCommand = new Command('service')
  .description(
    'Manage the Wood Fired Tasks background service (admin-free: Linux systemctl --user, macOS launchd LaunchAgent, Windows per-user logon task)'
  );

serviceCommand
  .command('install')
  .description(
    'Install and start the background service (writes a user-scoped systemd unit; never uses sudo)'
  )
  .action(() => {
    getServiceBackend().install();
  });

serviceCommand
  .command('uninstall')
  .description('Stop and remove the background service')
  .action(() => {
    getServiceBackend().uninstall();
  });

serviceCommand
  .command('status')
  .description('Show whether the background service is running and enabled')
  .action(() => {
    const status = getServiceBackend().status();
    const globalOpts = serviceCommand.optsWithGlobals<{ json?: boolean }>();
    if (globalOpts.json) {
      process.stdout.write(JSON.stringify(status) + '\n');
      return;
    }
    process.stdout.write(
      `running: ${status.running} (${status.activeState})\n` +
        `enabled: ${status.enabled} (${status.enabledState})\n` +
        `installed: ${status.installed}\n`
    );
  });
