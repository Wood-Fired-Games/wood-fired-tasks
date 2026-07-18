#!/usr/bin/env node
// validate-sha.mjs — client-side PreToolUse guard against fabricated git SHAs
// in task evidence.
//
// VENDOR-NEUTRAL CORE: this script reads a JSON tool-call payload on stdin and,
// for task-tracker tools that carry "evidence" text (a comment body or a task's
// verification evidence), extracts every token that looks like a git object id
// and asks the LOCAL git repo (process.cwd()) whether each one actually exists
// via `git cat-file -t <token>`. If any candidate SHA is unknown to git, the
// tool call is blocked. This protects against an agent writing a commit hash
// into task evidence that does not exist in the repo the work was done in.
//
// It works with ANY MCP client that supports a PreToolUse-style hook: the only
// client-specific piece is HOW the client invokes this script and how it reads
// the decision back. The companion claude-code-settings.example.json shows the
// Claude Code binding. The stdin payload shape this script reads
// ({ tool_name, tool_input }) and the stdout decision shape it emits
// (Claude Code's PreToolUse hookSpecificOutput) are the Claude Code contract;
// adapt the thin read/emit layer for other clients.
//
// HONEST LIMITATION: this only catches SHA tokens that do NOT exist in the
// local repo. It cannot tell whether a real-but-wrong SHA is the *correct* one,
// and it does not validate any other fabricated evidence (row counts, dollar
// figures, exit codes, test pass counts). Those remain the reviewer's job.
//
// BACKEND-AWARE DISPATCH (docs/superpowers/specs/2026-07-16-pluggable-scm-design.md
// §4.5 / §5.1 / §5.3): the evidence envelope's `commit_shas` field generalizes
// to "change-ids" that carry bare git hex SHAs (unchanged, validated as
// before), Perforce changelist ids as a literal `p4:<digits>` token, or are
// empty for none-mode. This hook dispatches on shape:
//   - bare 7-40 char hex run  -> git object existence check (unchanged).
//   - `p4:<digits>`           -> accepted by shape alone, no probe — there is
//     no git object to check, and this reference hook does not shell out to
//     `p4` (a live changelist-existence probe is a documented future
//     extension, not this hook's job today).
//   - no candidates of either shape (including an explicitly empty change-id
//     array) -> allow; §B's escape hatch already treats empty as a
//     legitimate none-mode state, not fabrication.

import { spawnSync } from 'node:child_process';

// --- tool field map -------------------------------------------------------
// Which tool_input field carries the evidence text we should scan. The tool
// name arrives namespaced by the MCP client (e.g. mcp__wood-fired-tasks__...),
// so we match on the trailing tool segment to stay client-prefix-agnostic.
//
//   add_comment   -> scan `content`
//   update_task   -> scan `verification_evidence` (stringified — it may be an
//                     object/array of structured evidence)
const TOOL_FIELDS = {
  add_comment: 'content',
  update_task: 'verification_evidence',
};

// A candidate git object id: a standalone hex run of 7-40 chars. The \b word
// boundaries plus the surrounding guard below ensure we only flag a hex run
// that is NOT embedded inside a longer alphanumeric word (so we don't trip on
// the hex prefix of a UUID, an API key, or a base-16 chunk of a longer token).
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;

// A candidate Perforce changelist change-id: the literal `p4:` prefix
// immediately followed by one or more decimal digits, as a standalone token
// (word boundary on both sides so it isn't a substring of a longer word).
// Perforce change numbers are decimal-only, so this shape never collides
// with the git hex-SHA pattern above.
const P4_RE = /\bp4:\d+\b/gi;

/**
 * Pull standalone `p4:<digits>` tokens out of `text`. Returns a
 * de-duplicated lowercase list; these are accepted by shape alone (see the
 * BACKEND-AWARE DISPATCH note at the top of this file) — never probed.
 */
function extractP4Ids(text) {
  const out = new Set();
  for (const m of text.matchAll(P4_RE)) {
    out.add(m[0].toLowerCase());
  }
  return [...out];
}

/** Read all of stdin as a string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** True if cwd is inside a git work tree; false otherwise (and on any error). */
function inGitRepo(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** True if `token` resolves to a known git object in `cwd`. */
function shaExists(token, cwd) {
  const r = spawnSync('git', ['cat-file', '-t', token], {
    cwd,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/**
 * Pull standalone hex runs (length 7-40) out of `text`, rejecting any run that
 * abuts an alphanumeric character — i.e. hex that is really part of a longer
 * word/token rather than a bare SHA. Returns a de-duplicated lowercase list.
 */
function extractCandidates(text) {
  const out = new Set();
  for (const m of text.matchAll(SHA_RE)) {
    const tok = m[0];
    const start = m.index ?? 0;
    const end = start + tok.length;
    const before = start > 0 ? text[start - 1] : '';
    const after = end < text.length ? text[end] : '';
    // \b already excludes adjacent [A-Za-z0-9_]. We additionally reject runs
    // that abut '-' or '.' so a hex *segment* of a hyphen/dot-delimited token
    // (a UUID like deadbeef-1234-..., a dotted version, a filename.0a1b2c3) is
    // not mistaken for a standalone commit SHA. A real git SHA in prose is
    // delimited by whitespace/punctuation like (), [], commas, or sentence
    // ends — never by '-' or '.' touching the hex itself.
    if (/[a-z0-9_.-]/i.test(before) || /[a-z0-9_.-]/i.test(after)) continue;
    // A real git object id is hex; a run with no a-f letter is a plain decimal
    // number (a row count, a Unix timestamp, a PID, a port) that only *looks*
    // like a short SHA. Skip it — git short SHAs are effectively always mixed
    // hex, and blocking honest numeric evidence would be a false positive (the
    // exact numeric evidence the loop records).
    if (!/[a-f]/i.test(tok)) continue;
    out.add(tok.toLowerCase());
  }
  return [...out];
}

/** Coerce a tool_input field into a scannable string. */
function fieldToString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Emit a Claude Code PreToolUse deny decision and exit 0. */
function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

/** Allow: no decision, normal permission flow applies. */
function allow() {
  process.exit(0);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Unparseable payload — not our job to block; let normal flow handle it.
    allow();
    return;
  }

  const toolName = String(payload?.tool_name ?? '');
  const toolInput = payload?.tool_input ?? {};

  // Match on the trailing tool segment so we work regardless of MCP namespace
  // prefix (e.g. "mcp__wood-fired-tasks__add_comment" -> "add_comment").
  const segment = toolName.split('__').pop() ?? toolName;
  const field = TOOL_FIELDS[segment];
  if (!field) {
    allow();
    return;
  }

  const text = fieldToString(toolInput[field]);
  if (!text) {
    allow();
    return;
  }

  // `p4:<digits>` change-ids are accepted by shape alone (no git object to
  // check), so strip them from the text before hex-scanning — they must
  // never re-enter the git-verification path below. This also covers
  // none-mode's empty change-id array: with no p4: tokens and no hex-SHA
  // tokens left in the text, `candidates` is empty and we fall straight
  // through to allow() — §B's escape hatch already treats empty as a
  // legitimate state, not fabrication.
  const p4Ids = extractP4Ids(text);
  const textForShaScan = p4Ids.length > 0 ? text.replace(P4_RE, '') : text;

  const candidates = extractCandidates(textForShaScan);
  if (candidates.length === 0) {
    allow();
    return;
  }

  // The repo to check against is wherever the client is running.
  const cwd = process.cwd();
  if (!inGitRepo(cwd)) {
    // Not in a git repo — we cannot verify, so we must not block.
    allow();
    return;
  }

  const missing = candidates.filter((tok) => !shaExists(tok, cwd));
  if (missing.length > 0) {
    deny(
      `Task evidence references git object id(s) that do not exist in this repo (${cwd}): ` +
        `${missing.join(', ')}. This looks like a fabricated or mistyped commit SHA. ` +
        `Verify the hash with 'git log' / 'git rev-parse HEAD' before recording it as evidence.`,
    );
    return;
  }

  allow();
}

main();
