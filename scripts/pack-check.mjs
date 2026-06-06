#!/usr/bin/env node
// pack-check.mjs — npm pack tarball hygiene assertions.
//
// Runs `npm pack --dry-run --json`, parses the file list, and enforces:
//   PRESENT:  at least one dist/ entry, dist/skills/tasks/ entries,
//             dist/skills/agents/ entries (the shipped agent skills), and the
//             CURATED user-facing guides the `docs` command catalogs (task
//             #750) — e.g. docs/USAGE_PATTERNS.md, docs/SETUP.md, docs/CLI.md.
//   ABSENT:   any *.test.* / *.spec.* file, any *.map sourcemap, any
//             client-package / wood-fired-tasks-client.zip entry, and any
//             INTERNAL/DEV doc that must never ship (task #750) — e.g.
//             docs/REPO_MAP.md, docs/RELEASE.md, docs/loop-run-schema.md,
//             anything under docs/superpowers/ or docs/rename/.
//
// Exits non-zero with a clear message listing offending/missing entries on
// any violation; exits 0 on a clean package. Wired into `npm run pack:check`
// and (transitively) `prepublishOnly`.

import { execFileSync } from 'node:child_process';

// --- Curated user-facing guides that MUST ship --------------------------------
// Kept in lock-step with `package.json` `files` AND the `docs` command catalog
// (src/cli/commands/docs.ts DOCS_CATALOG). If a guide is added to the catalog
// and shipped, add it here too so `docs show <name>` can never 404 on install.
const REQUIRED_DOCS = [
  'docs/USAGE_PATTERNS.md',
  'docs/SETUP.md',
  'docs/CLI.md',
  'docs/API.md',
  'docs/MCP.md',
  'docs/NAVIGATION.md',
  'docs/AGENT_CONTEXT.md',
  'docs/INTERFACES.md',
  'docs/WORKFLOWS.md',
  'docs/SLACK.md',
  'docs/RELIABILITY.md',
  'docs/TROUBLESHOOTING.md',
  'docs/ARCHITECTURE.md',
  'docs/README.md',
];

// --- Internal/dev docs that must NEVER ship -----------------------------------
// Exact-match files plus directory prefixes. These are repo-internal authoring
// artifacts; shipping them would leak roadmaps/design notes into the tarball.
const FORBIDDEN_DOC_FILES = [
  'docs/REPO_MAP.md',
  'docs/CODE_QUALITY_ROADMAP.md',
  'docs/RELEASE.md',
  'docs/ONBOARDING_SMOKE.md',
  'docs/loop-run-schema.md',
  'docs/loop-run-schema.json',
  'docs/tasks-decompose-design.md',
  'docs/tasks-audit-design.md',
  'docs/AGENT_READINESS_AUDIT.md',
  'docs/event-router-design.md',
  'docs/verifier-contract.md',
  'docs/loop-run-reference-example.md',
];
const FORBIDDEN_DOC_PREFIXES = [
  'docs/superpowers/',
  'docs/rename/',
  'docs/retrospectives/',
  'docs/automation-recipes/',
  'docs/hooks/',
];

/** @returns {string[]} list of file paths that would be published */
function getPackedFiles() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0].files)) {
    throw new Error('Unexpected `npm pack --dry-run --json` output shape.');
  }
  // Normalize to forward slashes for stable matching across platforms.
  return parsed[0].files.map((f) => String(f.path).replace(/\\/g, '/'));
}

function main() {
  const files = getPackedFiles();

  const violations = [];

  // --- PRESENT assertions -------------------------------------------------
  const hasDist = files.some((p) => p.startsWith('dist/'));
  const skillsTasks = files.filter((p) => p.startsWith('dist/skills/tasks/'));
  const skillsAgents = files.filter((p) => p.startsWith('dist/skills/agents/'));

  if (!hasDist) {
    violations.push('MISSING: no `dist/` entries in the tarball (compiled output absent).');
  }
  if (skillsTasks.length === 0) {
    violations.push('MISSING: no `dist/skills/tasks/` entries (tasks skill not shipped).');
  }
  if (skillsAgents.length === 0) {
    violations.push('MISSING: no `dist/skills/agents/` entries (agents skill not shipped).');
  }

  // Curated user-facing guides the `docs` command maps to MUST be present.
  const fileSet = new Set(files);
  const missingDocs = REQUIRED_DOCS.filter((d) => !fileSet.has(d));
  if (missingDocs.length > 0) {
    violations.push(
      `MISSING: ${missingDocs.length} curated guide(s) absent from tarball ` +
        `(the \`docs\` command would 404 on these):\n    ` +
        missingDocs.join('\n    '),
    );
  }

  // --- ABSENT assertions --------------------------------------------------
  const testFiles = files.filter((p) => /\.(test|spec)\./.test(p));
  const mapFiles = files.filter((p) => p.endsWith('.map'));
  const clientFiles = files.filter(
    (p) => /client-package/.test(p) || /wood-fired-tasks-client\.zip$/.test(p),
  );

  if (testFiles.length > 0) {
    violations.push(
      `FORBIDDEN: ${testFiles.length} test/spec file(s) in tarball:\n    ` +
        testFiles.join('\n    '),
    );
  }
  if (mapFiles.length > 0) {
    violations.push(
      `FORBIDDEN: ${mapFiles.length} sourcemap (*.map) file(s) in tarball:\n    ` +
        mapFiles.join('\n    '),
    );
  }
  if (clientFiles.length > 0) {
    violations.push(
      `FORBIDDEN: ${clientFiles.length} client-package artifact(s) in tarball:\n    ` +
        clientFiles.join('\n    '),
    );
  }

  // Internal/dev docs must NEVER ship (exact files + directory prefixes).
  const internalDocs = files.filter(
    (p) =>
      FORBIDDEN_DOC_FILES.includes(p) ||
      FORBIDDEN_DOC_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
  if (internalDocs.length > 0) {
    violations.push(
      `FORBIDDEN: ${internalDocs.length} internal/dev doc(s) leaked into tarball ` +
        `(must stay repo-internal):\n    ` +
        internalDocs.join('\n    '),
    );
  }

  if (violations.length > 0) {
    console.error('pack:check FAILED — tarball hygiene violations:\n');
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    console.error(`\nInspected ${files.length} packed file(s).`);
    process.exit(1);
  }

  console.log(
    `pack:check OK — ${files.length} packed file(s): ` +
      `dist present, ${skillsTasks.length} tasks-skill + ${skillsAgents.length} agents-skill entries, ` +
      `${REQUIRED_DOCS.length} curated guides present, ` +
      'no internal/dev docs, no test/spec, no sourcemaps, no client-package artifacts.',
  );
  process.exit(0);
}

main();
