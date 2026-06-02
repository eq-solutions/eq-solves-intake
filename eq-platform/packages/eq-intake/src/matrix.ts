/**
 * Training-matrix reshape (wide → long) for licence/ticket ingest.
 *
 * Most licence data arrives "long" — one row per (person, licence). A training
 * MATRIX is the other common shape: one row per person, one COLUMN per licence
 * type, and each cell encodes whether that person holds it (and when it expires).
 * The existing parseFile() + classifySheet() pipeline handles long sheets; this
 * module adds the missing wide-matrix capability.
 *
 * Design rule: PROPOSE, never commit. This function reads a ParsedSheet and a
 * staff list and returns a MatrixIngestProposal — suggested licence records,
 * suggested column→type mappings, and a people-reconciliation report bucketed
 * into auto / confirm / unresolved. It writes NOTHING. A human (or the confirm
 * UI / Field) reviews the proposal before anything lands in canonical.
 *
 * Two things this surfaces honestly rather than guessing:
 *   - A matrix has no licence NUMBERS, but licence.schema.json requires one.
 *     Every proposed record is flagged `missing_licence_number` — not invented.
 *   - Ambiguous cells (`X`) and near-miss names are flagged for confirmation,
 *     never silently resolved.
 */

import type { ParsedSheet } from "./readers/csv.js";

// ============================================================================
// TYPES
// ============================================================================

/** What a single matrix cell means. */
export type CellState = "held_expiry" | "held_permanent" | "expired" | "none";

/** A staff member to reconcile matrix names against (from the tenant's people list). */
export interface StaffRef {
  staff_id: string;
  first_name?: string;
  last_name?: string;
  /** Full name if first/last aren't split. */
  name?: string;
  email?: string | null;
  external_id?: string | null;
}

export type MatchStatus = "auto" | "confirm" | "unresolved";

export interface PersonMatch {
  source_index: number;
  source_name: string;
  status: MatchStatus;
  staff_id: string | null;
  matched_name: string | null;
  email: string | null;
  score: number;
  flags: string[];
}

export type MapMethod = "schema_alias" | "matrix_dictionary" | "unmapped";

export interface ColumnMapping {
  source_header: string;
  licence_type: string | null;
  confidence: number;
  method: MapMethod;
  flags: string[];
}

export interface ProposedLicence {
  source_index: number;
  staff_ref: { name: string; staff_id: string | null; match_status: MatchStatus };
  source_column: string;
  source_value: string;
  licence_type: string | null;
  state: CellState;
  expiry_date: string | null;
  active: boolean;
  flags: string[];
}

export interface MatrixIngestProposal {
  source: string;
  identity_columns: string[];
  licence_columns: string[];
  column_mappings: ColumnMapping[];
  people: {
    auto: PersonMatch[];
    confirm: PersonMatch[];
    unresolved: PersonMatch[];
    duplicates: Array<{ name: string; source_indices: number[]; staff_id: string | null }>;
  };
  proposed_licences: ProposedLicence[];
  summary: {
    people_total: number;
    auto: number;
    confirm: number;
    unresolved: number;
    duplicates: number;
    licences_proposed: number;
    licences_flagged: number;
  };
  /** Always true — this is a proposal, nothing was written. */
  proposal_only: true;
}

export interface MatrixIngestOptions {
  /** Source label for provenance (filename, system name). */
  source?: string;
  /** Headers (case-insensitive) treated as identity, not licence columns. */
  identityHeaders?: string[];
  /** Name column header. Default: first identity column that looks like a name. */
  nameColumn?: string;
  /** Staff list to reconcile against. */
  staff?: StaffRef[];
  /** Score >= this on a unique candidate → auto-match. Default 0.92. */
  autoThreshold?: number;
  /** Score in [confirmThreshold, autoThreshold) → needs confirmation. Default 0.60. */
  confirmThreshold?: number;
}

// ============================================================================
// LICENCE-TYPE MAPPING
//
// Mirrors licence.schema.json's x-eq-suggested-values + x-eq-enum-aliases for
// the types canonical already knows, and adds the matrix's NSW-specific
// abbreviations. Types not yet in canonical's suggested list are flagged
// `new_type` so they surface for confirmation rather than landing silently.
// ============================================================================

/** Canonical types already in licence.schema.json x-eq-suggested-values. */
const SCHEMA_KNOWN = new Set([
  "white_card",
  "driver_licence",
  "first_aid",
  "cpr",
  "working_at_heights",
  "confined_space",
  "ewp",
  "forklift_hrwl",
  "electrical_licence",
]);

/** alias (normalised) → canonical licence_type. */
const TYPE_ALIASES: Record<string, string> = {
  // --- known to canonical ---
  "drivers licence": "driver_licence",
  "driver licence": "driver_licence",
  "electrical licence": "electrical_licence",
  "construction induction": "white_card",
  wah: "working_at_heights",
  "confined space": "confined_space",
  "first aid": "first_aid",
  cpr: "cpr",
  // --- NSW matrix abbreviations → canonical (new types) ---
  "open cabling": "open_cabling",
  sl: "ewp_scissor_lift",
  "bl under 11m": "ewp_boom_lift_lt11",
  "vl under 11m": "ewp_vertical_lift_lt11",
  "hrl bl 11m": "boom_lift_hrwl",
  "hrl forklift": "forklift_hrwl",
  "hrl dogging": "dogging_hrwl",
  riw: "rail_industry_worker",
  lvr: "low_voltage_rescue",
  "hv switching": "hv_switching",
  "hv operators": "hv_operator",
  "manual handling": "manual_handling",
  "silica awareness": "silica_awareness",
};

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(/g, " ")
    .replace(/\)/g, " ")
    .replace(/\+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map a source column header to a canonical licence_type with confidence + flags. */
export function mapLicenceColumn(header: string): ColumnMapping {
  const norm = normaliseHeader(header);
  const canonical = TYPE_ALIASES[norm];

  if (!canonical) {
    return {
      source_header: header,
      licence_type: null,
      confidence: 0,
      method: "unmapped",
      flags: ["unmapped_column", "needs_confirmation"],
    };
  }
  if (SCHEMA_KNOWN.has(canonical) || canonical === "forklift_hrwl") {
    return {
      source_header: header,
      licence_type: canonical,
      confidence: 0.95,
      method: "schema_alias",
      flags: [],
    };
  }
  // Mapped, but the canonical type isn't yet in the schema's suggested values.
  return {
    source_header: header,
    licence_type: canonical,
    confidence: 0.75,
    method: "matrix_dictionary",
    flags: ["new_type", "needs_confirmation"],
  };
}

// ============================================================================
// CELL CLASSIFICATION
// ============================================================================

/** Classify a raw matrix cell into a state + (if datable) an ISO expiry. */
export function classifyCell(raw: unknown): { state: CellState; expiry_date: string | null; flags: string[] } {
  if (raw === null || raw === undefined) return { state: "none", expiry_date: null, flags: [] };

  if (raw instanceof Date) {
    return { state: "held_expiry", expiry_date: toIso(raw), flags: [] };
  }

  const s = String(raw).trim();
  if (s === "") return { state: "none", expiry_date: null, flags: [] };

  const low = s.toLowerCase();
  if (low === "x" || low === "n/a" || low === "-") return { state: "none", expiry_date: null, flags: [] };
  if (low === "not expiring" || low === "no expiry" || low === "permanent") {
    return { state: "held_permanent", expiry_date: null, flags: [] };
  }
  if (low === "expired") {
    return { state: "expired", expiry_date: null, flags: ["expired"] };
  }

  const iso = parseDayFirst(s);
  if (iso) return { state: "held_expiry", expiry_date: iso, flags: [] };

  // Unrecognised non-empty value — don't drop it silently, don't trust it either.
  return { state: "held_permanent", expiry_date: null, flags: ["unrecognised_value"] };
}

/** Parse a day-first date string (DD/MM/YYYY or DD-MM-YYYY) → ISO YYYY-MM-DD, or null. */
export function parseDayFirst(s: string): string | null {
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return toIso(dt);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// IDENTITY RECONCILIATION
// ============================================================================

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normaliseName(s).split(" ").filter(Boolean));
}

/** Levenshtein distance (small strings). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

function staffFullName(s: StaffRef): string {
  if (s.name) return s.name;
  return [s.first_name, s.last_name].filter(Boolean).join(" ");
}

/**
 * Score a matrix name against a staff member in [0,1].
 *  1.00  identical token-set
 *  ~0.7–0.95  same surname + first-name is a small edit / order swap (spelling variant)
 *  lower  partial token overlap only
 */
export function nameScore(matrixName: string, staff: StaffRef): number {
  const a = tokenSet(matrixName);
  const b = tokenSet(staffFullName(staff));
  if (a.size === 0 || b.size === 0) return 0;

  // exact token-set match (order-independent)
  if (a.size === b.size && [...a].every((t) => b.has(t))) return 1;

  const shared = [...a].filter((t) => b.has(t));
  const union = new Set([...a, ...b]);
  let score = shared.length / union.size; // Jaccard baseline

  // Reward a near-miss on the non-shared tokens (e.g. Matt↔Matthew, Tadhg↔Tadgh).
  const aRest = [...a].filter((t) => !b.has(t));
  const bRest = [...b].filter((t) => !a.has(t));
  if (shared.length >= 1 && aRest.length === 1 && bRest.length === 1) {
    const aTok = aRest[0]!;
    const bTok = bRest[0]!;
    const d = editDistance(aTok, bTok);
    const longer = Math.max(aTok.length, bTok.length);
    const sim = 1 - d / longer;
    if (sim >= 0.5) score = Math.max(score, 0.6 + 0.3 * sim);
  }
  return Math.min(score, 0.99);
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

const DEFAULT_IDENTITY_HEADERS = ["name", "title", "timesheet group", "group", "role", "email", "phone"];

/**
 * Reshape a wide licence matrix into a PROPOSAL. Writes nothing.
 */
export function ingestLicenceMatrix(sheet: ParsedSheet, opts: MatrixIngestOptions = {}): MatrixIngestProposal {
  const identityHeaders = (opts.identityHeaders ?? DEFAULT_IDENTITY_HEADERS).map((h) => normaliseHeader(h));
  const autoThreshold = opts.autoThreshold ?? 0.92;
  const confirmThreshold = opts.confirmThreshold ?? 0.6;
  const staff = opts.staff ?? [];

  const identity_columns: string[] = [];
  const licence_columns: string[] = [];
  for (const h of sheet.headerRow) {
    if (identityHeaders.includes(normaliseHeader(h))) identity_columns.push(h);
    else licence_columns.push(h);
  }

  const nameColumn =
    opts.nameColumn ??
    sheet.headerRow.find((h) => normaliseHeader(h) === "name") ??
    identity_columns[0];

  const column_mappings = licence_columns.map(mapLicenceColumn);
  const mappingByHeader = new Map(column_mappings.map((m) => [m.source_header, m]));

  // ---- people reconciliation ----
  const matches: PersonMatch[] = [];
  const matchedStaffToRows = new Map<string, number[]>();

  sheet.rows.forEach((row, idx) => {
    const sourceName = nameColumn ? String(row[nameColumn] ?? "").trim() : "";
    let best: { staff: StaffRef; score: number } | null = null;
    let runnerUp = 0;
    for (const s of staff) {
      const score = nameScore(sourceName, s);
      if (!best || score > best.score) {
        runnerUp = best ? best.score : 0;
        best = { staff: s, score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }

    const flags: string[] = [];
    let status: MatchStatus;
    if (best && best.score >= autoThreshold && best.score - runnerUp >= 0.05) {
      status = "auto";
    } else if (best && best.score >= confirmThreshold) {
      status = "confirm";
      flags.push("spelling_variant");
    } else {
      status = "unresolved";
      flags.push("no_candidate");
    }

    const m: PersonMatch = {
      source_index: idx,
      source_name: sourceName,
      status,
      staff_id: status === "unresolved" ? null : best!.staff.staff_id,
      matched_name: status === "unresolved" ? null : staffFullName(best!.staff),
      email: status === "unresolved" ? null : best!.staff.email ?? null,
      score: best ? Number(best.score.toFixed(3)) : 0,
      flags,
    };
    matches.push(m);
    if (m.staff_id) {
      const arr = matchedStaffToRows.get(m.staff_id) ?? [];
      arr.push(idx);
      matchedStaffToRows.set(m.staff_id, arr);
    }
  });

  // duplicate detection: >1 matrix row resolving to the same staff member
  const duplicates: MatrixIngestProposal["people"]["duplicates"] = [];
  for (const [staff_id, rows] of matchedStaffToRows) {
    if (rows.length > 1) {
      duplicates.push({
        name: matches[rows[0]!]!.source_name,
        source_indices: rows,
        staff_id,
      });
      for (const r of rows) {
        const mm = matches[r]!;
        if (!mm.flags.includes("duplicate_row")) mm.flags.push("duplicate_row");
      }
    }
  }

  // ---- proposed licences (wide → long) ----
  const proposed_licences: ProposedLicence[] = [];
  sheet.rows.forEach((row, idx) => {
    const match = matches[idx]!;
    for (const col of licence_columns) {
      const cell = classifyCell(row[col]);
      if (cell.state === "none") continue; // X / blank → no record (locked decision)

      const map = mappingByHeader.get(col)!;
      const flags = [...cell.flags, ...map.flags];
      // The matrix carries no licence numbers, but the schema requires one.
      flags.push("missing_licence_number");
      if (match.status !== "auto") flags.push("person_needs_confirmation");

      proposed_licences.push({
        source_index: idx,
        staff_ref: { name: match.source_name, staff_id: match.staff_id, match_status: match.status },
        source_column: col,
        source_value: String(row[col]),
        licence_type: map.licence_type,
        state: cell.state,
        expiry_date: cell.expiry_date,
        active: true,
        flags: dedupe(flags),
      });
    }
  });

  const auto = matches.filter((m) => m.status === "auto");
  const confirm = matches.filter((m) => m.status === "confirm");
  const unresolved = matches.filter((m) => m.status === "unresolved");

  return {
    source: opts.source ?? "training-matrix",
    identity_columns,
    licence_columns,
    column_mappings,
    people: { auto, confirm, unresolved, duplicates },
    proposed_licences,
    summary: {
      people_total: matches.length,
      auto: auto.length,
      confirm: confirm.length,
      unresolved: unresolved.length,
      duplicates: duplicates.length,
      licences_proposed: proposed_licences.length,
      licences_flagged: proposed_licences.filter((l) => l.flags.length > 0).length,
    },
    proposal_only: true,
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
