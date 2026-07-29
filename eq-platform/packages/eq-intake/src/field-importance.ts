/**
 * @eq/intake — field importance rulebook
 *
 * Single source of truth for "does a blank field on an already-committed
 * record count as a gap worth surfacing" — replaces four previously
 * independent, disagreeing field lists:
 *   - health-score.ts's INSPECTED_FIELDS (drives the Overview score's gaps[])
 *   - eq-intake-demo/EntityDrillDown.tsx's GAP_FIELDS (drives the "Gaps"
 *     filter tab on the live entity table)
 *   - compliance-metrics.ts's hand-picked staff checks
 *   - IntakeHealthHome.tsx's deriveActions() action-card copy
 *
 * Deliberately does NOT cover schema-`required` fields (staff.first_name,
 * assets.site_id's own required-ness, etc) — those can never be blank on a
 * committed row (validation rejects them first), so there's nothing to tier.
 * This table is only for nullable fields where "blank" is a real judgment
 * call, not a hard fact.
 *
 * Scope: Staff, Licences, Assets only, and only fields at least one consumer
 * already tracked today. Customers/Sites/Contacts keep their own local field
 * lists for now — deliberately not migrated in this pass to avoid widening
 * an already-decided scope (see eq-context session log, 2026-07-29).
 */

export type FieldTier = 'critical' | 'important' | 'optional';

export interface FieldImportanceEntry {
  field: string;
  tier:  FieldTier;
  why:   string;
}

export const FIELD_IMPORTANCE: Record<string, FieldImportanceEntry[]> = {
  staff: [
    { field: 'emergency_contact_name', tier: 'critical',  why: 'Required for field dispatch under H&S compliance.' },
    { field: 'trade',                  tier: 'important', why: 'Skill-based dispatch and PPM assignment need this field.' },
    { field: 'email',                  tier: 'important', why: "Without it they won't receive roster notifications or shift confirmations." },
    { field: 'phone',                  tier: 'important', why: "Without it they won't receive roster notifications or shift confirmations." },
  ],
  licences: [
    { field: 'expiry_date',    tier: 'critical', why: 'Drives the 60-day expiry alert — an expired ticket is a live compliance risk.' },
    { field: 'licence_number', tier: 'critical', why: 'Identifies the specific licence issued.' },
    { field: 'licence_type',   tier: 'critical', why: 'Determines which compliance rules apply.' },
  ],
  assets: [
    { field: 'name',          tier: 'critical',  why: 'An asset record is unusable without a name.' },
    { field: 'asset_type',    tier: 'critical',  why: 'Drives which maintenance checks apply.' },
    { field: 'site_id',       tier: 'critical',  why: 'An asset with no site is orphaned — invisible to Field and Service.' },
    { field: 'serial_number', tier: 'important', why: 'Used for duplicate detection and warranty / service-history matching.' },
    { field: 'make',          tier: 'important', why: 'Helps techs order the right replacement parts.' },
    { field: 'model',         tier: 'important', why: 'Helps techs order the right replacement parts.' },
  ],
};

/** Field names to check for blanks on a given entity, in rulebook order. */
export function getInspectedFields(entity: string): string[] {
  return (FIELD_IMPORTANCE[entity] ?? []).map((e) => e.field);
}

/** null if the entity/field isn't in the rulebook (i.e. not currently inspected). */
export function getFieldTier(entity: string, field: string): FieldTier | null {
  return FIELD_IMPORTANCE[entity]?.find((e) => e.field === field)?.tier ?? null;
}
