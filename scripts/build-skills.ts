#!/usr/bin/env tsx
/**
 * Build packaged skills from the single canonical source.
 *
 * Reads every `skills/tasks/*.md` (the canonical skill source consumed by the
 * asset resolver, see project #36 / task #730) and emits a processed copy into
 * `dist/skills/tasks/<same-name>.md` with all repo-relative dev links stripped.
 *
 * Why strip links:
 *   The canonical sources cross-reference each other and the repo tree
 *   (e.g. `](loop-shared.md)`, `](./wsjf-rubric.md)`, `](../../src/...)`,
 *   `](docs/...)`). Those targets do not exist in an installed npm package, so
 *   they would render as dead links for npm-only users. We convert each such
 *   link to plain text (keep the human-readable link text, drop the broken
 *   target). Absolute `http(s)://` links are preserved verbatim.
 *
 * Dev-link rule (regex `DEV_LINK`):
 *   Match a markdown inline link `[text](target)` whose `target` is NOT an
 *   absolute URL and resolves into the repo tree, i.e. the target starts with
 *   one of:
 *     - `./` or `../`              (explicit relative path)
 *     - `src/` or `docs/`          (repo top-level dirs)
 *     - a bare `<name>.md[...]`    (sibling skill file, optional #anchor)
 *   Such a link is replaced with just its `text`. The `target` may carry a
 *   trailing `#anchor`, which is dropped along with the rest of the link.
 *
 * `dist/` is gitignored — this output is regenerated on demand by the build.
 *
 * Usage:
 *   npm run build:skills        # tsx scripts/build-skills.ts
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * A skill source dir to process. Each canonical `skills/<name>/` dir is read,
 * its `*.md` sources have dev links stripped, and the result is emitted into
 * the matching `dist/skills/<name>/`.
 *
 * `exclude` lists basenames that are NOT shipped (e.g. `README.md` author docs
 * that only make sense inside the repo, not in `~/.claude/agents/`).
 */
interface SkillPass {
  /** Subdirectory name under `skills/` and `dist/skills/`. */
  name: string;
  /** Basenames to skip (never emitted to dist). */
  exclude: string[];
}

const PASSES: SkillPass[] = [
  { name: 'tasks', exclude: [] },
  // Agent/subagent definitions (tasks-verifier, integration-auditor) back the
  // mandatory verifier in /tasks:loop and /tasks:loop-dag. The authoring
  // README.md is repo-only and excluded from the tarball (task #751).
  { name: 'agents', exclude: ['README.md'] },
];

/**
 * Repo-relative markdown link.
 *
 * Group 1: link text (no nested closing bracket).
 * Group 2: link target — anything not containing `)` — that begins with a
 *          relative-path marker and is therefore NOT an absolute URL.
 *
 * The negative match for `http://` / `https://` is implicit: the alternation
 * only accepts targets starting with `./`, `../`, `src/`, `docs/`, or a bare
 * filename ending in `.md` (optionally followed by `#anchor` / `/...`).
 */
const DEV_LINK =
  /\[([^\]]+)\]\((?:\.\.?\/|src\/|docs\/|[A-Za-z0-9._-]+\.md)[^)]*\)/g;

/** Strip repo-relative dev links from a skill body, keeping the link text. */
export function stripDevLinks(markdown: string): string {
  return markdown.replace(DEV_LINK, (_match, text: string) => text);
}

function buildPass(pass: SkillPass): number {
  const srcDir = join(REPO_ROOT, 'skills', pass.name);
  const outDir = join(REPO_ROOT, 'dist', 'skills', pass.name);
  mkdirSync(outDir, { recursive: true });

  const excluded = new Set(pass.exclude);
  const files = readdirSync(srcDir).filter(
    (f) => f.endsWith('.md') && !excluded.has(f),
  );
  for (const name of files) {
    const raw = readFileSync(join(srcDir, name), 'utf8');
    const processed = stripDevLinks(raw);
    writeFileSync(join(outDir, name), processed, 'utf8');
  }

  console.log(
    `Built ${files.length} skill file(s): ${srcDir} -> ${outDir} (dev links stripped).`,
  );
  return files.length;
}

function main(): void {
  let total = 0;
  for (const pass of PASSES) {
    total += buildPass(pass);
  }
  console.log(`Built ${total} skill file(s) total across ${PASSES.length} dir(s).`);
}

main();
