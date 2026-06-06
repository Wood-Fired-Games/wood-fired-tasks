// The ONE place that imports the native better-sqlite3 dependency.
// All other modules import Database from this seam so a future swap to
// node:sqlite is a one-file change.
//
// The default re-export carries both the constructor value AND its merged
// type, so call sites that do `import Database from '.../driver.js'` and
// `import type Database from '.../driver.js'` both keep working. The named
// `Database` type re-export backs call sites that do
// `import type { Database } from '.../driver.js'`.
import BetterSqlite3 from 'better-sqlite3';

export default BetterSqlite3;
export type Database = BetterSqlite3.Database;
