import { resolve } from 'node:path';
import { Command } from 'commander';
import { detectBackend, findRepoRoot, resolveBackend } from '../../scm/detect.js';
import { gitBackend } from '../../scm/git.js';
import { noneBackend } from '../../scm/none.js';
import { perforceBackend } from '../../scm/perforce.js';
import {
  SCM_EXIT_CODES,
  SCM_VERBS,
  ScmError,
  type ScmBackend,
  type ScmBackendName,
  type ScmErrorCode,
  type ScmVerbContext,
} from '../../scm/types.js';

/**
 * P1 keystone (task #1536) — `tasks scm <verb> [args]` CLI dispatcher.
 *
 * The command owns exactly three concerns; the verb *logic* lives in the
 * Wave-1/2 backends (`src/scm/{git,none,perforce}.ts`) and is never
 * reimplemented here:
 *
 *  1. **Resolve** the effective backend for `--repo` via
 *     `loadScmConfig` → `resolveBackend` (config file overrides auto-detect,
 *     spec §3.2) and pick the matching backend singleton.
 *  2. **Dispatch** the verb to the backend method, forwarding positional args
 *     (`changed-files <base>`, `stage <files...>`, `record <message>`, …).
 *  3. **Envelope + exit code** — wrap the resolved `data` into the §4.1 success
 *     envelope (or a thrown {@link ScmError} into the failure envelope), print
 *     EXACTLY ONE single-line JSON object to stdout, and set `process.exitCode`
 *     per the §4.1 code→exit mapping. Human detail goes to stderr only.
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * §4.1 (wire contract + exit codes), §6.2 (CLI surface).
 */

/** The registered backend singletons, keyed by resolved backend name (§3.2). */
function backendFor(name: ScmBackendName): ScmBackend {
  switch (name) {
    case 'git':
      return gitBackend;
    case 'perforce':
      return perforceBackend;
    case 'none':
      return noneBackend;
  }
}

/**
 * Map an {@link ScmErrorCode} to its §4.1 process exit code. Unlisted codes
 * (`NO_REMOTE`, `SUBMIT_CONFLICT`, `DIRTY_TREE`, `DETACHED_HEAD`) are ordinary
 * operation failures → exit 1.
 */
function exitCodeForError(code: ScmErrorCode): number {
  switch (code) {
    case 'CONFIG_INVALID':
      return SCM_EXIT_CODES.USAGE_OR_CONFIG_ERROR;
    case 'BACKEND_UNAVAILABLE':
    case 'AUTH_EXPIRED':
      return SCM_EXIT_CODES.BACKEND_UNAVAILABLE;
    case 'UNSUPPORTED_VERB':
      return SCM_EXIT_CODES.UNSUPPORTED_VERB;
    case 'TIMEOUT':
      return SCM_EXIT_CODES.TIMEOUT;
    default:
      return SCM_EXIT_CODES.OPERATION_FAILED;
  }
}

/**
 * Return `args[index]` or throw a usage error (§4.1 exit 2) when a verb's
 * required positional argument is missing. `CONFIG_INVALID` is the §4.1 code
 * that maps to `USAGE_OR_CONFIG_ERROR`.
 */
function requireArg(verb: string, args: string[], index: number, label: string): string {
  const value = args[index];
  if (value === undefined || value === '') {
    throw new ScmError('CONFIG_INVALID', `\`scm ${verb}\` requires a <${label}> argument`);
  }
  return value;
}

/** True when `verb` is one of the §4 verb-table names the backends implement. */
function isKnownVerb(verb: string): boolean {
  return (SCM_VERBS as readonly string[]).includes(verb);
}

/**
 * Dispatch one verb to `backend`, forwarding the CLI positional args. An
 * unrecognized verb is a usage error (§4.1 exit 2) — NOT `UNSUPPORTED_VERB`,
 * which is reserved for a known verb a backend cannot honor (exit 4).
 */
function dispatchVerb(
  backend: ScmBackend,
  verb: string,
  ctx: ScmVerbContext,
  args: string[],
): Promise<unknown> {
  switch (verb) {
    case 'detect':
      return backend.detect(ctx);
    case 'baseline':
      return backend.baseline(ctx);
    case 'status':
      return backend.status(ctx);
    case 'changed-files':
      return backend.changedFiles(ctx, requireArg(verb, args, 0, 'base'));
    case 'stage':
      return backend.stage(ctx, args);
    case 'record':
      return backend.record(ctx, requireArg(verb, args, 0, 'message'));
    case 'change-id':
      return backend.changeId(ctx);
    case 'publish':
      return backend.publish(ctx);
    case 'open-review':
      return backend.openReview(ctx);
    case 'isolate':
      return backend.isolate(ctx, requireArg(verb, args, 0, 'id'));
    case 'teardown-isolation':
      return backend.teardownIsolation(ctx, requireArg(verb, args, 0, 'id'));
    case 'reset-hard':
      return backend.resetHard(ctx, requireArg(verb, args, 0, 'ref'));
    default:
      throw new ScmError(
        'CONFIG_INVALID',
        `unknown verb: ${verb}`,
        `Valid verbs: ${SCM_VERBS.join(', ')}`,
      );
  }
}

/** Print a single-line JSON envelope to stdout (§4.1 — exactly one object). */
function printEnvelope(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export const scmCommand = new Command('scm')
  .description(
    'Run a pluggable source-control verb against the resolved backend (git/perforce/none)',
  )
  .argument('<verb>', `SCM verb: ${SCM_VERBS.join(', ')}`)
  .argument(
    '[args...]',
    'Verb arguments (e.g. changed-files <base>, stage <files...>, record <message>)',
  )
  .option('--repo <path>', 'Repo root (default: discovered from cwd)')
  .option('--context <key>', 'Scope key namespacing per-run state', 'default')
  .allowUnknownOption(false)
  .action(async (verb: string, args: string[], opts: { repo?: string; context: string }) => {
    const repo = opts.repo !== undefined ? resolve(opts.repo) : findRepoRoot(process.cwd());
    const context = opts.context;
    const ctx: ScmVerbContext = { repo, context };

    // Best-effort backend name for the envelope even if config resolution
    // throws (CONFIG_INVALID) before a concrete backend is known. detectBackend
    // itself can now throw CONFIG_INVALID (ambiguous dual .git+.p4config
    // markers, task #1549) — swallow that here so it doesn't escape the
    // try/catch below, which is what actually maps the error to its §4.1 exit
    // code; 'none' is an inert placeholder overwritten by the real envelope
    // once the error is caught.
    let backendName: ScmBackendName = 'none';
    try {
      backendName = detectBackend(repo);
    } catch {
      // Real handling happens in the try/catch below via resolveBackend().
    }

    try {
      if (!isKnownVerb(verb)) {
        throw new ScmError(
          'CONFIG_INVALID',
          `unknown verb: ${verb}`,
          `Valid verbs: ${SCM_VERBS.join(', ')}`,
        );
      }

      // resolveBackend loads + validates .tasks/scm.json (config overrides
      // auto-detect, §3.2) and throws CONFIG_INVALID (exit 2) on a malformed
      // file rather than silently falling through to detection (§3.1).
      const resolved = resolveBackend(repo);
      backendName = resolved.backend;
      const backend = backendFor(resolved.backend);

      const data = await dispatchVerb(backend, verb, ctx, args);
      printEnvelope({
        ok: true,
        verb,
        backend: backend.name,
        context,
        data,
        warnings: [],
      });
    } catch (err) {
      const scmErr =
        err instanceof ScmError
          ? err
          : new ScmError('BACKEND_UNAVAILABLE', err instanceof Error ? err.message : String(err));

      const error: { code: ScmErrorCode; message: string; hint?: string } = {
        code: scmErr.code,
        message: scmErr.message,
      };
      if (scmErr.hint !== undefined) {
        error.hint = scmErr.hint;
      }

      printEnvelope({ ok: false, verb, backend: backendName, context, error });
      process.stderr.write(`scm ${verb}: ${scmErr.message}\n`);
      process.exitCode = exitCodeForError(scmErr.code);
    }
  });
