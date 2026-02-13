import Database from 'better-sqlite3';
import { Umzug, type UmzugStorage } from 'umzug';
import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Custom Umzug storage that uses SQLite to track migrations.
 */
class SQLiteStorage implements UmzugStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureMigrationsTable();
  }

  private ensureMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async logMigration({ name }: { name: string }): Promise<void> {
    this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  }

  async unlogMigration({ name }: { name: string }): Promise<void> {
    this.db.prepare('DELETE FROM _migrations WHERE name = ?').run(name);
  }

  async executed(): Promise<string[]> {
    const rows = this.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    return rows.map(row => row.name);
  }
}

/**
 * Create an Umzug instance configured for this project.
 */
function createUmzug(db: Database.Database): Umzug<Database.Database> {
  // Support both .ts (dev/test via tsx) and .js (production compiled) migrations
  const ext = __dirname.includes('/dist/') ? 'js' : 'ts';

  return new Umzug({
    migrations: {
      glob: join(__dirname, 'migrations', `*.${ext}`),
      resolve: ({ name, path }) => ({
        name,
        up: async () => {
          const migration = await import(path!);
          return migration.up(db);
        },
        down: async () => {
          const migration = await import(path!);
          return migration.down(db);
        },
      }),
    },
    context: db,
    storage: new SQLiteStorage(db),
    logger: console,
  });
}

/**
 * Run all pending migrations.
 */
export async function runMigrations(db: Database.Database): Promise<void> {
  const umzug = createUmzug(db);
  await umzug.up();
}

/**
 * CLI entry point: run migrations on the default database.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dataDir = join(process.cwd(), 'data');
  const dbPath = join(dataDir, 'tasks.db');

  // Create data directory if it doesn't exist
  try {
    await readdir(dataDir);
  } catch {
    const { mkdir } = await import('fs/promises');
    await mkdir(dataDir, { recursive: true });
  }

  const db = initDatabase(dbPath);
  await runMigrations(db);
  console.log('Migrations complete!');
  db.close();
}
