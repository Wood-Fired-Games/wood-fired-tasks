// Task status and priority enums
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskPriority = typeof TASK_PRIORITIES[number];

// Valid status transitions map
export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],
  closed: ['open'],
};

// Core interfaces
export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  project_id: number;
  assignee: string | null;
  created_by: string;
  due_date: string | null; // ISO8601
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
}

export interface TaskTag {
  id: number;
  task_id: number;
  tag: string;
}

// DTOs for create/update operations
export interface CreateTaskDTO {
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  project_id: number;
  assignee?: string | null;
  created_by: string;
  due_date?: string | null;
}

export interface UpdateTaskDTO {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string | null;
  due_date?: string | null;
  tags?: string[];
}

export interface CreateProjectDTO {
  name: string;
  description?: string | null;
}

// Task filtering interface
export interface TaskFilters {
  project_id?: number;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  due_before?: string; // ISO8601
  due_after?: string; // ISO8601
  search?: string;
}
