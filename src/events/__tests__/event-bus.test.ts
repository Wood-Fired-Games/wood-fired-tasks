import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../event-bus.js';
import { TaskEvent, ProjectEvent } from '../types.js';
import { Task, Project } from '../../types/task.js';

describe('EventBus', () => {
  let eventBus: EventBus<{
    'task.created': TaskEvent;
    'task.updated': TaskEvent;
    'task.deleted': TaskEvent;
    'task.status_changed': TaskEvent;
    'task.claimed': TaskEvent;
    'project.created': ProjectEvent;
    'project.updated': ProjectEvent;
    'project.deleted': ProjectEvent;
  }>;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('emit and subscribe', () => {
    it('should deliver event to all subscribers', () => {
      const receivedPayloads: TaskEvent[] = [];
      const payload: TaskEvent = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: {
          id: 1,
          title: 'Test Task',
          description: 'Test Description',
          status: 'open',
          priority: 'medium',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: ['test'],
        },
        metadata: {
          source: 'user',
          actor: 'user1',
        },
      };

      eventBus.subscribe('task.created', (p) => receivedPayloads.push(p));

      eventBus.emit('task.created', payload);

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toEqual(payload);
    });

    it('should call handler with correct typed payload', () => {
      let receivedPayload: TaskEvent | undefined;
      const payload: TaskEvent = {
        eventType: 'task.updated',
        timestamp: new Date().toISOString(),
        data: {
          id: 2,
          title: 'Updated Task',
          description: null,
          status: 'in_progress',
          priority: 'high',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: 60,
          assignee: 'user2',
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'user',
        },
      };

      eventBus.subscribe('task.updated', (p) => {
        receivedPayload = p;
      });

      eventBus.emit('task.updated', payload);

      expect(receivedPayload).toBeDefined();
      expect(receivedPayload?.data.status).toBe('in_progress');
      expect(receivedPayload?.data.assignee).toBe('user2');
    });

    it('should support multiple subscribers receiving same event', () => {
      const subscriber1Calls: TaskEvent[] = [];
      const subscriber2Calls: TaskEvent[] = [];
      const subscriber3Calls: TaskEvent[] = [];

      const payload: TaskEvent = {
        eventType: 'task.deleted',
        timestamp: new Date().toISOString(),
        data: {
          id: 3,
          title: 'Deleted Task',
          description: null,
          status: 'closed',
          priority: 'low',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'user',
        },
      };

      eventBus.subscribe('task.deleted', (p) => subscriber1Calls.push(p));
      eventBus.subscribe('task.deleted', (p) => subscriber2Calls.push(p));
      eventBus.subscribe('task.deleted', (p) => subscriber3Calls.push(p));

      eventBus.emit('task.deleted', payload);

      expect(subscriber1Calls).toHaveLength(1);
      expect(subscriber2Calls).toHaveLength(1);
      expect(subscriber3Calls).toHaveLength(1);
      expect(subscriber1Calls[0]).toEqual(payload);
      expect(subscriber2Calls[0]).toEqual(payload);
      expect(subscriber3Calls[0]).toEqual(payload);
    });

    it('should not throw error when emitting with no subscribers', () => {
      const payload: TaskEvent = {
        eventType: 'task.status_changed',
        timestamp: new Date().toISOString(),
        data: {
          id: 4,
          title: 'Task',
          description: null,
          status: 'done',
          priority: 'medium',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'workflow',
        },
      };

      expect(() => {
        eventBus.emit('task.status_changed', payload);
      }).not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      const receivedPayloads: TaskEvent[] = [];
      const payload: TaskEvent = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: {
          id: 5,
          title: 'Task',
          description: null,
          status: 'open',
          priority: 'medium',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'user',
        },
      };

      const unsubscribe = eventBus.subscribe('task.created', (p) => receivedPayloads.push(p));

      eventBus.emit('task.created', payload);
      expect(receivedPayloads).toHaveLength(1);

      unsubscribe();

      eventBus.emit('task.created', payload);
      expect(receivedPayloads).toHaveLength(1); // Should still be 1, not 2
    });

    it('should not affect other subscribers when one unsubscribes', () => {
      const subscriber1Calls: TaskEvent[] = [];
      const subscriber2Calls: TaskEvent[] = [];

      const payload: TaskEvent = {
        eventType: 'task.updated',
        timestamp: new Date().toISOString(),
        data: {
          id: 6,
          title: 'Task',
          description: null,
          status: 'open',
          priority: 'medium',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'user',
        },
      };

      const unsubscribe1 = eventBus.subscribe('task.updated', (p) => subscriber1Calls.push(p));
      eventBus.subscribe('task.updated', (p) => subscriber2Calls.push(p));

      eventBus.emit('task.updated', payload);
      expect(subscriber1Calls).toHaveLength(1);
      expect(subscriber2Calls).toHaveLength(1);

      unsubscribe1();

      eventBus.emit('task.updated', payload);
      expect(subscriber1Calls).toHaveLength(1); // Still 1
      expect(subscriber2Calls).toHaveLength(2); // Increased to 2
    });
  });

  describe('error handling', () => {
    it('should continue executing other subscribers when one throws error', () => {
      const subscriber1Calls: TaskEvent[] = [];
      const subscriber3Calls: TaskEvent[] = [];

      const payload: TaskEvent = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: {
          id: 7,
          title: 'Task',
          description: null,
          status: 'open',
          priority: 'medium',
          project_id: 1,
          parent_task_id: null,
          estimated_minutes: null,
          assignee: null,
          created_by: 'user1',
          due_date: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          claimed_at: null,
          completed_at: null,
          tags: [],
        },
        metadata: {
          source: 'user',
        },
      };

      eventBus.subscribe('task.created', (p) => subscriber1Calls.push(p));
      eventBus.subscribe('task.created', () => {
        throw new Error('Subscriber error');
      });
      eventBus.subscribe('task.created', (p) => subscriber3Calls.push(p));

      expect(() => {
        eventBus.emit('task.created', payload);
      }).not.toThrow();

      expect(subscriber1Calls).toHaveLength(1);
      expect(subscriber3Calls).toHaveLength(1);
    });
  });

  describe('project events', () => {
    it('should handle project events with correct types', () => {
      const receivedPayloads: ProjectEvent[] = [];
      const payload: ProjectEvent = {
        eventType: 'project.created',
        timestamp: new Date().toISOString(),
        data: {
          id: 1,
          name: 'Test Project',
          description: 'Project description',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        metadata: {
          source: 'user',
          actor: 'admin',
        },
      };

      eventBus.subscribe('project.created', (p) => receivedPayloads.push(p));

      eventBus.emit('project.created', payload);

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].data.name).toBe('Test Project');
    });
  });
});
