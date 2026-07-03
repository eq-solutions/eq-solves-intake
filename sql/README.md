# eq-intake tenant-plane SQL

Hand-applied migrations against the tenant data planes (`app_data.*` on
ehow / zaap). Numbering is allocated from the **live ledger**
(`app_data._eq_migrations`), which this lineage shares with eq-shell's
`supabase/tenant-migrations/` (the One Pipe).

## Ledger rule — every self-insert must stamp a checksum

End every migration with:

```sql
INSERT INTO app_data._eq_migrations (name, checksum)
VALUES ('NNN_short_name', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
```

**Never insert `(name)` alone.** eq-shell's drift gate
(`scripts/check-tenant-drift.mjs`, runs every 3 hours) hard-fails on any
NULL-checksum ledger row dated on/after 2026-07-03: its runner is the single
ledger writer on the eq-shell side and always stamps a checksum, so a
NULL-checksum row is indistinguishable from a rogue hand-insert. The
`'eq-intake-lineage'` marker keeps the row honest (greppable provenance) and
keeps the gate green — the value itself is never compared, because eq-intake
names are out-of-band to the eq-shell repo.

Context: eq-shell PR #612 (0157 quality-guardian adoption); the gate went
red on 2026-07-03 when `058` + `062` landed with NULL checksums (backfilled
the same day).
