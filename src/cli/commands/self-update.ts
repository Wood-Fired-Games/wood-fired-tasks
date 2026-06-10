import { Command } from 'commander';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { colorError, colorInfo, colorSuccess, colorWarn } from '../output/formatters.js';
import { VERSION } from '../../utils/version.js';
import { buildNpmInvocation } from '../util/npm-spawn.js';
import { copySkills, copyAgents, type CopySkillsResult, type CopyAgentsResult } from './setup.js';

/**
 * `tasks self-update` — frictionless self-update for npm-global installs
 * (project #36, task #739).
 *
 * Spawns `npm i -g wood-fired-tasks@latest`, then re-syncs the bundled
 * skills/agents into ~/.claude (task #934): the npm install replaces the
 * files under the global prefix in place, so the post-install copySkills /
 * copyAgents read the NEW version's assets even though this process is still
 * running the old binary. Without this step, any release that adds or
 * changes a skill leaves self-updaters with stale ~/.claude/commands/tasks
 * while self-update reports success — violating the README's "keep it up to
 * date" contract. The DB schema does NOT need touching here —
 * migrate-on-next-serve handles it the next time the service boots against
 * the upgraded binary.
 *
 * EACCES policy: a global npm install under a root-owned prefix fails with
 * EACCES. We DO NOT escalate (no sudo / runas / elevation of ANY kind).
 * Instead we print the npm-prefix remediation so the user can move their
 * global prefix somewhere writable (e.g. ~/.npm-global) and re-run WITHOUT
 * sudo. Asking for elevation here is a footgun: a root-owned global install
 * leaves a binary the user can't later self-update, perpetuating the problem.
 */

// Injectable spawn seam. Mirrors the subset of child_process.spawn the command
// uses so tests can pass a recording mock without a real npm process.
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// Injectable update-notifier seam. Kept thin + synchronous-to-call so the
// nudge is testable without network access. The default wraps the
// `update-notifier` package (lazy-imported so a missing dep / offline box
// never breaks `self-update` itself).
export type NotifyFn = (currentVersion: string) => void | Promise<void>;

// Injectable skills/agents sync seam (task #934). Defaults to the same
// copySkills/copyAgents pair `tasks setup` uses, so the update path and the
// onboarding path cannot drift. Tests inject a recorder to avoid touching the
// real ~/.claude.
export type SyncAssetsFn = () => { skills: CopySkillsResult; agents: CopyAgentsResult };

export interface SelfUpdateDeps {
  spawn?: SpawnFn;
  notify?: NotifyFn;
  syncAssets?: SyncAssetsFn;
}

const PACKAGE_NAME = 'wood-fired-tasks';

/**
 * True when a spawn error / non-zero exit looks like an EACCES-class
 * permission failure (root-owned npm prefix). Inspects both the structured
 * error `code` and any captured stderr text.
 */
export function isEaccesFailure(error: NodeJS.ErrnoException | null, stderr: string): boolean {
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return true;
  }
  return /EACCES|EPERM|permission denied|not permitted/i.test(stderr);
}

/**
 * Remediation text for the EACCES path. Deliberately contains NO elevation
 * instruction — only the writable-prefix fix and a "without sudo" reassurance.
 */
export function eaccesRemediation(): string {
  return [
    colorError('Update failed: npm could not write to the global prefix (EACCES).'),
    '',
    colorWarn('This is a permissions problem, not a reason to use sudo.'),
    'Point npm at a writable global prefix, then re-run WITHOUT sudo:',
    '',
    '  mkdir -p ~/.npm-global',
    '  npm config set prefix ~/.npm-global',
    '  export PATH="$HOME/.npm-global/bin:$PATH"   # add to your shell profile',
    `  npm i -g ${PACKAGE_NAME}@latest`,
    '',
    colorInfo('Then `tasks self-update` will work without elevation in future.'),
  ].join('\n');
}

/**
 * Default update-notifier nudge. Lazy-imports `update-notifier` so an absent
 * package or offline environment degrades silently rather than throwing.
 */
const defaultNotify: NotifyFn = async (currentVersion: string) => {
  try {
    // Indirect specifier so TS doesn't try to resolve a (types-less) module;
    // update-notifier ships no .d.ts, and the nudge is best-effort anyway.
    const specifier = 'update-notifier';
    type NotifierFactory = (opts: unknown) => { notify: (opts?: unknown) => void };
    const mod = (await import(specifier)) as {
      default?: NotifierFactory;
    } & NotifierFactory;
    const updateNotifier: NotifierFactory = mod.default ?? (mod as unknown as NotifierFactory);
    const notifier = updateNotifier({
      pkg: { name: PACKAGE_NAME, version: currentVersion },
    });
    notifier.notify({ defer: false, isGlobal: true });
  } catch {
    // Notifier is best-effort: never let it block or fail self-update.
  }
};

/**
 * Spawn `npm i -g <pkg>@latest` and resolve with the child's exit code.
 * Rejects only on a hard spawn error (the EACCES classifier inspects both).
 */
function runNpmInstall(
  spawn: SpawnFn,
): Promise<{ code: number | null; error: NodeJS.ErrnoException | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    // Windows-safe npm invocation via the shared helper (task #794): handles
    // the npm.cmd EINVAL rule (shell:true on win32) and arg-quoting in one
    // place shared with `setup --fix-npm-prefix`, so the fix can't drift. The
    // args here are all constants, so quoting is a no-op — but routing through
    // the same builder keeps both call sites correct by construction.
    const inv = buildNpmInvocation(['i', '-g', `${PACKAGE_NAME}@latest`]);
    const child = spawn(inv.command, inv.args, {
      stdio: ['ignore', 'inherit', 'pipe'],
      shell: inv.shell,
    });

    const settle = (code: number | null, error: NodeJS.ErrnoException | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, error, stderr });
    };

    // stderr may be a pipe (captured) so we can scan it for EACCES text.
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
      });
    }

    child.on('error', (err: NodeJS.ErrnoException) => settle(null, err));
    child.on('close', (code: number | null) => settle(code, null));
  });
}

export const selfUpdateCommand = new Command('self-update')
  .description(`Update ${PACKAGE_NAME} to the latest published version via npm (no sudo)`)
  .action(async function selfUpdateAction(this: Command) {
    // Dependency-injection seam: tests attach mocks on the command via
    // `.deps`; production falls through to the real spawn + notifier.
    const deps: SelfUpdateDeps =
      (selfUpdateCommand as unknown as { _deps?: SelfUpdateDeps })._deps ?? {};
    const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    const notify = deps.notify ?? defaultNotify;
    const syncAssets: SyncAssetsFn =
      deps.syncAssets ?? (() => ({ skills: copySkills(), agents: copyAgents() }));

    // update-notifier nudge: surface a "newer version available" hint before
    // we attempt the upgrade. Best-effort and never blocks the update.
    await notify(VERSION);

    console.log(colorInfo(`Updating ${PACKAGE_NAME} (current: v${VERSION})...`));
    console.log(colorInfo(`Running: npm i -g ${PACKAGE_NAME}@latest`));

    const { code, error, stderr } = await runNpmInstall(spawn);

    if (isEaccesFailure(error, stderr)) {
      console.error(eaccesRemediation());
      process.exitCode = 1;
      return;
    }

    if (error) {
      console.error(colorError(`Update failed: ${error.message}`));
      process.exitCode = 1;
      return;
    }

    if (code !== 0) {
      console.error(colorError(`Update failed: npm exited with code ${code}`));
      process.exitCode = code ?? 1;
      return;
    }

    // npm replaced the package files under the global prefix in place, so the
    // sync below reads the NEW version's dist/skills even though this process
    // still runs the old binary. A sync failure is loud and non-zero: "update
    // succeeded but your skills are stale" is exactly the silent state this
    // step exists to eliminate (task #934).
    try {
      const { skills, agents } = syncAssets();
      const refreshed = skills.written.length + agents.written.length;
      console.log(
        refreshed > 0
          ? colorInfo(
              `Refreshed ${skills.written.length} skill(s) in ${skills.destDir} and ${agents.written.length} agent(s) in ${agents.destDir}`,
            )
          : colorInfo(`Skills and agents already up to date in ${skills.destDir}`),
      );
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      console.error(
        colorError(
          `Update installed, but syncing bundled skills/agents into ~/.claude failed: ${message}`,
        ),
      );
      console.error(colorWarn(`Run \`${PACKAGE_NAME} setup\` to retry the skills sync.`));
      process.exitCode = 1;
      return;
    }

    console.log(
      colorSuccess(`Updated ${PACKAGE_NAME}. The schema migrates automatically on next serve.`),
    );
    process.exitCode = 0;
  });

/**
 * Test seam: inject a recording spawn and/or notify implementation. Returns
 * the command so callers can chain. Production code never calls this.
 */
export function __setSelfUpdateDeps(deps: SelfUpdateDeps): Command {
  (selfUpdateCommand as unknown as { _deps?: SelfUpdateDeps })._deps = deps;
  return selfUpdateCommand;
}

export { defaultNotify };
