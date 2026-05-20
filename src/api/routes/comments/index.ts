import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CommentResponseSchema,
  CommentListPaginatedResponseSchema,
  CreateCommentBodySchema,
} from './schemas.js';

// Pagination query schema for GET /tasks/:id/comments.
const QueryCommentListSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const commentRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /tasks/:id/comments - Add comment
  fastify.post(
    '/:id/comments',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: CreateCommentBodySchema,
        response: {
          201: CommentResponseSchema,
        },
        tags: ['comments'],
        description: 'Add a comment to a task',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { author, content } = request.body;

      const comment = fastify.commentService.addComment({
        task_id: id,
        author,
        content,
      });

      return reply.code(201).send(comment);
    }
  );

  // GET /tasks/:id/comments - Get comments for a task (paginated)
  fastify.get(
    '/:id/comments',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        querystring: QueryCommentListSchema,
        response: {
          200: CommentListPaginatedResponseSchema,
        },
        tags: ['comments'],
        description:
          'Get comments for a task in chronological order (paginated). ' +
          'Returns `{ data, total, limit, offset }`.',
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const result = fastify.commentService.getCommentsPaginated(
        id,
        request.query
      );

      return reply.send(result);
    }
  );

  // DELETE /tasks/:id/comments/:commentId - Delete comment
  fastify.delete(
    '/:id/comments/:commentId',
    {
      schema: {
        params: z.object({
          id: z.coerce.number().int().positive(),
          commentId: z.coerce.number().int().positive(),
        }),
        response: {
          204: z.void(),
        },
        tags: ['comments'],
        description: 'Delete a comment',
      },
    },
    async (request, reply) => {
      const { id, commentId } = request.params;

      // Pass task id so the service can enforce ownership — prevents IDOR
      // where a caller deletes a comment via an unrelated task in the URL.
      fastify.commentService.deleteComment(commentId, id);

      return reply.code(204).send();
    }
  );
};

export default commentRoutes;
