/**
 * @eq/intake — field importance rulebook
 *
 * Single source of truth for "does a blank field on an already-committed
 * record count as a gap worth surfacing" — replaces what were four
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
 * `tier: 'optional'` fields are deliberately never returned by
 * getFlaggableFields() — that's the whole point of the tier: nothing breaks
 * if they're blank, so they should never cost a "gap" anywhere in the UI.
 * getInspectedFields() still returns them (all tiers) for anything that
 * wants the full rulebook, e.g. a future settings screen.
 *
 * Scope: Staff, Licences, Assets, Sites. Customers/Contacts are NOT migrated
 * yet — both entities check a synthesized `phone` field (mobile_phone ||
 * work_phone/primary_phone, built in EntityDrillDown's deriveRow()) that
 * doesn't exist as a real schema column, while health-score.ts checks the
 * raw columns directly. Those two already disagree on WHICH field name
 * means "phone" for these two entities — a second, separate bug found while
 * scoping this rulebook, flagged rather than silently worked around here.
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
    { field: 'preferred_name',         tier: 'optional',  why: 'A nickname is nice to know, nothing depends on it.' },
    { field: 'home_base',              tier: 'optional',  why: 'Handy context, no feature reads it.' },
  ],
  licences: [
    { field: 'expiry_date',      tier: 'critical', why: 'Drives the 60-day expiry alert — an expired ticket is a live compliance risk.' },
    { field: 'licence_number',   tier: 'critical', why: 'Identifies the specific licence issued.' },
    { field: 'licence_type',     tier: 'critical', why: 'Determines which compliance rules apply.' },
    { field: 'issuing_authority', tier: 'optional', why: 'Reference detail, not checked anywhere.' },
    { field: 'issue_date',        tier: 'optional', why: 'Supporting context for expiry_date, not an obligation on its own.' },
  ],
  assets: [
    { field: 'name',          tier: 'critical',  why: 'An asset record is unusable without a name.' },
    { field: 'asset_type',    tier: 'critical',  why: 'Drives which maintenance checks apply.' },
    { field: 'site_id',       tier: 'critical',  why: 'An asset with no site is orphaned — invisible to Field and Service.' },
    { field: 'serial_number', tier: 'important', why: 'Used for duplicate detection and warranty / service-history matching.' },
    { field: 'make',          tier: 'important', why: 'Helps techs order the right replacement parts.' },
    { field: 'model',         tier: 'important', why: 'Helps techs order the right replacement parts.' },
    { field: 'install_date',      tier: 'optional', why: 'Planning context, no feature depends on it.' },
    { field: 'warranty_expires',  tier: 'optional', why: 'Only matters at claim time, not day to day.' },
  ],
  sites: [
    { field: 'customer_id',     tier: 'critical',  why: 'A site with no customer is orphaned in the CRM hierarchy.' },
    { field: 'address_line_1',  tier: 'important', why: 'Needed to actually dispatch a crew there.' },
    { field: 'suburb',          tier: 'important', why: 'Needed to actually dispatch a crew there.' },
    { field: 'postcode',        tier: 'important', why: 'Needed to actually dispatch a crew there.' },
    { field: 'state',           tier: 'important', why: 'Needed for state-based licence/compliance matching.' },
  ],
};

/** Every field the rulebook has an opinion on for this entity, any tier. */
export function getInspectedFields(entity: string): string[] {
  return (FIELD_IMPORTANCE[entity] ?? []).map((e) => e.field);
}

/**
 * Fields worth flagging as a gap when blank — critical + important only.
 * This is what every gap-surfacing consumer (Overview's score, the live
 * "Gaps" filter) should call, never getInspectedFields directly, or an
 * "optional" field would still show up as a gap.
 */
export function getFlaggableFields(entity: string): string[] {
  return (FIELD_IMPORTANCE[entity] ?? [])
    .filter((e) => e.tier !== 'optional')
    .map((e) => e.field);
}

/** null if the entity/field isn't in the rulebook (i.e. not currently inspected). */
export function getFieldTier(entity: string, field: string): FieldTier | null {
  return FIELD_IMPORTANCE[entity]?.find((e) => e.field === field)?.tier ?? null;
}
