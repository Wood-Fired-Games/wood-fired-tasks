// Cross-platform artifact smoke. Called by smoke-global on every CI OS leg.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function smokeCodex({ prefixDir, tarball, mkTemp, assert }) {
  const packageRoot = path.join(
    prefixDir,
    ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules/wood-fired-tasks',
  );
  const cli = path.join(packageRoot, 'dist/cli/bin/tasks.js');
  const home = mkTemp('wft codex home with spaces ');
  const cwd = mkTemp('wft codex cwd with spaces ');
  const configHome = path.join(home, 'custom codex home');
  const config = path.join(configHome, 'config.toml');
  fs.mkdirSync(configHome, { recursive: true });
  const original =
    '# existing personal config\nmodel = "personal-model"\n[mcp_servers.other]\ncommand = "personal-command"\n';
  fs.writeFileSync(config, original);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: configHome,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    WFT_CREDENTIALS_PATH: path.join(home, '.config/wood-fired-tasks/credentials'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'),
    DATABASE_PATH: path.join(home, 'local.db'),
    API_BASE_URL: 'http://localhost:3000',
    WFT_API_KEY: '',
    API_KEY: '',
    WFT_API_URL: '',
    WFT_NO_UPDATE_CHECK: '1',
    npm_config_prefix: prefixDir,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  async function run(args, extraEnv = {}, expected = 0) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: { ...env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (bytes) => {
        output += bytes;
      });
      child.stderr.on('data', (bytes) => {
        output += bytes;
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Codex artifact command timed out'));
      }, 180_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (status) => {
        clearTimeout(timeout);
        resolve({ status, output });
      });
    });
    if (result.status !== expected)
      throw new Error(`Artifact ${args[0]} exited ${result.status}: ${result.output}`);
    return result.output;
  }
  const dependency = (name) => pathToFileURL(path.join(packageRoot, 'node_modules', name)).href;
  const { parse: toml } = await import(dependency('smol-toml/dist/index.js'));
  const { Client } = await import(dependency('@modelcontextprotocol/sdk/dist/esm/client/index.js'));
  const { StdioClientTransport } = await import(
    dependency('@modelcontextprotocol/sdk/dist/esm/client/stdio.js')
  );
  async function probeMcp(configFile, serverName, fixtureHome) {
    const entry = toml(fs.readFileSync(configFile, 'utf8')).mcp_servers[serverName];
    const client = new Client({ name: 'codex-artifact-smoke', version: '1' });
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd,
      env: { HOME: fixtureHome, USERPROFILE: fixtureHome, ...entry.env, WFT_NO_UPDATE_CHECK: '1' },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'list_projects', arguments: {} });
      assert(
        !result.isError,
        `${serverName} packaged MCP works with filtered environment and pinned paths`,
      );
    } finally {
      await client.close();
    }
  }
  console.log(
    '-- Codex artifact install / reinstall / self-update (isolated paths with spaces) --',
  );
  await run(['setup', '--target', 'codex', '--skills-only']);
  const skills = path.join(home, '.agents/skills');
  const names = fs.readdirSync(skills).filter((name) => name.startsWith('tasks-'));
  assert(names.length === 17, 'Codex artifact installs 17 invocable workflow directories');
  const { parse: yaml } = await import(
    pathToFileURL(path.join(packageRoot, 'node_modules/yaml/dist/index.js')).href
  );
  for (const name of names) {
    const text = fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    const metadata = yaml(text.split('---')[1]);
    if (metadata.name !== name || typeof metadata.description !== 'string')
      throw new Error(`Invalid skill metadata: ${name}`);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (!fs.existsSync(path.resolve(skills, name, match[1])))
        throw new Error(`Missing reference in ${name}: ${match[1]}`);
    }
  }
  assert(
    !names.some((name) => /loop-shared|wsjf-rubric|enums|verifier|auditor/.test(name)),
    'shared contracts and agent roles are references, not invocable skills',
  );
  const manifestPath = path.join(skills, '.wood-fired-tasks/manifest.json');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  await run(['setup', '--target', 'codex', '--skills-only']);
  assert(
    fs.readFileSync(manifestPath, 'utf8') === manifest,
    'Codex setup re-install is idempotent',
  );
  assert(
    fs.readFileSync(config, 'utf8') === original,
    'skills-only preserves existing Codex MCP/config bytes',
  );
  fs.mkdirSync(path.join(skills, 'personal'));
  fs.writeFileSync(path.join(skills, 'personal/SKILL.md'), 'personal skill');
  const owned = path.join(skills, 'tasks-show-task/SKILL.md');
  const ownedOriginal = fs.readFileSync(owned, 'utf8');
  fs.writeFileSync(owned, 'user custom version');
  await run(['setup', '--target', 'codex', '--skills-only'], {}, 1);
  assert(
    fs.readFileSync(owned, 'utf8') === 'user custom version',
    'Codex setup preserves modified owned skill and reports conflict',
  );
  fs.writeFileSync(owned, ownedOriginal);
  await run(['setup', '--target', 'codex', '--local']);
  const localConfig = fs.readFileSync(config, 'utf8');
  await probeMcp(config, 'wood-fired-tasks', home);
  assert(
    localConfig.startsWith(original) && localConfig.includes('wood-fired-tasks'),
    'local Codex setup adds MCP without overwriting other config',
  );
  await run(['setup', '--target', 'codex', '--local']);
  assert(
    fs.readFileSync(config, 'utf8') === localConfig,
    'local Codex MCP setup re-install is byte-stable',
  );

  const remoteHome = mkTemp('wft codex remote home ');
  const remoteConfigHome = path.join(remoteHome, '.codex');
  fs.mkdirSync(remoteConfigHome);
  fs.writeFileSync(path.join(remoteConfigHome, 'config.toml'), original);
  const token = 'wft_pat_isolated_codex_smoke_token';
  const identity = http.createServer((req, res) => {
    if (req.url === '/api/v1/projects' && req.headers.authorization === `Bearer ${token}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v1/me' && req.headers.authorization === `Bearer ${token}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 4242,
          displayName: 'Codex Smoke',
          email: 'codex@example.invalid',
          isLegacy: false,
          isServiceAccount: false,
        }),
      );
    } else res.writeHead(401).end();
  });
  await new Promise((resolve) => identity.listen(0, '127.0.0.1', resolve));
  try {
    const remoteUrl = `http://127.0.0.1:${identity.address().port}`;
    const remoteEnv = {
      HOME: remoteHome,
      USERPROFILE: remoteHome,
      CODEX_HOME: remoteConfigHome,
      XDG_CONFIG_HOME: path.join(remoteHome, '.config'),
      WFT_CREDENTIALS_PATH: path.join(remoteHome, '.config/wood-fired-tasks/credentials'),
      APPDATA: path.join(remoteHome, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(remoteHome, 'AppData/Local'),
    };
    await run(['setup', '--target', 'codex', '--remote', remoteUrl, '--token', token], remoteEnv);
    const body = fs.readFileSync(path.join(remoteConfigHome, 'config.toml'), 'utf8');
    await probeMcp(
      path.join(remoteConfigHome, 'config.toml'),
      'wood-fired-tasks-remote',
      remoteHome,
    );
    assert(
      body.startsWith(original) && body.includes(remoteUrl) && !body.includes(token),
      'remote Codex setup preserves config and stores URL without PAT',
    );
    assert(
      fs
        .readFileSync(path.join(remoteHome, '.config/wood-fired-tasks/credentials'), 'utf8')
        .includes(token),
      'remote Codex setup validates and persists the credential separately',
    );
    await run(['setup', '--target', 'codex', '--remote', remoteUrl, '--token', token], remoteEnv);
    assert(
      fs.readFileSync(path.join(remoteConfigHome, 'config.toml'), 'utf8') === body,
      'remote Codex setup re-install is idempotent',
    );
    assert(
      !fs.existsSync(path.join(remoteHome, '.claude.json')),
      'remote Codex setup leaves Claude config absent',
    );
  } finally {
    identity.closeAllConnections();
    await new Promise((resolve) => identity.close(resolve));
  }

  // Serve the just-packed version as npm's latest. This exercises real npm
  // and the shipped updater even when the installed version is already latest.
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const artifact = fs.readFileSync(tarball);
  const registry = http.createServer(async (req, res) => {
    try {
      if (req.url === '/artifact.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(artifact);
        return;
      }
      if (req.url?.split('?')[0] === '/wood-fired-tasks') {
        const address = registry.address();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: pkg.name,
            'dist-tags': { latest: pkg.version },
            versions: {
              [pkg.version]: {
                ...pkg,
                dist: { tarball: `http://127.0.0.1:${address.port}/artifact.tgz` },
              },
            },
          }),
        );
        return;
      }
      const upstream = await fetch(`https://registry.npmjs.org${req.url}`, {
        signal: AbortSignal.timeout(30_000),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  try {
    const missing = path.join(skills, '.wood-fired-tasks/references/skills/tasks/loop-shared.md');
    fs.unlinkSync(missing);
    const updateEnv = { npm_config_registry: `http://127.0.0.1:${registry.address().port}` };
    await run(['self-update', '--target', 'codex'], updateEnv);
    assert(
      fs.existsSync(missing),
      'real shipped self-update restores Codex references even at current version',
    );
    await run(['self-update'], updateEnv);
    assert(
      fs.readFileSync(config, 'utf8') === localConfig,
      'self-update preserves existing Codex MCP config',
    );
    assert(
      fs.readFileSync(path.join(skills, 'personal/SKILL.md'), 'utf8') === 'personal skill',
      'self-update preserves unrelated user-authored skills',
    );
    assert(
      !fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.claude.json')),
      'Codex-only setup/update creates no Claude configuration',
    );
  } finally {
    registry.closeAllConnections();
    await new Promise((resolve) => registry.close(resolve));
  }
}
