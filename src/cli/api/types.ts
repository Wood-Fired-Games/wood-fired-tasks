/**
 * CLI-side TypeScript interfaces for REST API request/response shapes.
 * These are decoupled from server types to keep the CLI independent.
 */

export interface TaskResponse {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: number;
  assignee: string | null;
  created_by: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface ProjectResponse {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  title: string;
  project_id: number;
  created_by: string;
  description?: string;
  priority?: string;
  assignee?: string;
  due_date?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assignee?: string | null;
  due_date?: string | null;
  tags?: string[];
}

export interface TaskFilters {
  project_id?: number;
  status?: string;
  assignee?: string;
  search?: string;
  tags?: string;
  due_before?: string;
  due_after?: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
