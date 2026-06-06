import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Resolve path to .env file at project root (3 levels up from src/cli/config/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');
const envPath = path.join(projectRoot, '.env');

// Load environment variables from .env file
dotenv.config({ path: envPath, quiet: true });

// Plan 30-05: API_KEY is no longer required at env-load time. The CLI now
// authenticates via the precedence chain in src/cli/auth/credentials.ts —
// --token flag > credentials file > env.API_KEY > NotAuthenticatedError.
// The "no credentials" branch is enforced by resolveAuth (which throws
// NotAuthenticatedError), not here. Returning '' from the getter keeps the
// type narrow and lets resolveAuth's `apiKey.length > 0` check decide.
export const env = {
  API_BASE_URL: process.env['API_BASE_URL'] || 'http://localhost:3000',
  // Getter so callers re-read process.env.API_KEY on each access — important
  // for tests that mutate env between calls.
  get API_KEY(): string {
    return process.env['API_KEY'] ?? '';
  },
};
