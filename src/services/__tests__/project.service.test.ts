import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { ProjectService } from '../project.service.js';
import { ValidationError, BusinessError, NotFoundError } from '../errors.js';
import { eventBus } from '../../events/event-bus.js';
import type Database from 'better-sqlite3';

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
      expect(projects.map(p => p.name).sort()).toEqual(['Project A', 'Project B', 'Project C']);
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

      expect(() =>
        projectService.updateProject(created.id, { name: 'Existing Project' })
      ).toThrow(BusinessError);
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
        metadata: { source: 'user' }
      });

      emitSpy.mockRestore();
    });

    it('createProject does NOT emit event when validation fails', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.createProject({
          name: '', // empty name fails validation
        })
      ).toThrow(ValidationError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('createProject does NOT emit event when duplicate name exists', () => {
      projectService.createProject({ name: 'Duplicate' });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.createProject({ name: 'Duplicate' })
      ).toThrow(BusinessError);

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
        metadata: { source: 'user' }
      });

      emitSpy.mockRestore();
    });

    it('updateProject does NOT emit event when project not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.updateProject(999, { name: 'Updated' })
      ).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('updateProject does NOT emit event when updating to duplicate name', () => {
      projectService.createProject({ name: 'Existing' });
      const project = projectService.createProject({ name: 'Another' });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.updateProject(project.id, { name: 'Existing' })
      ).toThrow(BusinessError);

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
        metadata: { source: 'user' }
      });

      // Verify project is actually deleted
      expect(() => projectService.getProject(project.id)).toThrow(NotFoundError);

      emitSpy.mockRestore();
    });

    it('deleteProject does NOT emit event when project not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        projectService.deleteProject(999)
      ).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });
  });
});
