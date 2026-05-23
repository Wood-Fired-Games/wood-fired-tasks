// Row-shape interfaces for the identity tables introduced by migration 008.
// Field names are snake_case to match the SQLite column names exactly — the
// repository row-mapper boundary returns rows as-is (see src/repositories/row-mapper.ts).
// SQLite booleans land as INTEGER (0|1), so we model them as `number`.

export interface User {
  id: number;
  oidc_sub: string | null;
  oidc_provider: string | null;
  email: string | null;
  display_name: string;
  slack_user_id: string | null;
  is_legacy: number;
  is_service_account: number;
  created_at: string;
  disabled_at: string | null;
}

export interface ApiToken {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  suffix: string;
  hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}
