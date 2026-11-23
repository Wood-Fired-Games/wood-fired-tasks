import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { ProjectCharterHistoryRepository } from '../../repositories/project-charter-history.repository.js';
import { ProjectService } from '../project.service.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import type { TaskStatus } from '../../types/task.js';
import type { ValueCharter } from '../../types/task.js';
import { ValidationError, BusinessError, NotFoundError } from '../errors.js';
import { eventBus } from '../../events/event-bus.js';
import type Database from '../../db/driver.js';

describe('ProjectService', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let projectService: ProjectService;

  beforeEach(async () => {
    // Create in-memory database for each test
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    projectService = new ProjectService(projectRepo);
  });

  describe('createProject', () => {
    it('creates project with valid input', () => {
      const input = {
        name: 'Test Project',
        description: 'A test project',
      };

      const project = projectService.createProject(input);

      expect(project).toBeDefined();
      expect(project.name).toBe('Test Project');
      expect(project.description).toBe('A test project');
      expect(project.id).toBeGreaterThan(0);
      expect(project.created_at).toBeDefined();
    });

    it('throws ValidationError when name is empty', () => {
      const input = {
        name: '',
        description: 'Test',
      };

      expect(() => projectService.createProject(input)).toThrow(ValidationError);

      try {
        projectService.createProject(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.fieldErrors.name).toBeDefined();
        expect(validationError.fieldErrors.name).toContain('Name is required');
      }
    });

    it('throws BusinessError when project name already exists', () => {
      const input = {
        name: 'Duplicate Project',
        description: 'First one',
      };

      projectService.createProject(input);

      expect(() => projectService.createProject(input)).toThrow(BusinessError);

      try {
        projectService.createProject(input);
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toBe('Project with this name already exists');
      }
    });
  });

  describe('getProject', () => {
    it('returns project by ID', () => {
      const created = projectService.createProject({
        name: 'Test Project',
        description: 'Test',
      });

      const project = projectService.getProject(created.id);

      expect(project).toBeDefined();
      expect(project.id).toBe(created.id);
      expect(project.name).toBe('Test Project');
    });

    it('throws NotFoundError when project does not exist', () => {
      expect(() => projectService.getProject(999)).toThrow(NotFoundError);

      try {
        projectService.getProject(999);
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        const notFoundError = error as NotFoundError;
        expect(notFoundError.entity).toBe('Project');
        expect(notFoundError.id).toBe(999);
        expect(notFoundError.message).toBe('Project with id 999 not found');
      }
    });
  });

  describe('listProjects', () => {
    it('returns all projects', () => {
      projectService.createProject({ name: 'Project A' });
      projectService.createProject({ name: 'Project B' });
      projectService.createProject({ name: 'Project C' });

      const projects = projectService.listProjects();

      expect(projects).toHaveLength(3);
      expect(projects.map((p) => p.name).sort()).toEqual(['Project A', 'Project B', 'Project C']);
    });
  });

  describe('updateProject', () => {
    it('updates project fields', () => {
      const created = projectService.createProject({
        name: 'Original Name',
        description: 'Original description',
      });

      const updated = projectService.updateProject(created.id, {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.description).toBe('Updated description');
    });

    it('throws NotFoundError when project does not exist', () => {
      expect(() => projectService.updateProject(999, { name: 'New Name' })).toThrow(NotFoundError);
    });

    it('throws BusinessError when updating to duplicate name', () => {
      projectService.createProject({ name: 'Existing Project' });
      const created = projectService.createProject({ name: 'Another Project' });

      expect(() => projectService.updateProject(created.id, { name: 'Existing Project' })).toThrow(
        BusinessError,
      );
    });
  });

  describe('charter-history snapshot on re-interview (WSJF 4.2)', () => {
    let charterHistory: ProjectCharterHistoryRepository;
    let svc: ProjectService;

    const charter = (version: number, mission: string): ValueCharter => ({
      mission,
      value_themes: [
        { name: 'Reliability', weight: 13, description: 'do not break prod' },
        { name: 'Speed', weight: 5, description: 'ship fast' },
      ],
      time_context: 'no hard deadline',
      risk_posture: 'must not break production data',
      out_of_scope: [],
      interview_version: version,
      updated_at: '2026-06-01T12:00:00Z',
    });

    beforeEach(() => {
      charterHistory = new ProjectCharterHistoryRepository(db);
      svc = new ProjectService(projectRepo, { charterHistory, db });
    });

    it('appends prior charter to history with bumped version on overwrite', () => {
      const created = svc.createProject({ name: 'Charter Project' });

      // First charter write: no prior charter → no snapshot.
      svc.updateProject(created.id, { value_charter: charter(1, 'v1 mission') });
      expect(charterHistory.countByProjectId(created.id)).toBe(0);

      // Re-interview: overwrite v1 with a bumped v2 charter → snapshot the prior.
      svc.updateProject(created.id, { value_charter: charter(2, 'v2 mission') });

      const history = charterHistory.findByProjectId(created.id);
      expect(history).toHaveLength(1);
      // The snapshot holds the PRIOR (v1) charter content...
      expect(history[0].charter?.mission).toBe('v1 mission');
      expect(history[0].charter?.interview_version).toBe(1);
      // ...tagged with the NEW (bumped) interview_version it was replaced at.
      expect(history[0].interview_version).toBe(2);
      expect(history[0].change_kind).toBe('overwrite');

      // The live project now carries the v2 charter.
      const reloaded = svc.getProject(created.id);
      expect(reloaded.value_charter?.mission).toBe('v2 mission');
      expect(reloaded.value_charter?.interview_version).toBe(2);
    });

    it('records actor attribution on the snapshot', () => {
      const created = svc.createProject({ name: 'Attributed Project' });
      svc.updateProject(created.id, { value_charter: charter(1, 'v1') });

      svc.updateProject(
        created.id,
        { value_charter: charter(2, 'v2') },
        { actorType: 'human', actorId: 'stuart@woodfiredgames.com' },
      );

      const history = charterHistory.findByProjectId(created.id);
      expect(history).toHaveLength(1);
      expect(history[0].actor_type).toBe('human');
      expect(history[0].actor_id).toBe('stuart@woodfiredgames.com');
    });

    it('does NOT snapshot when setting a charter on a project that had none', () => {
      const created = svc.createProject({ name: 'First Charter' });
      svc.updateProject(created.id, { value_charter: charter(1, 'fresh') });
      expect(charterHistory.countByProjectId(created.id)).toBe(0);
    });

    it('does NOT snapshot when clearing an existing charter', () => {
      const created = svc.createProject({ name: 'Cleared Charter' });
      svc.updateProject(created.id, { value_charter: charter(1, 'v1') });
      svc.updateProject(created.id, { value_charter: null });
      expect(charterHistory.countByProjectId(created.id)).toBe(0);
    });

    it('does NOT snapshot when no charter-history writer is injected', () => {
      const plain = new ProjectService(projectRepo);
      const created = plain.createProject({ name: 'No Writer' });
      plain.updateProject(created.id, { value_charter: charter(1, 'v1') });
      // Overwrite still works, just no snapshot is taken.
      const updated = plain.updateProject(created.id, {
        value_charter: charter(2, 'v2'),
      });
      expect(updated.value_charter?.interview_version).toBe(2);
      // The table is empty because nothing wrote to it.
      const hist = new ProjectCharterHistoryRepository(db);
      expect(hist.countByProjectId(created.id)).toBe(0);
    });
  });

  describe('deleteProject', () => {
    it('deletes project', () => {
      const created = projectService.createProject({ name: 'To Delete' });

      projectService.deleteProject(created.id);

      expect(() => projectService.getProject(created.id)).toThrow(NotFoundError);
    });

    it('throws NotFoundError when project does not exist', () => {
      expect(() => projectService.deleteProject(999)).toThrow(NotFoundError);
    });
  });

  describe('event emissions', () => {
    it('createProject emits project.created event after successful operation', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      const project = projectService.createProject({
        name: 'Test Project',
        description: 'Test description',
      });

      expect(emitSpy).toHaveBeenCalledWith('project.created', {
        eventType: 'project.created',
        timestamp: expect.any(String),
        data: project,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });

    it('createProject does NOT emit event when validation fails', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.createProject({
          name: '', // empty name fails validation
        }),
      ).toThrow(ValidationError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('createProject does NOT emit event when duplicate name exists', () => {
      projectService.createProject({ name: 'Duplicate' });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => projectService.createProject({ name: 'Duplicate' })).toThrow(BusinessError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('updateProject emits project.updated event after successful operation', () => {
      const project = projectService.createProject({
        name: 'Original',
        description: 'Original description',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      const updated = projectService.updateProject(project.id, {
        name: 'Updated',
      });

      expect(emitSpy).toHaveBeenCalledWith('project.updated', {
        eventType: 'project.updated',
        timestamp: expect.any(String),
        data: updated,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });

    it('updateProject does NOT emit event when project not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => projectService.updateProject(999, { name: 'Updated' })).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('updateProject does NOT emit event when updating to duplicate name', () => {
      projectService.createProject({ name: 'Existing' });
      const project = projectService.createProject({ name: 'Another' });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => projectService.updateProject(project.id, { name: 'Existing' })).toThrow(
        BusinessError,
      );

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('deleteProject emits project.deleted event BEFORE deletion', () => {
      const project = projectService.createProject({
        name: 'To Delete',
        description: 'Will be deleted',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      projectService.deleteProject(project.id);

      expect(emitSpy).toHaveBeenCalledWith('project.deleted', {
        eventType: 'project.deleted',
        timestamp: expect.any(String),
        data: project,
        metadata: { source: 'user' },
      });

      // Verify project is actually deleted
      expect(() => projectService.getProject(project.id)).toThrow(NotFoundError);

      emitSpy.mockRestore();
    });

    it('deleteProject does NOT emit event when project not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => projectService.deleteProject(999)).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });
  });

  // --- Archived project state (docs/design/project-archived-state.md §2.2-2.4, §2.7) ---

  describe('archived state', () => {
    let taskRepo: TaskRepository;
    let service: ProjectService;
    let projectId: number;
    let emitSpy: ReturnType<typeof vi.spyOn>;

    const addTask = (status: TaskStatus, project = projectId) =>
      taskRepo.create({
        title: `${status} task`,
        status,
        priority: 'medium',
        project_id: project,
        created_by: 'tester',
      });

    const archiveEvents = () =>
      emitSpy.mock.calls.filter(([type]: [string]) => String(type).startsWith('project.'));

    beforeEach(() => {
      taskRepo = new TaskRepository(db);
      service = new ProjectService(projectRepo, { taskRepo });
      projectId = service.createProject({ name: 'Archivable' }).id;
      emitSpy = vi.spyOn(eventBus, 'emit');
    });

    afterEach(() => {
      emitSpy.mockRestore();
    });

    describe('archiveProject', () => {
      it('archives a project with no tasks and returns it', () => {
        const project = service.archiveProject(projectId, {}, 'alice');

        expect(project).toMatchObject({
          id: projectId,
          archived: true,
          archived_at: expect.any(String),
          archived_by: 'alice',
          archive_reason: null,
        });
        expect(service.getProject(projectId).archived).toBe(true);
      });

      it('archives a project whose tasks are all done or closed', () => {
        addTask('done');
        addTask('closed');

        expect(service.archiveProject(projectId, { reason: 'shipped' }, 'alice')).toMatchObject({
          archived: true,
          archive_reason: 'shipped',
        });
      });

      it('accepts an absent body', () => {
        expect(service.archiveProject(projectId, undefined, 'alice').archived).toBe(true);
      });

      it.each(['open', 'in_progress', 'blocked', 'backlogged'] as const)(
        'refuses to archive while a task is %s, with the count per status',
        (status) => {
          addTask(status);
          addTask(status);
          addTask('done');

          let thrown: unknown;
          try {
            service.archiveProject(projectId, { reason: 'tidy up' }, 'alice');
          } catch (err) {
            thrown = err;
          }

          expect(thrown).toBeInstanceOf(BusinessError);
          const message = (thrown as BusinessError).message;
          expect(message).toMatch(/^project_has_unfinished_tasks/);
          for (const s of ['open', 'in_progress', 'blocked', 'backlogged']) {
            expect(message).toContain(`${s}: ${s === status ? 2 : 0}`);
          }
          expect(service.getProject(projectId).archived).toBe(false);
          expect(archiveEvents()).toEqual([]);
        },
      );

      it('refuses with force: false as well', () => {
        addTask('open');

        expect(() =>
          service.archiveProject(projectId, { force: false, reason: 'r' }, 'alice'),
        ).toThrow(/^project_has_unfinished_tasks/);
      });

      it('force with a reason archives despite unfinished tasks and leaves task statuses alone', () => {
        const open = addTask('open');
        const inProgress = addTask('in_progress');
        const blocked = addTask('blocked');
        const backlogged = addTask('backlogged');

        const project = service.archiveProject(
          projectId,
          { force: true, reason: 'abandoned' },
          'alice',
        );

        expect(project).toMatchObject({ archived: true, archive_reason: 'abandoned' });
        expect(taskRepo.findById(open.id)?.status).toBe('open');
        expect(taskRepo.findById(inProgress.id)?.status).toBe('in_progress');
        expect(taskRepo.findById(blocked.id)?.status).toBe('blocked');
        expect(taskRepo.findById(backlogged.id)?.status).toBe('backlogged');
      });

      it('rejects force without reason as a ValidationError and does not archive', () => {
        addTask('open');

        let thrown: unknown;
        try {
          service.archiveProject(projectId, { force: true }, 'alice');
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(ValidationError);
        expect((thrown as ValidationError).fieldErrors.reason).toBeDefined();
        expect(service.getProject(projectId).archived).toBe(false);
        expect(archiveEvents()).toEqual([]);
      });

      it('rejects a whitespace-only reason and a reason over 500 characters', () => {
        expect(() => service.archiveProject(projectId, { reason: '   ' }, 'alice')).toThrow(
          ValidationError,
        );
        expect(() =>
          service.archiveProject(projectId, { reason: 'x'.repeat(501) }, 'alice'),
        ).toThrow(ValidationError);
      });

      it('stores the trimmed reason', () => {
        expect(
          service.archiveProject(projectId, { reason: '  shipped  ' }, 'alice').archive_reason,
        ).toBe('shipped');
      });

      it('takes archived_by from the actor, never from input', () => {
        const project = service.archiveProject(
          projectId,
          { reason: 'shipped', archived_by: 'mallory', archived_at: '1999-01-01T00:00:00.000Z' },
          'alice',
        );

        expect(project.archived_by).toBe('alice');
        expect(project.archived_at).not.toBe('1999-01-01T00:00:00.000Z');
      });

      it('throws NotFoundError for a project that does not exist', () => {
        expect(() => service.archiveProject(999, {}, 'alice')).toThrow(NotFoundError);
        expect(archiveEvents()).toEqual([]);
      });

      it('idempotent archive: an already archived project is returned unchanged and emits no event', () => {
        const first = service.archiveProject(projectId, { reason: 'first' }, 'alice');
        emitSpy.mockClear();

        const second = service.archiveProject(projectId, { reason: 'second' }, 'bob');

        expect(second).toEqual(first);
        expect(emitSpy).not.toHaveBeenCalled();
      });

      it('idempotent archive does not re-check tasks (a force-archived project stays a no-op)', () => {
        addTask('open');
        const first = service.archiveProject(projectId, { force: true, reason: 'r' }, 'alice');
        emitSpy.mockClear();

        expect(service.archiveProject(projectId, {}, 'bob')).toEqual(first);
        expect(emitSpy).not.toHaveBeenCalled();
      });

      it('fails closed when no task repository is wired and force is not set', () => {
        const bare = new ProjectService(projectRepo);

        expect(() => bare.archiveProject(projectId, {}, 'alice')).toThrow(/task repository/);
        expect(service.getProject(projectId).archived).toBe(false);
      });
    });

    describe('unarchiveProject', () => {
      it('clears the archive columns and returns the project', () => {
        service.archiveProject(projectId, { reason: 'shipped' }, 'alice');

        expect(service.unarchiveProject(projectId, 'bob')).toMatchObject({
          id: projectId,
          archived: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
        });
      });

      it('is a no-op that emits no event on a project that is not archived', () => {
        const before = service.getProject(projectId);
        emitSpy.mockClear();

        expect(service.unarchiveProject(projectId, 'bob')).toEqual(before);
        expect(emitSpy).not.toHaveBeenCalled();
      });

      it('throws NotFoundError for a project that does not exist', () => {
        expect(() => service.unarchiveProject(999, 'bob')).toThrow(NotFoundError);
      });
    });

    describe('events', () => {
      it('exactly one event per transition: project.archived then project.unarchived, never project.updated', () => {
        emitSpy.mockClear();

        const archived = service.archiveProject(projectId, { reason: 'shipped' }, 'alice');
        service.archiveProject(projectId, { reason: 'again' }, 'alice');
        const restored = service.unarchiveProject(projectId, 'bob');
        service.unarchiveProject(projectId, 'bob');

        expect(emitSpy.mock.calls).toEqual([
          [
            'project.archived',
            {
              eventType: 'project.archived',
              timestamp: expect.any(String),
              data: archived,
              metadata: { source: 'user', actor: 'alice' },
            },
          ],
          [
            'project.unarchived',
            {
              eventType: 'project.unarchived',
              timestamp: expect.any(String),
              data: restored,
              metadata: { source: 'user', actor: 'bob' },
            },
          ],
        ]);
      });

      it('a second archive after an unarchive is a new transition with its own event', () => {
        service.archiveProject(projectId, {}, 'alice');
        service.unarchiveProject(projectId, 'alice');
        emitSpy.mockClear();

        service.archiveProject(projectId, {}, 'carol');

        expect(emitSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy.mock.calls[0]?.[0]).toBe('project.archived');
      });

      it('a refused archive emits nothing', () => {
        addTask('blocked');
        emitSpy.mockClear();

        expect(() => service.archiveProject(projectId, {}, 'alice')).toThrow(BusinessError);
        expect(emitSpy).not.toHaveBeenCalled();
      });
    });

    describe('while archived', () => {
      beforeEach(() => {
        service.archiveProject(projectId, { reason: 'shipped' }, 'alice');
        emitSpy.mockClear();
      });

      it.each([
        ['name', { name: 'Renamed' }],
        ['description', { description: 'changed' }],
        ['value_charter', { value_charter: null }],
        ['model_policy', { model_policy: null }],
        ['scm', { scm: null }],
      ])('update rejected while archived (%s) with a project_archived message', (_field, patch) => {
        let thrown: unknown;
        try {
          service.updateProject(projectId, patch);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(BusinessError);
        expect((thrown as BusinessError).message).toMatch(/^project_archived/);
        expect(service.getProject(projectId).name).toBe('Archivable');
        expect(emitSpy).not.toHaveBeenCalled();
      });

      it('update works again after unarchive', () => {
        service.unarchiveProject(projectId, 'bob');

        expect(service.updateProject(projectId, { name: 'Renamed' }).name).toBe('Renamed');
      });

      it('an invalid update is still a ValidationError, and a missing project a NotFoundError', () => {
        expect(() => service.updateProject(projectId, { name: '' })).toThrow(ValidationError);
        expect(() => service.updateProject(999, { name: 'x' })).toThrow(NotFoundError);
      });

      it('delete allowed while archived', () => {
        service.deleteProject(projectId);

        expect(() => service.getProject(projectId)).toThrow(NotFoundError);
        expect(emitSpy.mock.calls.map(([type]: [string]) => type)).toEqual(['project.deleted']);
      });

      it('getProject still returns the archived project', () => {
        expect(service.getProject(projectId)).toMatchObject({ archived: true });
      });

      it('the archived name stays taken', () => {
        expect(() => service.createProject({ name: 'Archivable' })).toThrow(BusinessError);
      });
    });

    describe('list filter', () => {
      let activeId: number;

      beforeEach(() => {
        activeId = service.createProject({ name: 'Active' }).id;
        service.archiveProject(projectId, {}, 'alice');
      });

      it('listProjects omits archived projects by default', () => {
        expect(service.listProjects().map((p) => p.id)).toEqual([activeId]);
        expect(service.listProjects({ limit: 10, offset: 0 }).map((p) => p.id)).toEqual([activeId]);
      });

      it('listProjects passes archived=include and archived=only through', () => {
        expect(service.listProjects({ archived: 'include' }).map((p) => p.id)).toEqual([
          activeId,
          projectId,
        ]);
        expect(service.listProjects({ archived: 'only' }).map((p) => p.id)).toEqual([projectId]);
        expect(service.listProjects({ archived: 'exclude' }).map((p) => p.id)).toEqual([activeId]);
      });

      it('listProjectsPaginated filters data and total together', () => {
        expect(service.listProjectsPaginated()).toMatchObject({ total: 1, limit: 50, offset: 0 });
        expect(service.listProjectsPaginated().data.map((p) => p.id)).toEqual([activeId]);

        const all = service.listProjectsPaginated({ archived: 'include', limit: 1, offset: 1 });
        expect(all).toMatchObject({ total: 2, limit: 1, offset: 1 });
        expect(all.data.map((p) => p.id)).toEqual([projectId]);

        const only = service.listProjectsPaginated({ archived: 'only' });
        expect(only.total).toBe(1);
        expect(only.data.map((p) => p.id)).toEqual([projectId]);
      });

      it('rejects an unknown archived value', () => {
        expect(() => service.listProjects({ archived: 'all' as never })).toThrow(ValidationError);
        expect(() => service.listProjectsPaginated({ archived: 'all' as never })).toThrow(
          ValidationError,
        );
      });
    });
  });
});
