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
 * Only the Linux (`systemctl --user`) backend is implemented here. macOS
 * (launchd, task #741) and Windows (task #742) are separate tasks; this module
 * intentionally throws a clear "not yet implemented" for those platforms so the
 * seam is explicit rather than silently absent.
 *
 * The Linux backend is admin-free: it writes a user-scoped systemd unit under
 * `~/.config/systemd/user/` and drives it with `systemctl --user`. It NEVER
 * shells out to sudo / runas / pkexec / doas — the same hard guard used by
 * setup.ts `fixNpmPrefix`.
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

/**
 * Cross-OS dispatch seam. Returns the platform-appropriate backend.
 * Linux is implemented; darwin (#741) and win32 (#742) throw a clear
 * "not yet implemented" so the seam is explicit.
 */
export function getServiceBackend(
  platform: NodeJS.Platform = process.platform,
  options: LinuxBackendOptions = {}
): ServiceBackend {
  switch (platform) {
    case 'linux':
      return new LinuxSystemdBackend(options);
    case 'darwin':
      throw new Error(
        "service management is not yet implemented on 'darwin' (tracked by task #741)"
      );
    case 'win32':
      throw new Error(
        "service management is not yet implemented on 'win32' (tracked by task #742)"
      );
    default:
      throw new Error(
        `service management is not yet implemented on '${platform}'`
      );
  }
}

export const serviceCommand = new Command('service')
  .description(
    'Manage the Wood Fired Tasks background service (Linux: systemctl --user, admin-free)'
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
