import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CommentService } from '../../services/comment.service.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';

export function registerCommentTools(
  server: McpServer,
  commentService: CommentService
): void {
  // add_comment - Add a comment to a task
  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a task',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        author: z.string().min(1).max(100),
        content: z.string().min(1).max(5000),
      }),
    },
    async (args) => {
      try {
        const comment = commentService.addComment({
          task_id: args.task_id,
          author: args.author,
          content: args.content,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Comment added by ${comment.author} on task ${comment.task_id}`,
            },
          ],
          structuredContent: {
            comment: {
              id: comment.id,
              task_id: comment.task_id,
              author: comment.author,
              content: comment.content,
              created_at: comment.created_at,
              updated_at: comment.updated_at,
            },
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // get_comments - Get comments for a task (paginated)
  server.registerTool(
    'get_comments',
    {
      description:
        'Get comments for a task in chronological order with pagination (limit default 50, max 500; offset default 0). Returns `{ task_id, comments, total, limit, offset }`.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args) => {
      try {
        const taskId = args.task_id;
        const page = commentService.getCommentsPaginated(taskId, {
          limit: args.limit,
          offset: args.offset,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Found ${page.data.length} of ${page.total} comment(s) for task ${taskId} (limit=${page.limit}, offset=${page.offset})`,
            },
          ],
          structuredContent: {
            task_id: taskId,
            comments: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // delete_comment - Delete a comment
  server.registerTool(
    'delete_comment',
    {
      description: 'Delete a comment by ID',
      inputSchema: z.object({
        comment_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const commentId = args.comment_id;
        commentService.deleteComment(commentId);

        return {
          content: [
            {
              type: 'text',
              text: `Comment ${commentId} deleted successfully`,
            },
          ],
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );
}
