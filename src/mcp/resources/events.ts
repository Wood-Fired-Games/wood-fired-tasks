import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP resource for event stream discovery
 *
 * Provides documentation about the SSE event stream endpoint,
 * including authentication, filtering, event types, and reconnection.
 *
 * Design choice: Resource (not tool) because SSE streams are long-lived
 * connections best accessed via external tools (curl, EventSource API).
 * MCP resource provides discovery and documentation, not streaming.
 *
 * Addresses EVT-07: MCP resource access to event stream.
 */

export const EVENTS_RESOURCE_URI = 'events://stream';

export const EVENTS_RESOURCE_NAME = 'Event Stream';

export const EVENTS_RESOURCE_DESCRIPTION =
  'Real-time task and project event stream via Server-Sent Events';

/**
 * Generate the event stream resource content with the configured API URL.
 *
 * Note: The API key is intentionally NOT embedded in the resource output.
 * MCP resources surface to the LLM as context and end up in conversation
 * history, prompt caches, and client-persisted transcripts. The markdown
 * uses a `<your-api-key>` placeholder instead.
 *
 * @param apiUrl - Base URL for the API (e.g., http://localhost:3000/api/v1)
 * @returns ReadResourceResult with markdown documentation
 */
export function getEventsResourceContent(apiUrl: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: EVENTS_RESOURCE_URI,
        mimeType: 'text/markdown',
        text: `# Event Stream

Subscribe to real-time task and project events via Server-Sent Events (SSE).

## Endpoint

\`\`\`
GET ${apiUrl}/events
\`\`\`

## Authentication

Include API key in header. Replace \`<your-api-key>\` with the value you configured in \`WFB_API_KEY\` (or \`API_KEYS\` for local stdio).
\`\`\`
X-API-Key: <your-api-key>
\`\`\`

## Query Parameters

- \`project_id\` (optional): Filter events to specific project
- \`event_types\` (optional): Comma-separated list of event types (e.g., "task.created,task.updated")

## Event Types

- \`task.created\` - New task created
- \`task.updated\` - Task updated
- \`task.deleted\` - Task deleted
- \`task.claimed\` - Task claimed by agent (Phase 15)
- \`task.status_changed\` - Task status transition
- \`project.created\` - New project created
- \`project.updated\` - Project updated
- \`project.deleted\` - Project deleted
- \`ping\` - Heartbeat (every 30 seconds)

## Reconnection

Include \`Last-Event-ID\` header to resume stream from specific event:
\`\`\`
Last-Event-ID: 42
\`\`\`

Server replays missed events from buffer (up to 1000 events or 5-minute window).

## Example with curl

Replace \`<your-api-key>\` with the value you configured in \`WFB_API_KEY\` (or \`API_KEYS\` for local stdio).

\`\`\`bash
curl -N -H "X-API-Key: <your-api-key>" "${apiUrl}/events?project_id=1&event_types=task.created,task.updated"
\`\`\`

## Event Format

Each event follows SSE protocol:
\`\`\`
id: 123
event: task.created
data: {"eventType":"task.created","timestamp":"2026-02-14T12:00:00Z","data":{...},"metadata":{...}}

\`\`\`
`,
      },
    ],
  };
}
