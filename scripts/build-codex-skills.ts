import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { parse } from 'yaml';

/** Generate adapters; skills/tasks remains the only authored workflow source. */
export function buildCodexSkills(root: string): void {
  const out = join(root, 'dist/skills/codex');
  rmSync(out, { recursive: true, force: true });
  const references = join(out, '.wood-fired-tasks/references');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const write = (file: string, body: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const tasks = readdirSync(join(root, 'skills/tasks'))
    .filter((file) => file.endsWith('.md'))
    .sort();
  const agents = readdirSync(join(root, 'skills/agents')).filter(
    (file) => file.endsWith('.md') && file !== 'README.md',
  );
  const sources = [
    ...tasks.map((file) => `skills/tasks/${file}`),
    ...agents.map((file) => `skills/agents/${file}`),
  ];
  // Keep linked Markdown contracts with their original relative layout. Code
  // links refer to the working repository; they are not installed executables.
  const queued = new Set(sources);
  for (const source of queued) {
    const raw = readFileSync(join(root, source), 'utf8');
    write(join(references, source), raw);
    const candidates = [
      ...Array.from(raw.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g), (match) => {
        const target = match[1]!;
        return /^(?:docs|skills)\//.test(target)
          ? target
          : relative(root, resolve(root, dirname(source), target)).replaceAll('\\', '/');
      }),
      ...Array.from(raw.matchAll(/\bdocs\/[A-Za-z0-9_./-]+\.md\b/g), (match) => match[0]),
    ];
    for (const candidate of candidates) {
      if (
        /^(docs|skills)\//.test(candidate) &&
        !candidate.includes('..') &&
        existsSync(join(root, candidate))
      )
        queued.add(candidate);
    }
  }
  write(join(references, 'VERSION'), `${version}\n`);
  let count = 0;
  for (const file of tasks) {
    const raw = readFileSync(join(root, 'skills/tasks', file), 'utf8');
    if (/^disable-model-invocation:\s*true\s*$/m.test(raw)) continue;
    const name = `tasks-${file.slice(0, -3)}`;
    const descriptionLine = raw.match(/^description:\s*(.+)$/m)?.[1];
    if (!descriptionLine) throw new Error(`Missing description: ${file}`);
    // Parse only the description scalar: Claude argument-hint frontmatter is
    // not necessarily valid YAML (e.g. [task-id] [comment]).
    const description = parse(`description: ${descriptionLine}`).description;
    if (typeof description !== 'string') throw new Error(`Invalid description: ${file}`);
    const ref = '../.wood-fired-tasks/references';
    write(
      join(out, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${JSON.stringify(`Wood Fired Tasks: ${description}`)}\n---\n\n# ${name}\n\nGenerated from wood-fired-tasks ${version}. Read [the workflow](${ref}/skills/tasks/${file}) and follow it using the Codex mapping below. Shared contracts are in the same reference tree: [loop-shared](${ref}/skills/tasks/loop-shared.md), [enums](${ref}/skills/tasks/_enums.md), [WSJF rubric](${ref}/skills/tasks/wsjf-rubric.md). Read them when the workflow calls for them.\n\n## Codex mapping\n\n- Treat the user's text after this skill invocation as \`$ARGUMENTS\`. Translate \`/tasks:name\` references to \`$tasks-name\`. Resolve relative document links from the referenced document; \`docs/\` and \`skills/\` paths in prose are rooted at the bundled references directory. Source-code paths describe the working repository, not installed helper programs.\n- The canonical references retain Claude syntax for shared maintenance. Their Claude frontmatter, \`ToolSearch\`, \`Task\`, \`TaskOutput\`, \`AskUserQuestion\`, \`TodoWrite\`, \`Bash\`, \`Read\`, \`Edit\`, and \`Grep\` names are not registered Codex capabilities. Use the shell, file, search, planning, question and delegation tools actually exposed by this session. Batch independent calls using the session's supported tool mechanism (including awaited promises when offered).\n- Discover the configured Wood Fired Tasks MCP tools and their schemas before calling them. \`wood-fired-tasks:<verb>\` means the corresponding verb on the user's configured local or remote server; use the exact discovered name, including any namespace normalization. If tools are deferred, use the session's available tool search. If unavailable, report the connection problem and the documented setup command; do not invent a tool name or claim a successful call.\n- [tasks-verifier](${ref}/skills/agents/tasks-verifier.md) and [integration-auditor](${ref}/skills/agents/integration-auditor.md) are role references, not installed Codex agents. When a workflow requires independent verification, supply the relevant role instructions to a separate available agent context; the implementing worker cannot verify its own work. Preserve evidence and read-only verification requirements. If the session cannot provide required delegation, isolation or independence, report the limitation before the dependent claim/mutation or dispatch. Continue independent authorized steps.\n- Resolve model policy through the actual server catalog and the session's supported choices. Claude model aliases and \`subagent_type\` values do not name Codex models or agents. Use the canonical documented \`inherit\` fallback where supported, recording it truthfully. If an explicit required model cannot be honored, report that limitation before dependent work; never invent a model mapping or write unsupported model IDs.\n- For this Codex installation, run \`tasks self-update --target codex\` when the update workflow calls for self-update. A fresh Codex session may be needed to reload changed skills and MCP config. Native installation and read-only smoke coverage do not establish complete runtime parity for delegation/model-dependent workflows.\n\nThe mapping adapts harness mechanics only. Preserve the canonical workflow's task semantics, validation requirements and the user's existing authorization and scope.\n`,
    );
    count++;
  }
  console.log(
    `Built ${count} Codex skill entrypoints and ${queued.size} shared reference documents.`,
  );
}
