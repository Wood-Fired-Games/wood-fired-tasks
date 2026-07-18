#!/usr/bin/env tsx
/**
 * Validate `.agent-context.json` against the authoritative table.
 *
 * Fails with a non-zero exit code if:
 *   1. Any "present" entry references a path that doesn't exist on disk.
 *   2. Any "present" entry exceeds its `line_budget` (failure message
 *      includes the approximate token estimate so contributors can see
 *      how far over the "few tokens as possible" target they are).
 *   3. Any "present" entry lacks an `Owner:` line in the first 3 lines
 *      (skipped for files in OWNER_LINE_EXEMPT, e.g. README.md, SECURITY.md).
 *   4. The on-disk `.agent-context.json` differs from a freshly generated
 *      manifest (other than the `_generated.generated_at` timestamp).
 *   5. Any internal markdown link in a "present" `.md` file points at a
 *      relative path that does not exist on disk.
 *   6. Any adapter file (authority === 'adapter', status === 'present')
 *      does not contain a markdown link to `AGENTS.md`. Adapters MUST
 *      point at the canonical entry — that is the only thing that makes
 *      them adapters rather than rogue vendor-specific docs.
 *   7. Any "present" file contains forbidden content per contract section
 *      4.4: secret/credential-shaped strings, local absolute filesystem
 *      paths (`/home/...`, `/Users/...`, `C:\...`), or personal
 *      (non-project) email addresses. See `scanTextForForbiddenContent`.
 *
 * This script reads only files inside the repository (.md sources, the
 * committed .agent-context.json, and the in-process manifest.ts source).
 * It NEVER opens data/*.db, .env, ~/.claude.json, or any HTTP endpoint.
 *
 * Usage:
 *   npm run agent-context:check
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type AgentContextManifest,
  MANIFEST_PATH,
  OWNER_LINE_EXEMPT,
  approxTokensForLines,
  buildManifest,
  findRepoRoot,
  validateInternalLinks,
} from './manifest.js';

interface CheckResult {
  errors: string[];
  warnings: string[];
}

/**
 * Match a markdown link whose target resolves to `AGENTS.md` at the repo
 * root. Accepts `AGENTS.md`, `./AGENTS.md`, and any `#fragment` suffix.
 * Used by the adapter-link check (see rule 6 in the file header comment).
 */
const ADAPTER_AGENTS_LINK_RE = /\]\((?:\.\/)?AGENTS\.md(?:#[^)]*)?\)/;

// ---------------------------------------------------------------------------
// Rule 7: forbidden-content scan (contract section 4.4)
// ---------------------------------------------------------------------------
//
// Scans every "present" agent-facing file (the same file set already
// covered by rules 1-3 above) for content the contract's section 4.4 says
// must never appear: secret/credential-shaped strings, local absolute
// filesystem paths, and personal (non-project) email addresses.
//
// Two allowlists exist because the current tracked docs legitimately
// contain lookalikes used as illustrative examples:
//   - ALLOWED_EMAIL_DOMAINS: RFC 2606 reserved placeholder domains used
//     throughout the docs (alice@example.com, you@example.com, ...), plus
//     the project's own support domain (security@woodfiredgames.com in
//     SECURITY.md). Any email whose domain is NOT in this set is flagged.
//   - ALLOWLISTED_ABSOLUTE_PATHS: a small, file-scoped list of the exact
//     strings the path pattern matches in today's tree, all of which are
//     documentation placeholders rather than real machine paths. Each
//     entry is commented with why it's safe. Anything not in this list
//     still fails the scan.
//
// Secret/credential patterns have NO allowlist — a real match is always an
// error; none of the current tracked docs match them (verified when this
// rule was added).

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS access key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitLab personal access token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]+\b/ },
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Stripe live secret key', re: /\bsk_live_[0-9a-zA-Z]{20,}\b/ },
  {
    name: 'JWT-shaped token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

// Matches `/home/<segment>`, `/Users/<segment>`, or a Windows `C:\<segment>`
// path. Stops at the next `/` (or end of the allowed char class) so a full
// multi-segment path still yields a short, allowlist-friendly match.
const ABSOLUTE_PATH_RE =
  /(?:\/home\/[A-Za-z0-9_.-]+|\/Users\/[A-Za-z0-9_.-]+|[A-Za-z]:\\[A-Za-z0-9_.\\-]+)/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// RFC 2606 reserved placeholder domains (used for illustrative examples
// throughout the docs) plus the project's own support domain. Anything
// else is treated as a personal/real address and flagged.
const ALLOWED_EMAIL_DOMAINS = new Set<string>([
  'example.com',
  'example.org',
  'example.net',
  'woodfiredgames.com',
]);

// file path -> exact strings the ABSOLUTE_PATH_RE match yields for that
// file today. Each is a documentation placeholder, not a real local path.
const ALLOWLISTED_ABSOLUTE_PATHS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Section 4.4's own bullet illustrates the forbidden-path shapes using
  // literal ellipsis placeholders — not real paths.
  'docs/AGENT_CONTEXT.md': new Set(['/home/...', '/Users/...', 'C:' + '\\' + '\\' + '...']),
  // Example MCP client config using the generic placeholder username
  // "you" (as in "replace with your own"), not a real developer's machine
  // path.
  'docs/MCP.md': new Set(['/home/you']),
};

/**
 * Scan one file's text for contract section 4.4 forbidden content. Returns
 * a list of `"<path>:<line>: <message>"` error strings; empty means clean.
 * Exported for direct unit testing without touching disk.
 */
export function scanTextForForbiddenContent(filePath: string, text: string): string[] {
  const errors: string[] = [];
  const lines = text.split('\n');
  const pathAllowlist = ALLOWLISTED_ABSOLUTE_PATHS[filePath];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        errors.push(`${filePath}:${lineNo}: forbidden content — looks like a ${name}.`);
      }
    }

    ABSOLUTE_PATH_RE.lastIndex = 0;
    let pathMatch: RegExpExecArray | null = ABSOLUTE_PATH_RE.exec(line);
    while (pathMatch !== null) {
      const matched = pathMatch[0];
      if (!pathAllowlist?.has(matched)) {
        errors.push(`${filePath}:${lineNo}: forbidden content — local absolute path "${matched}".`);
      }
      pathMatch = ABSOLUTE_PATH_RE.exec(line);
    }

    EMAIL_RE.lastIndex = 0;
    let emailMatch: RegExpExecArray | null = EMAIL_RE.exec(line);
    while (emailMatch !== null) {
      const domain = (emailMatch[1] ?? '').toLowerCase();
      if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
        errors.push(
          `${filePath}:${lineNo}: forbidden content — non-project email address "${emailMatch[0]}".`,
        );
      }
      emailMatch = EMAIL_RE.exec(line);
    }
  }

  return errors;
}

function normalizeForCompare(m: AgentContextManifest): Omit<AgentContextManifest, '_generated'> & {
  _generated: Omit<AgentContextManifest['_generated'], 'generated_at'>;
} {
  const { generated_at: _ignored, ...generatedRest } = m._generated;
  return {
    ...m,
    _generated: generatedRest,
  };
}

export function runChecks(repoRoot: string): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const fresh = buildManifest({ repoRoot });

  for (const entry of fresh.files) {
    if (entry.status !== 'present') continue;

    if (entry.actual_lines === undefined) {
      errors.push(`File "${entry.path}" is marked status=present but does not exist on disk.`);
      continue;
    }

    if (entry.actual_lines > entry.line_budget) {
      const actualTokens = approxTokensForLines(entry.actual_lines);
      errors.push(
        `File "${entry.path}" exceeds its line budget: ${entry.actual_lines} > ${entry.line_budget} (~${actualTokens} tokens vs ~${entry.approx_token_budget} budget).`,
      );
    }

    if (!OWNER_LINE_EXEMPT.has(entry.path)) {
      if (entry.actual_owner === undefined) {
        errors.push(`File "${entry.path}" is missing an "Owner:" line in its first 3 lines.`);
      }
    }
  }

  for (const linkErr of validateInternalLinks(repoRoot)) {
    errors.push(linkErr.message);
  }

  // Adapter files MUST link to AGENTS.md — that is what distinguishes an
  // adapter from a rogue vendor-specific doc. Check applies to every
  // present adapter regardless of file extension (covers CLAUDE.md and
  // llms.txt). Anchored fragments are accepted.
  for (const entry of fresh.files) {
    if (entry.authority !== 'adapter') continue;
    if (entry.status !== 'present') continue;
    const abs = resolve(repoRoot, entry.path);
    if (!existsSync(abs)) continue; // file-exists already reported above
    const text = readFileSync(abs, 'utf8');
    if (!ADAPTER_AGENTS_LINK_RE.test(text)) {
      errors.push(
        `Adapter file "${entry.path}" does not link to AGENTS.md — adapters must point to the canonical entry.`,
      );
    }
  }

  // Rule 7: forbidden-content scan (section 4.4). Runs over every
  // "present" file — the same set already covered by rules 1-3 above.
  for (const entry of fresh.files) {
    if (entry.status !== 'present') continue;
    const abs = resolve(repoRoot, entry.path);
    if (!existsSync(abs)) continue; // file-exists already reported above
    const text = readFileSync(abs, 'utf8');
    errors.push(...scanTextForForbiddenContent(entry.path, text));
  }

  const manifestAbsPath = resolve(repoRoot, MANIFEST_PATH);
  if (!existsSync(manifestAbsPath)) {
    errors.push(`Manifest file "${MANIFEST_PATH}" is missing — run \`npm run agent-context:gen\`.`);
  } else {
    const onDiskText = readFileSync(manifestAbsPath, 'utf8');
    let onDisk: AgentContextManifest;
    try {
      onDisk = JSON.parse(onDiskText) as AgentContextManifest;
    } catch (err) {
      errors.push(`Manifest file "${MANIFEST_PATH}" is not valid JSON: ${(err as Error).message}`);
      return { errors, warnings };
    }
    const a = JSON.stringify(normalizeForCompare(onDisk));
    const b = JSON.stringify(normalizeForCompare(fresh));
    if (a !== b) {
      errors.push(
        `Manifest file "${MANIFEST_PATH}" is out of date — run \`npm run agent-context:gen\` and commit the result.`,
      );
    }
  }

  return { errors, warnings };
}

function main(): void {
  const repoRoot = findRepoRoot();
  const { errors, warnings } = runChecks(repoRoot);
  for (const w of warnings) {
    console.warn(`warn: ${w}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`error: ${e}`);
    }
    console.error(`agent-context:check failed with ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log('agent-context:check OK.');
}

// Only run when executed as a script, not when imported by tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check.ts') ||
  process.argv[1]?.endsWith('check.js');
if (isMain) {
  main();
}
