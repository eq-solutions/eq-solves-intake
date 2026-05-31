-- ============================================================================
-- 024 — EQ Service → canonical_id columns
-- ============================================================================
-- Applies to: EQ Service Supabase (urjhmkhbgaxrofurpbgc)
-- NOT sks-canonical. Run this against the eq-solves-service project.
--
-- Adds canonical_id columns to EQ Service's customers and sites tables so
-- each local record can be linked back to the canonical source of truth in
-- sks-canonical (ehowgjardagevnrluult).
--
-- Write-through strategy (additive — no FK chain ripped out):
--   1. Add canonical_id UUID column (nullable, no FK — cross-DB FK impossible)
--   2. Add canonical_synced_at timestamp to track last push to canonical
--   3. Back-fill the 7 known customers that already have a canonical link
--      (from the manual mapping done in the previous session)
--   4. The EQ Service write-through adapter (lib/canonical-sync.ts) populates
--      canonical_id whenever a customer or site is created/updated.
--
-- After running this migration, EQ Service's customers and sites are in
-- "write-through cache" mode — they continue to work as before, but every
-- create/update now also pushes to canonical via the canonical-api PUT endpoint.
-- ============================================================================

-- ── customers ─────────────────────────────────────────────────────────────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS canonical_id        uuid,
  ADD COLUMN IF NOT EXISTS canonical_synced_at timestamptz;

COMMENT ON COLUMN customers.canonical_id IS
  'UUID of matching record in sks-canonical app_data.customers. NULL = not yet synced.';
COMMENT ON COLUMN customers.canonical_synced_at IS
  'When canonical_id was last written/confirmed via the canonical-api PUT endpoint.';

-- Index to support: SELECT * FROM customers WHERE canonical_id = $1
CREATE INDEX IF NOT EXISTS customers_canonical_id_idx
  ON customers(canonical_id)
  WHERE canonical_id IS NOT NULL;

-- ── sites ─────────────────────────────────────────────────────────────────────

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS canonical_id        uuid,
  ADD COLUMN IF NOT EXISTS canonical_synced_at timestamptz;

COMMENT ON COLUMN sites.canonical_id IS
  'UUID of matching record in sks-canonical app_data.sites. NULL = not yet synced.';
COMMENT ON COLUMN sites.canonical_synced_at IS
  'When canonical_id was last written/confirmed via the canonical-api PUT endpoint.';

CREATE INDEX IF NOT EXISTS sites_canonical_id_idx
  ON sites(canonical_id)
  WHERE canonical_id IS NOT NULL;

-- ── Back-fill known canonical_id values ──────────────────────────────────────
-- These 7 customers were manually matched in the previous session.
-- EQ Service customer ID → canonical customer_id (in sks-canonical).
-- Uncomment and fill in when running against the live EQ Service DB.
-- (Separate back-fill script: scripts/backfill_canonical_ids.sql)

-- UPDATE customers SET canonical_id = '<canonical_customer_id_uuid>'
-- WHERE id = '<eq_service_customer_id>';

-- ── Migration record ──────────────────────────────────────────────────────────
-- EQ Service uses a different migrations table; adapt as needed.
-- If no migrations table exists, just run the ALTER TABLE statements above.

-- INSERT INTO _migrations (name, applied_at)
-- VALUES ('024_eq_service_canonical_columns', now())
-- ON CONFLICT (name) DO NOTHING;
