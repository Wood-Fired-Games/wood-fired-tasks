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
const SRC_DIR = join(REPO_ROOT, 'skills', 'tasks');
const OUT_DIR = join(REPO_ROOT, 'dist', 'skills', 'tasks');

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

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.md'));
  let count = 0;
  for (const name of files) {
    const raw = readFileSync(join(SRC_DIR, name), 'utf8');
    const processed = stripDevLinks(raw);
    writeFileSync(join(OUT_DIR, name), processed, 'utf8');
    count += 1;
  }

  console.log(
    `Built ${count} skill file(s): ${SRC_DIR} -> ${OUT_DIR} (dev links stripped).`,
  );
}

main();
