import { env } from '../config/env.js';
import type {
  TaskResponse,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilters,
  ApiErrorResponse,
} from './types.js';

/**
 * Custom error class for API client errors.
 * Includes HTTP status code and parsed API error response.
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public apiError: ApiErrorResponse
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Internal API request helper with authentication, timeout, and error handling.
 */
async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${env.API_BASE_URL}${endpoint}`;

  // Create abort controller for 10-second timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.API_KEY,
        ...options?.headers,
      },
    });

    // Handle non-OK responses
    if (!response.ok) {
      let errorBody: ApiErrorResponse;
      try {
        errorBody = await response.json();
      } catch {
        // If response body is not JSON, create a generic error
        errorBody = {
          error: 'HTTP_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      throw new ApiClientError(
        errorBody.message || `Request failed with status ${response.status}`,
        response.status,
        errorBody
      );
    }

    return await response.json();
  } catch (error) {
    // Network errors (fetch throws before response)
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error(`Cannot reach API server at ${url}. Is it running?`);
    }
    // Re-throw ApiClientError and AbortError as-is
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create a new task.
 */
export async function createTask(data: CreateTaskInput): Promise<TaskResponse> {
  return apiRequest<TaskResponse>('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * List tasks with optional filters.
 */
export async function listTasks(filters?: TaskFilters): Promise<TaskResponse[]> {
  let endpoint = '/api/v1/tasks';

  if (filters) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) {
        params.append(key, String(value));
      }
    });
    const queryString = params.toString();
    if (queryString) {
      endpoint += `?${queryString}`;
    }
  }

  return apiRequest<TaskResponse[]>(endpoint);
}

/**
 * Get a single task by ID.
 */
export async function getTask(id: number): Promise<TaskResponse> {
  return apiRequest<TaskResponse>(`/api/v1/tasks/${id}`);
}

/**
 * Update a task by ID.
 */
export async function updateTask(id: number, data: UpdateTaskInput): Promise<TaskResponse> {
  return apiRequest<TaskResponse>(`/api/v1/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
