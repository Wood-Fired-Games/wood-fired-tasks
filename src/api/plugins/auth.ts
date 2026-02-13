import { FastifyPluginAsync } from 'fastify';

/**
 * API Key authentication plugin
 * Reads API keys from process.env.API_KEYS (comma-separated)
 * Adds preHandler hook to check X-API-Key header on all routes in scope
 */
const authPlugin: FastifyPluginAsync = async (fastify) => {
  // Read API keys from environment (comma-separated)
  const apiKeysRaw = process.env.API_KEYS || '';
  const validKeys = new Set(
    apiKeysRaw
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
  );

  // Warn if no API keys configured (but still reject requests - fail closed)
  if (validKeys.size === 0) {
    fastify.log.warn('No API keys configured in API_KEYS env var. All API requests will be rejected.');
  }

  // Add preHandler hook to validate API key
  fastify.addHook('preHandler', async (request, reply) => {
    const apiKey = request.headers['x-api-key'];

    // Missing API key
    if (!apiKey) {
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Missing API key. Provide X-API-Key header.',
      });
    }

    // Invalid API key
    if (!validKeys.has(apiKey as string)) {
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Invalid API key.',
      });
    }

    // Valid API key - continue
  });
};

export default authPlugin;
