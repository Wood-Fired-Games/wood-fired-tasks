import type Database from '../driver.js';

/**
 * Migration 020: optional per-PAT project binding (Security Audit finding M1 —
 * task #1635).
 *
 * Background. Tasks #1620/#1621/#1622 gave Personal Access Tokens a tier
 * (`read < write < admin`) and wired a route-level gate for it. A tier alone
 * still lets a `write` token reach EVERY project in the database, which for a
 * multi-agent backlog is most of the blast radius finding M1 was about. This
 * migration adds the missing second dimension: a token MAY declare exactly one
 * project it is allowed to touch.
 *
 * Column added:
 *  - `api_tokens.project_id` INTEGER NULL REFERENCES projects(id) ON DELETE
 *    CASCADE — the bound project, or NULL for an unbound (cross-project) token.
 *
 * Why NULLABLE (and why NULL means "unbound"):
 *  Every token that exists today predates the binding, so the column has to
 *  have a value that means "unchanged". NULL is that value, and it mirrors the
 *  legacy convention the scope taxonomy already uses (`scopes = '[]'` ⇒
 *  full-tier — see `grantSatisfiesScope` in `src/schemas/pat-scope.schema.ts`).
 *  The enforcement predicate `bindingSatisfiesProjects` short-circuits to
 *  `true` on a NULL binding, so this migration is a pure no-op for every
 *  pre-existing token: no backfill, no behaviour change until someone mints a
 *  token that explicitly asks to be bound.
 *
 * Why ON DELETE CASCADE and NOT `SET NULL`:
 *  `PRAGMA foreign_keys` is ON for every connection (`src/db/database.ts`), so
 *  the referential action is live. `SET NULL` would be a silent privilege
 *  ESCALATION — deleting the bound project would convert a narrowly-scoped
 *  token into an unrestricted cross-project one. The default (`NO ACTION`)
 *  would be almost as bad in the other direction: it would make
 *  `DELETE FROM projects` fail with an FK error whenever any token happened to
 *  be bound to it, turning an authorization detail into an availability bug in
 *  the project-delete path. CASCADE is the only action that fails closed: the
 *  project goes away and the credential that could only ever have reached it
 *  goes away with it. This matches the `ON DELETE CASCADE` already used for
 *  `api_tokens.user_id` (migration 008).
 *
 * SQLite specifics:
 *  `ALTER TABLE ... ADD COLUMN` accepts a REFERENCES clause as long as the
 *  column's default is NULL, which it is here — so no table rebuild is needed
 *  and the existing indexes/triggers on `api_tokens` are untouched.
 *
 * No index is added. The column is never a lookup key: the binding is read off
 * the row that `findByHash` already fetched during authentication, so a query
 * plan on `project_id` never happens.
 *
 * down() drops the column. SQLite's `DROP COLUMN` restrictions (PK / UNIQUE /
 * indexed / referenced-by-trigger columns cannot be dropped) do not apply —
 * `project_id` is none of those. Dropping it reverts every token to the
 * unbound behaviour, which is exactly the pre-020 semantics.
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` per the 017/018/019
 * convention.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(
      'ALTER TABLE api_tokens ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE',
    );
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE api_tokens DROP COLUMN project_id');
  })();
}
