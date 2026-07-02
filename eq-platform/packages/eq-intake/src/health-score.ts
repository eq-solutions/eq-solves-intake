/**
 * @eq/intake — data health scorer
 *
 * computeHealthScores() checks each core entity type against three of the
 * DAMA-UK data quality dimensions (Completeness, Validity, Timeliness) and
 * returns a HealthScore[] array. Consistency (referential integrity) and
 * Uniqueness (duplicate detection) are computed elsewhere — see
 * orphan-check.ts and duplicate-detect.ts — because they need cross-row or
 * cross-entity comparison rather than a per-row pass. Accuracy (does the
 * value reflect ground truth) is deliberately not attempted here — no
 * automated check can verify it without an external source of truth, which
 * is why every mainstream data-quality platform excludes it from an
 * automated composite score too.
 *
 * A "complete" row has all required fields non-null and non-empty.
 * The score is the fraction of complete rows: complete / total (0–1).
 * gaps[] lists which fields are most frequently missing.
 *
 * validity and freshness are computed from the same fetched rows as
 * completeness — no extra round trip.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';
import { isValidAbn, isValidAuPhone, isValidAuState, isValidAuPostcode } from './normalize.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthScore {
  entity:    string;       // 'staff' | 'sites' | 'assets' | 'customers' | 'contacts'
  total:     number;       // total rows for tenant
  complete:  number;       // rows where all required fields are present
  score:     number;       // 0–1 (complete / total, or 1 if total === 0)
  started:   boolean;      // false when total === 0 — distinguishes "no data yet" from "fully complete"
  validity:  number;       // 0–1 — fraction of format-checkable fields that pass, among rows that populated them (1 if nothing to check)
  freshness: number;       // 0–1 — fraction of rows updated within the last 365 days (1 if no rows, or no updated_at data to judge)
  gaps:      string[];     // field names with the most null/empty values (top 5)
}

// Required field lists per entity — mirrors NOT NULL columns in app_data schema.
const REQUIRED_FIELDS: Record<string, string[]> = {
  customers: ['company_name'],
  sites:     ['name'],
  contacts:  ['first_name', 'last_name'],
  staff:     ['first_name', 'last_name'],
  assets:    ['name', 'asset_type'],
};

// All fields to inspect for gap analysis (required + commonly-populated).
// Column names verified against app_data schema 2026-06-24.
const INSPECTED_FIELDS: Record<string, string[]> = {
  customers: ['company_name', 'email', 'primary_phone', 'abn'],
  sites:     ['name', 'address_line_1', 'suburb', 'postcode', 'customer_id'],
  contacts:  ['first_name', 'last_name', 'email', 'work_phone'],
  staff:     ['first_name', 'last_name', 'email', 'phone', 'trade', 'emergency_contact_name'],
  assets:    ['name', 'asset_type', 'serial_number', 'make', 'model'],
};

// Phone field name varies per entity — mirrors confidence-score.ts.
const PHONE_FIELD: Record<string, string> = {
  customers: 'primary_phone',
  contacts:  'work_phone',
  staff:     'phone',
};

const FRESHNESS_WINDOW_DAYS = 365;

type EntityKey = keyof typeof REQUIRED_FIELDS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  return false;
}

function isComplete(row: Record<string, unknown>, requiredFields: string[]): boolean {
  return requiredFields.every((f) => !isBlank(row[f]));
}

// Validity: of the format-checkable fields a row actually populated, what
// fraction pass the format check? A blank field is a completeness gap
// (counted above), not a validity failure — excluded here so it isn't
// double-penalised.
function rowValidityChecks(entity: string, row: Record<string, unknown>): { checked: number; valid: number } {
  let checked = 0;
  let valid = 0;

  if (entity === 'customers') {
    const abn = row['abn'];
    if (!isBlank(abn)) { checked++; if (isValidAbn(String(abn))) valid++; }
    const state = row['state'];
    if (!isBlank(state)) { checked++; if (isValidAuState(String(state))) valid++; }
  }
  if (entity === 'sites') {
    const state = row['state'];
    if (!isBlank(state)) { checked++; if (isValidAuState(String(state))) valid++; }
    const postcode = row['postcode'];
    if (!isBlank(postcode)) { checked++; if (isValidAuPostcode(String(postcode))) valid++; }
  }
  const phoneField = PHONE_FIELD[entity];
  if (phoneField) {
    const phone = row[phoneField];
    if (!isBlank(phone)) { checked++; if (isValidAuPhone(String(phone))) valid++; }
  }

  return { checked, valid };
}

function daysSince(isoStr: unknown, now: Date): number | null {
  if (typeof isoStr !== 'string' || isoStr === '') return null;
  const then = new Date(isoStr);
  if (isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

function topGaps(
  rows: Record<string, unknown>[],
  fields: string[],
  limit = 5,
): string[] {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const f of fields) {
      if (isBlank(row[f])) {
        counts[f] = (counts[f] ?? 0) + 1;
      }
    }
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .filter(([, count]) => count > 0)
    .map(([field]) => field);
}

// ---------------------------------------------------------------------------
// Public: computeHealthScores
// ---------------------------------------------------------------------------

type RpcFn = (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;

export async function computeHealthScores(
  supabase: SupabaseLikeClient,
): Promise<HealthScore[]> {
  const entities = Object.keys(REQUIRED_FIELDS) as EntityKey[];
  const rpc = (supabase as unknown as { rpc: RpcFn }).rpc.bind(supabase);

  const results = await Promise.all(
    entities.map((entity) =>
      rpc('eq_tidy_read_entity', { p_table: entity }).then((r) => ({ entity, ...r })),
    ),
  );

  const now = new Date();

  return results.map(({ entity, data: rawData, error }) => {
    const required  = REQUIRED_FIELDS[entity] ?? [];
    const inspected = INSPECTED_FIELDS[entity] ?? required;

    if (error) {
      return {
        entity, total: 0, complete: 0, score: 0, started: false,
        validity: 1, freshness: 1, gaps: [`Error reading ${entity}: ${error.message}`],
      };
    }

    const rows     = (rawData as Record<string, unknown>[] | null) ?? [];
    const total    = rows.length;
    const complete = rows.filter((r) => isComplete(r, required)).length;
    const score    = total === 0 ? 1 : complete / total;
    const started  = total > 0;
    const gaps     = topGaps(rows, inspected);

    let checkedTotal = 0;
    let validTotal   = 0;
    let freshCount   = 0;
    let judgeable    = 0;

    for (const row of rows) {
      const { checked, valid } = rowValidityChecks(entity, row);
      checkedTotal += checked;
      validTotal   += valid;

      const days = daysSince(row['updated_at'], now);
      if (days !== null) {
        judgeable++;
        if (days <= FRESHNESS_WINDOW_DAYS) freshCount++;
      }
    }

    const validity  = checkedTotal === 0 ? 1 : validTotal / checkedTotal;
    const freshness = judgeable === 0 ? 1 : freshCount / judgeable;

    return { entity, total, complete, score, started, validity, freshness, gaps };
  });
}
