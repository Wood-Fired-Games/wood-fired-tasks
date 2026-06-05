#!/usr/bin/env node
// pack-check.mjs — npm pack tarball hygiene assertions.
//
// Runs `npm pack --dry-run --json`, parses the file list, and enforces:
//   PRESENT:  at least one dist/ entry, dist/skills/tasks/ entries, and
//             dist/skills/agents/ entries (the shipped agent skills).
//   ABSENT:   any *.test.* / *.spec.* file, any *.map sourcemap, and any
//             client-package / wood-fired-tasks-client.zip entry.
//
// Exits non-zero with a clear message listing offending/missing entries on
// any violation; exits 0 on a clean package. Wired into `npm run pack:check`
// and (transitively) `prepublishOnly`.

import { execFileSync } from 'node:child_process';

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
      'no test/spec, no sourcemaps, no client-package artifacts.',
  );
  process.exit(0);
}

main();
