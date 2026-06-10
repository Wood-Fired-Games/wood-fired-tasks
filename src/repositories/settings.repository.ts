import type Database from '../db/driver.js';
import { mapRow } from './row-mapper.js';

/**
 * Task 7 (project "Configurable Task Models") — settings repository: the
 * read/write boundary for the database-wide `app_settings.model_policy_default`
 * column (created by migration 016, task #912).
 *
 * `app_settings` is a singleton table — migration 016 pins it to one canonical
 * row via `CHECK (id = 1)` and seeds `(id=1, model_policy_default NULL)`, so the
 * repository always has a row to read/update. Both methods address that row by
 * its fixed primary key (`WHERE id = 1`).
 *
 * The column stores a `ModelPolicy` as TEXT JSON, but JSON (de)serialisation and
 * `ModelPolicySchema` validation are the SERVICE's responsibility
 * (`settings.service.ts`). This repository deals only in the raw `string | null`
 * column value: it never parses, stringifies, or validates. Keeping the policy
 * shape out of the repo mirrors the `projects.value_charter` treatment and keeps
 * the storage layer agnostic of the contract.
 */

/** The `app_settings` singleton row id pinned by migration 016's `CHECK (id = 1)`. */
const APP_SETTINGS_ID = 1;

/** Read/write port over the `app_settings.model_policy_default` column. */
export interface ISettingsRepository {
  /** Return the raw `model_policy_default` column value, or `null` when unset. */
  readModelPolicyDefault(): string | null;
  /** Overwrite the `model_policy_default` column. `null` clears it (stores SQL NULL). */
  writeModelPolicyDefault(json: string | null): void;
}

export class SettingsRepository implements ISettingsRepository {
  private readonly readStmt: Database.Statement;
  private readonly writeStmt: Database.Statement;

  /**
   * @param db the better-sqlite3 handle. Share the same connection the rest of
   *   the request runs through so a write participates in any enclosing
   *   `db.transaction(...)`.
   */
  constructor(private readonly db: Database.Database) {
    this.readStmt = db.prepare('SELECT model_policy_default FROM app_settings WHERE id = ?');
    this.writeStmt = db.prepare('UPDATE app_settings SET model_policy_default = ? WHERE id = ?');
  }

  readModelPolicyDefault(): string | null {
    const row = mapRow<{ model_policy_default: string | null }>(this.readStmt, APP_SETTINGS_ID);
    return row?.model_policy_default ?? null;
  }

  writeModelPolicyDefault(json: string | null): void {
    this.writeStmt.run(json, APP_SETTINGS_ID);
  }
}

/**
 * Factory mirroring the plan's `createSettingsRepository`. Returns the raw
 * read/write port the settings service depends on.
 */
export function createSettingsRepository(db: Database.Database): ISettingsRepository {
  return new SettingsRepository(db);
}
