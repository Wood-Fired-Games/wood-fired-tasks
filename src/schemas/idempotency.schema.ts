import { z } from 'zod';

/**
 * Validation schema for the `X-Idempotency-Key` request header.
 *
 * Constraints exist to bound DB growth in `idempotency_keys` and prevent
 * abuse by clients submitting arbitrarily large or structurally diverse
 * keys (each row is keyed by this exact string). Length and charset are
 * enforced BEFORE the value is used as a SQLite primary key.
 *
 * - Min 8 chars: keeps keys collision-resistant for legitimate retries.
 * - Max 128 chars: bounds row size; comfortably fits UUIDs (36 chars),
 *   ULIDs (26 chars), and namespaced keys like `service:uuid`.
 * - `[A-Za-z0-9_-]` only: matches common idempotency-key formats
 *   (UUIDs sans hyphens, ULIDs, opaque tokens). Excludes whitespace,
 *   quoting, path separators, and control characters.
 */
export const idempotencyKeyHeaderSchema = z
  .string()
  .min(8, 'X-Idempotency-Key must be at least 8 characters')
  .max(128, 'X-Idempotency-Key must be at most 128 characters')
  .regex(
    /^[A-Za-z0-9_-]+$/,
    'X-Idempotency-Key may only contain letters, digits, hyphens, and underscores'
  );

export type IdempotencyKeyHeader = z.infer<typeof idempotencyKeyHeaderSchema>;
