import { IProjectRepository } from '../repositories/interfaces.js';
import { Project } from '../types/task.js';
import { CreateProjectSchema } from '../schemas/task.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
import { eventBus } from '../events/event-bus.js';

/**
 * ProjectService - handles project business logic and validation
 */
export class ProjectService {
  constructor(private readonly projectRepo: IProjectRepository) {}

  /**
   * Create a new project with validation
   */
  createProject(input: unknown): Project {
    // Validate input
    const result = CreateProjectSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Check for duplicate name
    const existing = this.projectRepo.findByName(result.data.name);
    if (existing) {
      throw new BusinessError('Project with this name already exists');
    }

    // Create project
    const project = this.projectRepo.create(result.data);

    // Emit project.created event after successful database operation
    eventBus.emit('project.created', {
      eventType: 'project.created',
      timestamp: new Date().toISOString(),
      data: project,
      metadata: { source: 'user' }
    });

    return project;
  }

  /**
   * Get project by ID
   */
  getProject(id: number): Project {
    const project = this.projectRepo.findById(id);
    if (!project) {
      throw new NotFoundError('Project', id);
    }
    return project;
  }

  /**
   * List all projects
   */
  listProjects(): Project[] {
    return this.projectRepo.findAll();
  }

  /**
   * Update a project
   */
  updateProject(id: number, input: unknown): Project {
    // Validate input with partial schema
    const result = CreateProjectSchema.partial().safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Verify project exists
    const existing = this.projectRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Project', id);
    }

    // If name is being changed, check uniqueness
    if (result.data.name && result.data.name !== existing.name) {
      const duplicate = this.projectRepo.findByName(result.data.name);
      if (duplicate) {
        throw new BusinessError('Project with this name already exists');
      }
    }

    // Update project
    const updatedProject = this.projectRepo.update(id, result.data);

    // Emit project.updated event after successful database operation
    eventBus.emit('project.updated', {
      eventType: 'project.updated',
      timestamp: new Date().toISOString(),
      data: updatedProject,
      metadata: { source: 'user' }
    });

    return updatedProject;
  }

  /**
   * Delete a project
   */
  deleteProject(id: number): void {
    // Verify project exists
    const existing = this.projectRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Project', id);
    }

    // Emit project.deleted event BEFORE deletion so consumers can still query related entities
    eventBus.emit('project.deleted', {
      eventType: 'project.deleted',
      timestamp: new Date().toISOString(),
      data: existing,
      metadata: { source: 'user' }
    });

    this.projectRepo.delete(id);
  }
}
