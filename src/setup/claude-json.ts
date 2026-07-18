import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Shape of the MCP server entry written under `mcpServers[<serverName>]` in
 * `~/.claude.json`. Kept loose on purpose: the merge module does not own the
 * real production args/env — callers pass the fully-formed entry object so the
 * function stays testable and not hardcoded to the prod home dir.
 */
export interface ClaudeMcpServerEntry {
  type: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** Default server key under `mcpServers`. */
export const DEFAULT_SERVER_NAME = 'wood-fired-tasks';

/** Default target file: the user's `~/.claude.json`. */
export function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

export interface MergeClaudeJsonOptions {
  /** Target file. Defaults to `~/.claude.json`. */
  filePath?: string;
  /** Key under `mcpServers`. Defaults to `'wood-fired-tasks'`. */
  serverName?: string;
  /** The MCP server entry object to set. */
  entry: ClaudeMcpServerEntry;
  /**
   * Internal/optional dependency-injection seam for the atomic rename. Lets
   * tests force an EPERM/EBUSY on the first attempt to exercise the retry loop.
   * Production callers never pass this. Signature mirrors `fs.renameSync`.
   */
  _renameImpl?: (oldPath: string, newPath: string) => void;
  /** Internal: max rename attempts on EPERM/EBUSY. Defaults to 3. */
  _maxRenameAttempts?: number;
}

export interface MergeClaudeJsonResult {
  /** Absolute path that was written. */
  filePath: string;
  /** Path of the `.bak` backup, or null if no prior file existed to back up. */
  backupPath: string | null;
  /** True when the file content was unchanged and the write was skipped. */
  unchanged: boolean;
  /** Number of rename attempts performed (>=1; >1 means a retry occurred). */
  renameAttempts: number;
}

function isRetryableRenameError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as NodeJS.ErrnoException).code === 'EPERM' ||
      (err as NodeJS.ErrnoException).code === 'EBUSY')
  );
}

/**
 * Shared atomic-write tail for {@link mergeClaudeJson} and
 * {@link removeClaudeJsonServer}: write `serialized` to a `.tmp` sibling, back
 * up the current file to `.bak` (when one exists), then rename the temp file
 * into place with an EPERM/EBUSY retry loop.
 */
function writeClaudeJsonAtomically(
  filePath: string,
  serialized: string,
  existingRaw: string | null,
  renameImpl: (oldPath: string, newPath: string) => void,
  maxRenameAttempts: number,
): { backupPath: string | null; renameAttempts: number } {
  const tmpPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');

  let producedBackup: string | null = null;
  if (existingRaw !== null) {
    fs.copyFileSync(filePath, backupPath);
    producedBackup = backupPath;
  }

  let renameAttempts = 0;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRenameAttempts; attempt++) {
    renameAttempts = attempt;
    try {
      renameImpl(tmpPath, filePath);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (isRetryableRenameError(err) && attempt < maxRenameAttempts) {
        // Short synchronous backoff so we don't busy-spin.
        const until = Date.now() + 25 * attempt;
        while (Date.now() < until) {
          /* spin */
        }
        continue;
      }
      throw err;
    }
  }
  if (lastErr !== undefined) {
    throw lastErr;
  }

  return { backupPath: producedBackup, renameAttempts };
}

/**
 * Read `~/.claude.json` (or `{}` if absent/empty), ensure an `mcpServers`
 * object, set `mcpServers[serverName] = entry`, and write the result back
 * ATOMICALLY (temp file + rename) with a `.bak` backup of the prior file.
 *
 * Idempotent: serialization is deterministic (2-space indent + trailing
 * newline, only one key mutated), so a second merge with the same entry leaves
 * the file bytes unchanged.
 */
export function mergeClaudeJson(options: MergeClaudeJsonOptions): MergeClaudeJsonResult {
  const filePath = options.filePath ?? defaultClaudeJsonPath();
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const entry = options.entry;
  const renameImpl = options._renameImpl ?? fs.renameSync;
  const maxRenameAttempts = options._maxRenameAttempts ?? 3;

  // Read existing content. Treat missing/empty/whitespace-only as `{}`.
  let existingRaw: string | null = null;
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    existingRaw = fs.readFileSync(filePath, 'utf8');
    const trimmed = existingRaw.trim();
    if (trimmed.length > 0) {
      const value = JSON.parse(trimmed) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Refusing to merge: ${filePath} does not contain a JSON object`);
      }
      parsed = value as Record<string, unknown>;
    }
  }

  // Ensure mcpServers is an object, preserving any existing servers.
  const existingServers = parsed['mcpServers'];
  const mcpServers: Record<string, unknown> =
    typeof existingServers === 'object' &&
    existingServers !== null &&
    !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};
  mcpServers[serverName] = entry;
  parsed['mcpServers'] = mcpServers;

  // Deterministic serialization: 2-space indent + trailing newline.
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;

  // Idempotency: if bytes are identical, skip write entirely. A second run
  // therefore leaves the file untouched (no .bak churn, no temp file).
  if (existingRaw !== null && existingRaw === serialized) {
    return {
      filePath,
      backupPath: null,
      unchanged: true,
      renameAttempts: 0,
    };
  }

  // Atomic write: temp file -> backup current -> rename temp into place.
  const written = writeClaudeJsonAtomically(
    filePath,
    serialized,
    existingRaw,
    renameImpl,
    maxRenameAttempts,
  );

  return {
    filePath,
    backupPath: written.backupPath,
    unchanged: false,
    renameAttempts: written.renameAttempts,
  };
}

export interface RemoveClaudeJsonServerOptions {
  /** Target file. Defaults to `~/.claude.json`. */
  filePath?: string;
  /** Key under `mcpServers` to remove. Defaults to `'wood-fired-tasks'`. */
  serverName?: string;
  /** Internal DI seam for the atomic rename (mirrors {@link MergeClaudeJsonOptions}). */
  _renameImpl?: (oldPath: string, newPath: string) => void;
  /** Internal: max rename attempts on EPERM/EBUSY. Defaults to 3. */
  _maxRenameAttempts?: number;
}

export interface RemoveClaudeJsonServerResult {
  /** Absolute path that was targeted. */
  filePath: string;
  /** Path of the `.bak` backup, or null when nothing was removed (no write). */
  backupPath: string | null;
  /** True when the key existed and was removed (a write happened). */
  removed: boolean;
  /** Number of rename attempts performed (0 when the removal was a no-op). */
  renameAttempts: number;
}

/**
 * Remove `mcpServers[serverName]` from `~/.claude.json`, atomically and with a
 * `.bak` backup — the inverse of {@link mergeClaudeJson}, used when `tasks
 * setup` converts an install between local and remote modes so the OTHER
 * mode's MCP entry does not accrete forever.
 *
 * Strict no-op contract: when the file is absent/empty, has no `mcpServers`
 * object, or the key is not present, NOTHING is written — no temp file, no
 * `.bak` churn — so re-running the same setup mode stays byte-idempotent.
 * All foreign `mcpServers` keys and all non-`mcpServers` content are preserved
 * verbatim (same deterministic 2-space + trailing-newline serialization as the
 * merge).
 */
export function removeClaudeJsonServer(
  options: RemoveClaudeJsonServerOptions = {},
): RemoveClaudeJsonServerResult {
  const filePath = options.filePath ?? defaultClaudeJsonPath();
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const renameImpl = options._renameImpl ?? fs.renameSync;
  const maxRenameAttempts = options._maxRenameAttempts ?? 3;

  const noop: RemoveClaudeJsonServerResult = {
    filePath,
    backupPath: null,
    removed: false,
    renameAttempts: 0,
  };

  // Absent/empty file → nothing to remove, nothing to write.
  if (!fs.existsSync(filePath)) return noop;
  const existingRaw = fs.readFileSync(filePath, 'utf8');
  const trimmed = existingRaw.trim();
  if (trimmed.length === 0) return noop;

  const value = JSON.parse(trimmed) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Refusing to modify: ${filePath} does not contain a JSON object`);
  }
  const parsed = value as Record<string, unknown>;

  const existingServers = parsed['mcpServers'];
  if (
    typeof existingServers !== 'object' ||
    existingServers === null ||
    Array.isArray(existingServers)
  ) {
    return noop;
  }
  const mcpServers = existingServers as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(mcpServers, serverName)) {
    return noop;
  }

  delete mcpServers[serverName];

  // Deterministic serialization: 2-space indent + trailing newline (identical
  // to mergeClaudeJson, so merge/remove sequences stay byte-stable).
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  const written = writeClaudeJsonAtomically(
    filePath,
    serialized,
    existingRaw,
    renameImpl,
    maxRenameAttempts,
  );

  return {
    filePath,
    backupPath: written.backupPath,
    removed: true,
    renameAttempts: written.renameAttempts,
  };
}
