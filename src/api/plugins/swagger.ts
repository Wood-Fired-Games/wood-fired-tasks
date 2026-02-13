import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * Register Swagger/OpenAPI documentation plugins
 * Must be called BEFORE registering routes to capture their schemas
 */
export async function registerSwagger(fastify: FastifyInstance): Promise<void> {
  // Register @fastify/swagger for OpenAPI spec generation
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Wood Fired Bugs API',
        description: 'Task management REST API for Wood Fired Games. Designed for LLM agent consumption.',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });

  // Register @fastify/swagger-ui for interactive documentation
  await fastify.register(fastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}
