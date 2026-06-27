/**
 * Tests for the triggers.yaml zod schema and templating-safety pass.
 *
 * Coverage targets (per task #422 AC):
 *   - Valid minimal + valid full configs.
 *   - Unknown top-level key, unknown predicate operator, unknown event type,
 *     unknown handler name → all rejected.
 *   - Templating-safety violations caught by the post-pass.
 *   - `loadAndValidateTriggers` end-to-end against temp YAML files.
 *
 * Vendor-neutrality: test names and YAML fixtures must not name any
 * provider, AI vendor, chat platform, or CI tool.
 */

import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadAndValidateTriggers,
  TriggersConfigSchema,
  validateTemplating,
} from '../triggers-schema.js';

describe('TriggersConfigSchema — valid configs', () => {
  it('accepts a minimal valid config (one rule, one predicate, one handler)', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'minimal-rule',
          on: 'task.created',
          where: { project: 'demo-project' },
          do: 'webhook_post',
          with: { url: 'https://example.invalid/hook' },
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts a full config exercising every predicate operator', () => {
    const config = {
      version: 1,
      defaults: {
        debounce_ms: 1500,
        idempotency_window_s: 3600,
        max_dispatches_per_minute: 60,
        max_retries: 3,
      },
      rules: [
        {
          name: 'every-predicate',
          on: 'task.status_changed',
          where: {
            project: 42,
            status: 'closed',
            status_in: ['open', 'in_progress'],
            from_status: 'open',
            to_status: 'closed',
            tags_contains_all: ['epic', 'bug-fix'],
            tags_contains_any: ['priority', 'flagged'],
            task_id: 100,
            parent_id: 7,
            assignee: 'someone@example.com',
            source: 'user',
            eventType: 'task.status_changed',
          },
          do: 'create_task_in_project',
          with: {
            project: 'downstream',
            title: '{{task.title}}',
            body: '{{task.body}}',
            labels: ['auto-filed'],
            token_env: 'WFT_API_KEY_WRITER',
          },
          debounce_ms: 500,
          idempotency_window_s: 7200,
          max_dispatches_per_minute: 30,
          max_retries: 5,
        },
        {
          name: 'shell-rule',
          on: 'task.created',
          where: { source: 'workflow' },
          do: 'shell_exec',
          with: { command: '/usr/local/bin/my-script' },
        },
        {
          name: 'agent-rule',
          on: 'task.updated',
          where: { task_id: 1 },
          do: 'agent_session_dispatch',
          with: { adapter: 'my-adapter' },
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts the periodic re-sweep knob per-rule and in defaults (task #1035)', () => {
    const config = {
      version: 1,
      defaults: { sweep_interval_s: 45 },
      rules: [
        {
          name: 'periodic-rule',
          on: 'task.created',
          where: { project: 5 },
          do: 'agent_session_dispatch',
          with: { adapter: 'session-adapter' },
          sweep_on_start: true,
          sweep_interval_s: 30,
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts a config with no defaults block', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'no-defaults',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe('TriggersConfigSchema — invalid configs (shape)', () => {
  it('rejects unknown top-level key', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'r',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: {},
        },
      ],
      not_a_real_key: 'oops',
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown predicate operator inside where:', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'r',
          on: 'task.created',
          where: { not_an_operator: 'whatever' },
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown event type on `on:`', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'r',
          on: 'task.exploded',
          where: {},
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown handler name on `do:`', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'r',
          on: 'task.created',
          where: {},
          do: 'kick_something',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects version != 1', () => {
    const config = {
      version: 2,
      rules: [
        {
          name: 'r',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an empty rules array', () => {
    const config = { version: 1, rules: [] };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts a where: with a string assignee operator', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'assignee-rule',
          on: 'task.status_changed',
          where: { assignee: 'someone@example.com' },
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string assignee', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'empty-assignee',
          on: 'task.status_changed',
          where: { assignee: '' },
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects a non-string assignee', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'numeric-assignee',
          on: 'task.status_changed',
          where: { assignee: 123 },
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive or non-integer sweep_interval_s (task #1035)', () => {
    for (const bad of [0, -30, 1.5]) {
      const config = {
        version: 1,
        rules: [
          {
            name: 'r',
            on: 'task.created',
            where: {},
            do: 'webhook_post',
            with: {},
            sweep_interval_s: bad,
          },
        ],
      };
      const result = TriggersConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    }
  });

  it('rejects an unknown status on the status enum', () => {
    const config = {
      version: 1,
      rules: [
        {
          name: 'r',
          on: 'task.status_changed',
          where: { status: 'in-limbo' },
          do: 'webhook_post',
          with: {},
        },
      ],
    };
    const result = TriggersConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe('validateTemplating — substitution-position rule (§Templating rule 1)', () => {
  it('passes when `{{...}}` is the entire string', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'pure-sub',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { title: '{{task.title}}' },
        },
      ],
    });
    expect(validateTemplating(config)).toEqual([]);
  });

  it('rejects a `{{...}}` substitution inside a larger string (prefix + token + suffix)', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'mixed',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { title: 'prefix-{{task.title}}-suffix' },
        },
      ],
    });
    const issues = validateTemplating(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe('rules[0].with.title');
  });

  it('rejects a `{{...}}` substitution inside a string with leading words', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'leading',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { title: 'Auto-filed for {{task.id}}' },
        },
      ],
    });
    const issues = validateTemplating(config);
    expect(issues.length).toBe(1);
    expect(issues[0]?.path).toBe('rules[0].with.title');
  });

  it('walks nested objects and arrays inside `with:`', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'nested',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: {
            depends_on_external: {
              project: 'demo',
              task_ref: 'task-{{task.id}}-thing',
            },
            labels: ['ok', 'mixed-{{task.tag}}-label'],
          },
        },
      ],
    });
    const issues = validateTemplating(config);
    const paths = issues.map((i) => i.path).sort();
    expect(paths).toEqual([
      'rules[0].with.depends_on_external.task_ref',
      'rules[0].with.labels[1]',
    ]);
  });

  it('passes when no template tokens are present at all', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'plain',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { title: 'a literal title', count: 42 },
        },
      ],
    });
    expect(validateTemplating(config)).toEqual([]);
  });

  it('flags an invalid token_env env-var name', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'badenv',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { token_env: 'lower-case-thing' },
        },
      ],
    });
    const issues = validateTemplating(config);
    expect(issues.length).toBe(1);
    expect(issues[0]?.path).toBe('rules[0].with.token_env');
  });

  it('accepts a valid UPPER_SNAKE token_env', () => {
    const config = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'goodenv',
          on: 'task.created',
          where: {},
          do: 'webhook_post',
          with: { token_env: 'WFT_API_KEY_WRITER' },
        },
      ],
    });
    expect(validateTemplating(config)).toEqual([]);
  });
});

describe('loadAndValidateTriggers — end-to-end against temp files', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'wft-router-triggers-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns ok=true for a valid YAML file', async () => {
    const path = join(tmpRoot, 'valid.yaml');
    await writeFile(
      path,
      [
        'version: 1',
        'defaults:',
        '  debounce_ms: 1500',
        'rules:',
        '  - name: ok-rule',
        '    on: task.created',
        '    where:',
        '      project: demo-project',
        '    do: webhook_post',
        '    with:',
        '      url: "https://example.invalid/hook"',
        '      title: "{{task.title}}"',
        '',
      ].join('\n'),
      'utf8',
    );
    // On POSIX the startup trust gate requires mode 0600; writeFile honours the
    // umask (typically 0644), so set the secure mode explicitly.
    if (process.getuid !== undefined) {
      await chmod(path, 0o600);
    }
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with formatted errors for an unknown predicate operator', async () => {
    const path = join(tmpRoot, 'invalid-predicate.yaml');
    await writeFile(
      path,
      [
        'version: 1',
        'rules:',
        '  - name: bad-rule',
        '    on: task.created',
        '    where:',
        '      not_an_operator: oops',
        '    do: webhook_post',
        '    with: {}',
        '',
      ].join('\n'),
      'utf8',
    );
    if (process.getuid !== undefined) {
      await chmod(path, 0o600);
    }
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.startsWith('  - '))).toBe(true);
    }
  });

  it('returns ok=false for a templating-safety violation', async () => {
    const path = join(tmpRoot, 'invalid-template.yaml');
    await writeFile(
      path,
      [
        'version: 1',
        'rules:',
        '  - name: bad-template',
        '    on: task.created',
        '    where: {}',
        '    do: webhook_post',
        '    with:',
        '      title: "prefix-{{task.title}}-suffix"',
        '',
      ].join('\n'),
      'utf8',
    );
    if (process.getuid !== undefined) {
      await chmod(path, 0o600);
    }
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join('\n');
      expect(joined).toContain('rules[0].with.title');
      expect(joined).toContain('templating');
    }
  });

  it('returns ok=false for an empty YAML file', async () => {
    const path = join(tmpRoot, 'empty.yaml');
    await writeFile(path, '', 'utf8');
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false with a clear error for a missing file', async () => {
    const path = join(tmpRoot, 'does-not-exist.yaml');
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('cannot read');
    }
  });

  it('returns ok=false for malformed YAML', async () => {
    const path = join(tmpRoot, 'malformed.yaml');
    await writeFile(path, 'version: 1\nrules:\n  - name: r\n  bad-indent\n', 'utf8');
    if (process.getuid !== undefined) {
      await chmod(path, 0o600);
    }
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
  });
});

describe('loadAndValidateTriggers — file-permission trust gate (§triggers.yaml trust posture)', () => {
  let tmpRoot: string;

  // The mode/owner gate is POSIX-only (process.getuid undefined on Windows);
  // skip the whole suite on a non-POSIX runner so it stays green everywhere.
  const posix = typeof process.getuid === 'function';

  const VALID_YAML = [
    'version: 1',
    'rules:',
    '  - name: secure-rule',
    '    on: task.created',
    '    where:',
    '      project: demo-project',
    '    do: webhook_post',
    '    with:',
    '      url: "https://example.invalid/hook"',
    '',
  ].join('\n');

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'wft-router-triggers-perm-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it.runIf(posix)('accepts a 0600 file owned by the process uid', async () => {
    const path = join(tmpRoot, 'secure.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    await chmod(path, 0o600);
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(true);
  });

  it.runIf(posix)('rejects a group-writable (0660) file', async () => {
    const path = join(tmpRoot, 'group-writable.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    await chmod(path, 0o660);
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('mode 0600');
      expect(result.errors[0]).toContain('group or other');
    }
  });

  it.runIf(posix)('rejects a world-writable (0666) file', async () => {
    const path = join(tmpRoot, 'world-writable.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    await chmod(path, 0o666);
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('mode 0600');
    }
  });

  it.runIf(posix)('rejects a world-readable (0644) file per 0600 strictness', async () => {
    const path = join(tmpRoot, 'world-readable.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    await chmod(path, 0o644);
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('mode 0600');
    }
  });

  it.runIf(posix)('accepts a symlink whose real target is a 0600 owned file', async () => {
    const realPath = join(tmpRoot, 'real-secure.yaml');
    const linkPath = join(tmpRoot, 'link-secure.yaml');
    await writeFile(realPath, VALID_YAML, 'utf8');
    await chmod(realPath, 0o600);
    await symlink(realPath, linkPath);
    const result = await loadAndValidateTriggers(linkPath);
    expect(result.ok).toBe(true);
  });

  it.runIf(posix)('rejects a symlink whose real target is too-permissive (0666)', async () => {
    const realPath = join(tmpRoot, 'real-open.yaml');
    const linkPath = join(tmpRoot, 'link-open.yaml');
    await writeFile(realPath, VALID_YAML, 'utf8');
    // The link itself is 0600 (lchmod is a no-op for the target), but the
    // realpath-resolved target is world-writable — must be rejected.
    await chmod(realPath, 0o666);
    await symlink(realPath, linkPath);
    const result = await loadAndValidateTriggers(linkPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('mode 0600');
    }
  });

  it.runIf(posix)('emits a clear error message naming the file and the requirement', async () => {
    const path = join(tmpRoot, 'noisy.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    await chmod(path, 0o640);
    const result = await loadAndValidateTriggers(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(path);
      expect(result.errors[0]).toContain('insecure permissions');
      expect(result.errors[0]).toContain('mode 0600');
      expect(result.errors[0].startsWith('  - ')).toBe(true);
    }
  });
});
