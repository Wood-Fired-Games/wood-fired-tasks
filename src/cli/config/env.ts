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

// Validate and export environment configuration
function validateApiKey(): string {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error('Error: API_KEY is required but not set.');
    console.error('');
    console.error('Please set API_KEY in one of the following ways:');
    console.error('  1. Create a .env file in the project root with: API_KEY=your-key-here');
    console.error('  2. Set it as an environment variable: export API_KEY=your-key-here');
    console.error('');
    process.exit(1);
  }
  return apiKey;
}

export const env = {
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:3000',
  // Use getter to defer validation until API_KEY is accessed
  // This allows --help to work without requiring API_KEY
  get API_KEY(): string {
    return validateApiKey();
  },
};
