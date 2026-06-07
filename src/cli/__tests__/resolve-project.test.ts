/**
 * Unit tests for src/cli/statusline/resolve-project.ts (task #593).
 *
 * Exercises each resolution source — `.planning/config.json`
 * (integrations.bugs_mirror.project_id), the `.wft/project` marker, and the
 * API repo-name fallback — plus the `unlinked` path, all against real fixture
 * tmpdirs. Also verifies precedence (bugs_mirror beats wft_marker) and that
 * malformed inputs never throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectFromCwd, type ProjectResolution } from '../statusline/resolve-project.js';
import type { ProjectResponse } from '../api/types.js';

/** Build a minimal ProjectResponse for the repo-name lister fixture. */
function project(id: number, name: string): ProjectResponse {
  return { id, name } as ProjectResponse;
}

/** A lister that fails — proves the repo_name rung swallows network errors. */
const failingLister = async (): Promise<ProjectResponse[]> => {
  throw new Error('network down');
};

/** A lister that returns nothing — drives the unlinked path. */
const emptyLister = async (): Promise<ProjectResponse[]> => [];

describe('resolveProjectFromCwd', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wft-resolve-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePlanningConfig(dir: string, body: unknown): void {
    const planning = join(dir, '.planning');
    mkdirSync(planning, { recursive: true });
    writeFileSync(join(planning, 'config.json'), JSON.stringify(body), 'utf8');
  }

  function writeWftMarker(dir: string, contents: string): void {
    const wft = join(dir, '.wft');
    mkdirSync(wft, { recursive: true });
    writeFileSync(join(wft, 'project'), contents, 'utf8');
  }

  // ── Source 1: bugs_mirror project_id ─────────────────────────────
  it('prefers .planning/config.json integrations.bugs_mirror.project_id', async () => {
    writePlanningConfig(root, {
      integrations: { bugs_mirror: { enabled: true, project_id: 42 } },
    });

    const res = await resolveProjectFromCwd(root, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'bugs_mirror',
      projectId: 42,
    });
  });

  it('finds .planning/config.json by walking UP from a nested cwd', async () => {
    writePlanningConfig(root, {
      integrations: { bugs_mirror: { project_id: 7 } },
    });
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    const res = await resolveProjectFromCwd(nested);

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'bugs_mirror',
      projectId: 7,
    });
  });

  // ── Source 2: .wft/project marker ────────────────────────────────
  it('falls back to .wft/project marker (numeric id) when no bugs_mirror id', async () => {
    // config.json exists but has no project_id → must fall through to marker.
    writePlanningConfig(root, { integrations: { bugs_mirror: { enabled: false } } });
    writeWftMarker(root, '99\n');

    const res = await resolveProjectFromCwd(root, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'wft_marker',
      projectId: 99,
    });
  });

  it('reads a .wft/project marker that carries a project NAME', async () => {
    writeWftMarker(root, '# linked project\nmy-cool-project\n');

    const res = await resolveProjectFromCwd(root, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'wft_marker',
      repoName: 'my-cool-project',
    });
  });

  it('prefers bugs_mirror over the .wft marker when both are present', async () => {
    writePlanningConfig(root, { integrations: { bugs_mirror: { project_id: 1 } } });
    writeWftMarker(root, '2\n');

    const res = await resolveProjectFromCwd(root);

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'bugs_mirror',
      projectId: 1,
    });
  });

  // ── Source 3: API repo-name fallback ─────────────────────────────
  it('falls back to matching the API repo name (cwd basename)', async () => {
    const repoDir = join(root, 'wood-fired-tasks');
    mkdirSync(repoDir, { recursive: true });
    const lister = async () => [
      project(10, 'something-else'),
      project(11, 'Wood-Fired-Tasks'), // case-insensitive match
    ];

    const res = await resolveProjectFromCwd(repoDir, { listProjects: lister });

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'repo_name',
      projectId: 11,
      repoName: 'wood-fired-tasks',
    });
  });

  // ── Source 4: unlinked ───────────────────────────────────────────
  it('returns unlinked when no markers exist and the API yields nothing', async () => {
    const repoDir = join(root, 'unknown-repo');
    mkdirSync(repoDir, { recursive: true });

    const res = await resolveProjectFromCwd(repoDir, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({ resolved: false });
  });

  it('returns unlinked (never throws) when the API lister fails', async () => {
    const repoDir = join(root, 'offline-repo');
    mkdirSync(repoDir, { recursive: true });

    const res = await resolveProjectFromCwd(repoDir, { listProjects: failingLister });

    expect(res).toEqual<ProjectResolution>({ resolved: false });
  });

  // ── Robustness: malformed inputs degrade, never throw ────────────
  it('ignores a malformed config.json and falls through to the marker', async () => {
    const planning = join(root, '.planning');
    mkdirSync(planning, { recursive: true });
    writeFileSync(join(planning, 'config.json'), '{ this is not json', 'utf8');
    writeWftMarker(root, '55');

    const res = await resolveProjectFromCwd(root, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({
      resolved: true,
      source: 'wft_marker',
      projectId: 55,
    });
  });

  it('ignores a non-positive / non-integer bugs_mirror project_id', async () => {
    writePlanningConfig(root, { integrations: { bugs_mirror: { project_id: 0 } } });

    const res = await resolveProjectFromCwd(root, { listProjects: emptyLister });

    expect(res).toEqual<ProjectResolution>({ resolved: false });
  });
});
