-- 048_spine_ondelete_normalisation.sql
-- STATUS: PENDING — NOT YET APPLIED. Awaiting explicit Royce go-ahead.
--
-- Rung 0 (coherence): the spine is ALREADY FK-enforced (~70 FKs across app_data).
-- The real gap is inconsistent ON DELETE semantics. Two spine-parent edges are
-- destructive — deleting a spine row silently destroys dependent SPINE/compliance
-- records. This migration makes exactly those two RESTRICT. Verified against live
-- sks-canonical (ehowgjardagevnrluult) 2026-06-02.
--
--   1. licences.staff_id  -> staff      : CASCADE -> RESTRICT
--        Deleting a staff row currently CASCADE-deletes their licences — i.e. the
--        compliance history that Rung 3 (who-can-work-where) depends on. Must not
--        vanish silently. RESTRICT forces the licences to be handled first.
--
--   2. contacts.customer_id -> customers : CASCADE -> RESTRICT
--        Deleting a customer currently CASCADE-deletes their contact records
--        (contacts is itself a spine entity). RESTRICT forces explicit handling.
--
-- DELIBERATELY NOT TOUCHED:
--   - contact_customer_links.{contact_id,customer_id} CASCADE — junction/link
--     table; CASCADE is correct there (link rows are meaningless without both ends,
--     and once the parents are RESTRICT-protected they cannot orphan).
--   - SET NULL edges (jobs, sites, quote, tenders, timesheets, rotations,
--     schedule_change_logs, tender_nominations, staff.default_site_id,
--     apprentice/buddy/checkin staff refs) — non-destructive (keep the child,
--     drop the dangling ref). Acceptable; revisit as a separate tier if desired.
--   - NO ACTION / RESTRICT edges — already safe.
--
-- ASSUMPTION TO CONFIRM (Royce): canonical spine rows are not HARD-deleted in
-- normal operation — intake upserts (upsert_by_external_id / commit_batch) and the
-- apps soft-delete via active=false. If any flow relies on CASCADE to clean up
-- after a hard customer/staff delete, RESTRICT would block it. No such flow is
-- known. No orphan/data risk: changing ON DELETE does not touch existing rows.
--
-- UNIFORM-SCHEMA MODEL (ops/decisions.md 2026-06-02): canonical migration — apply
-- identically to EVERY tenant DB (sks-canonical AND eq-canonical-internal).
--
-- LOCK: each DROP+ADD takes a brief ACCESS EXCLUSIVE lock on the child table and
-- re-validates it. contacts=331 rows, licences=3 rows — sub-second.

-- 1. licences.staff_id : CASCADE -> RESTRICT
ALTER TABLE app_data.licences DROP CONSTRAINT IF EXISTS licences_staff_id_fkey;
ALTER TABLE app_data.licences
  ADD CONSTRAINT licences_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES app_data.staff(staff_id) ON DELETE RESTRICT;

-- 2. contacts.customer_id : CASCADE -> RESTRICT
ALTER TABLE app_data.contacts DROP CONSTRAINT IF EXISTS contacts_customer_id_fkey;
ALTER TABLE app_data.contacts
  ADD CONSTRAINT contacts_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES app_data.customers(customer_id) ON DELETE RESTRICT;

INSERT INTO app_data._eq_migrations (name) VALUES ('048_spine_ondelete_normalisation')
ON CONFLICT (name) DO NOTHING;
