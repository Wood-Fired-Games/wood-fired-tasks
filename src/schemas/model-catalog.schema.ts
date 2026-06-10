import { z } from 'zod';

/**
 * Configurable Task Models (task #930) — the SINGLE declaration of the model
 * catalog wire shape.
 *
 * One discovered model, normalised to the fields downstream code needs. This
 * shape previously lived as four independent declarations (the catalog
 * service's `ModelCatalogEntry`, the REST route's `ModelCatalogEntrySchema`,
 * the remote rest-client's `ModelCatalogEntryPayload`, and the CLI client's
 * `ModelCatalogEntry`). It is now declared ONCE here — `src/schemas` is a leaf
 * layer every other layer may import, and `import type` is erased at build
 * time, so even the remote rest-client's "stay importable from a minimal
 * stdio subprocess" isolation rationale is preserved.
 */
export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  family: z.string(),
  created_at: z.string(),
});

/** A single discovered model, normalised to the fields downstream code needs. */
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
