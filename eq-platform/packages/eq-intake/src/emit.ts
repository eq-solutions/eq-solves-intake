/**
 * Emit — turn an APPROVED matrix proposal into canonical write-records.
 *
 * Stage 2 of the matrix pipeline. Stage 1 (matrix.ts) proposes; a human
 * reviews/approves; this stage materialises the approved rows into canonical
 * `licence` records (+ `licence_grant` entitlements) ready to upsert.
 *
 * Still no I/O — this is a pure builder. The DB apply (against a Supabase
 * branch, then promoted) is a thin separate step that takes EmitResult and
 * upserts it. Keeping the transform pure makes the whole thing unit-testable
 * and means the write step is dumb.
 *
 * Ownership model (baked in, per the employee-owned-credential decision):
 *   - holder_email is the portable identity anchor — ownership follows the
 *     person, not the employer that asserted the record.
 *   - matrix imports are stamped asserted_by=employer, verification=asserted,
 *     claim_status=unclaimed. The employee claims them in Cards later.
 *   - each holder gets an `implied` licence_grant for the importing tenant
 *     (employer-asserted entitlement, pre-consent).
 */

import type { MatrixIngestProposal, PersonMatch, MatchStatus } from "./matrix.js";

/** A per-person approval decision from the review step. */
export interface ApprovalDecision {
  source_index: number;
  /** "approve" writes the row's licences; "skip" drops them. */
  decision: "approve" | "skip";
  /** Confirmed staff link (required to approve a confirm/unresolved row). */
  staff_id?: string;
  /** Confirmed identity anchor. Falls back to the match's email if omitted. */
  holder_email?: string;
}

export interface EmitOptions {
  /** Owning tenant for the writes + the implied grants. */
  tenantId: string;
  /** Provenance label written to licence.imported_from. */
  importedFrom: string;
  /** ISO timestamp stamped on every record (passed in for determinism). */
  importedAt: string;
  /** Default state for state-licensed types when unknown. Default "NSW". */
  defaultState?: string;
  /**
   * Auto-approve rows the matcher bucketed as "auto" without an explicit
   * decision. Default true. confirm/unresolved ALWAYS need an explicit
   * approve decision — they're never written silently.
   */
  autoApproveAuto?: boolean;
}

/** A canonical `licence` row ready to upsert (shape mirrors licence.schema.json). */
export interface CanonicalLicence {
  tenant_id: string;
  staff_id: string | null;
  holder_email: string | null;
  licence_type: string;
  licence_number: null;
  state: string | null;
  expiry_date: string | null;
  asserted_by: "employer";
  verification_status: "asserted";
  claim_status: "unclaimed";
  active: boolean;
  source: string;
  imported_from: string;
  imported_at: string;
  notes: string | null;
}

/** A canonical `licence_grant` row ready to upsert. */
export interface CanonicalGrant {
  tenant_id: string;
  holder_email: string;
  status: "implied";
  granted_by: "employer_assertion";
  scope: "all_licences";
}

export interface EmitResult {
  licences: CanonicalLicence[];
  grants: CanonicalGrant[];
  /** Upsert key the apply step should use for idempotency. */
  upsert_key: string[];
  summary: {
    approved_people: number;
    licences: number;
    grants: number;
    skipped_people: number;
    skipped_unmapped: number;
    skipped_no_email: number;
    collapsed_duplicates: number;
  };
}

const STATE_LICENSED = new Set([
  "driver_licence",
  "forklift_hrwl",
  "electrical_licence",
  "boom_lift_hrwl",
  "dogging_hrwl",
]);

/**
 * Build canonical write-records from an approved proposal. Pure — no I/O.
 */
export function buildCanonicalRecords(
  proposal: MatrixIngestProposal,
  approvals: ApprovalDecision[],
  opts: EmitOptions,
): EmitResult {
  const autoApproveAuto = opts.autoApproveAuto ?? true;
  const defaultState = opts.defaultState ?? "NSW";

  // index every person match by source_index
  const matchByIndex = new Map<number, PersonMatch>();
  for (const m of [...proposal.people.auto, ...proposal.people.confirm, ...proposal.people.unresolved]) {
    matchByIndex.set(m.source_index, m);
  }

  const approvalByIndex = new Map<number, ApprovalDecision>();
  for (const a of approvals) approvalByIndex.set(a.source_index, a);

  // Resolve, per source_index, whether the person is approved + their identity.
  interface Resolved {
    approved: boolean;
    staff_id: string | null;
    holder_email: string | null;
  }
  const resolved = new Map<number, Resolved>();
  for (const [idx, match] of matchByIndex) {
    const decision = approvalByIndex.get(idx);
    let approved: boolean;
    if (decision) approved = decision.decision === "approve";
    else approved = autoApproveAuto && match.status === "auto";

    resolved.set(idx, {
      approved,
      staff_id: decision?.staff_id ?? match.staff_id,
      holder_email: decision?.holder_email ?? match.email,
    });
  }

  let skipped_unmapped = 0;
  let skipped_no_email = 0;
  const approvedPeople = new Set<number>();
  const skippedPeople = new Set<number>();

  // upsert key + a map to collapse duplicates (e.g. the matrix's two Costa rows)
  const seen = new Map<string, CanonicalLicence>();
  let collapsed = 0;

  for (const pl of proposal.proposed_licences) {
    const r = resolved.get(pl.source_index);
    if (!r || !r.approved) {
      skippedPeople.add(pl.source_index);
      continue;
    }
    if (pl.licence_type === null) {
      skipped_unmapped++;
      continue;
    }
    if (!r.holder_email) {
      // No identity anchor → can't own/port it. Don't write a homeless credential.
      skipped_no_email++;
      continue;
    }
    approvedPeople.add(pl.source_index);

    const rec: CanonicalLicence = {
      tenant_id: opts.tenantId,
      staff_id: r.staff_id,
      holder_email: r.holder_email,
      licence_type: pl.licence_type,
      licence_number: null,
      state: STATE_LICENSED.has(pl.licence_type) ? defaultState : null,
      expiry_date: pl.expiry_date,
      asserted_by: "employer",
      verification_status: "asserted",
      claim_status: "unclaimed",
      active: true,
      source: "matrix-import",
      imported_from: opts.importedFrom,
      imported_at: opts.importedAt,
      notes: pl.state === "expired" ? "Imported as Expired (no date on file)" : null,
    };

    const key = `${rec.tenant_id}::${rec.holder_email!.toLowerCase()}::${rec.licence_type}`;
    if (seen.has(key)) {
      collapsed++;
      // last write wins (keep the one with an expiry date if the other lacked one)
      const prev = seen.get(key)!;
      if (prev.expiry_date == null && rec.expiry_date != null) seen.set(key, rec);
      continue;
    }
    seen.set(key, rec);
  }

  const dedupedLicences = [...seen.values()];
  const grantHolders = new Set(dedupedLicences.map((l) => l.holder_email!.toLowerCase()));

  const grants: CanonicalGrant[] = [...grantHolders].map((email) => ({
    tenant_id: opts.tenantId,
    holder_email: email,
    status: "implied",
    granted_by: "employer_assertion",
    scope: "all_licences",
  }));

  return {
    licences: dedupedLicences,
    grants,
    upsert_key: ["tenant_id", "holder_email", "licence_type"],
    summary: {
      approved_people: approvedPeople.size,
      licences: dedupedLicences.length,
      grants: grants.length,
      skipped_people: skippedPeople.size,
      skipped_unmapped,
      skipped_no_email,
      collapsed_duplicates: collapsed,
    },
  };
}

/** A row for the Field TENANT licences table (org-scoped, carries review_status). */
export interface TenantLicence {
  org_id: string;
  person_id: null;
  holder_email: string;
  licence_type: string;
  licence_number: null;
  state: string | null;
  expiry_date: string | null;
  asserted_by: "employer";
  verification_status: "asserted";
  claim_status: "unclaimed";
  review_status: "auto_approved" | "pending_review";
  active: boolean;
  imported_from: string;
  imported_at: string;
  notes: string | null;
}

export interface TenantEmitOptions {
  orgId: string;
  importedFrom: string;
  importedAt: string;
  defaultState?: string;
}

export interface TenantEmitResult {
  licences: TenantLicence[];
  upsert_key: string[];
  summary: { auto_approved: number; pending_review: number; licences: number; skipped_unmapped: number; collapsed_duplicates: number };
}

/**
 * Build rows for the Field TENANT licences table — the review queue.
 *
 * Unlike buildCanonicalRecords (which withholds confirm/unresolved from the
 * source-of-record), this writes EVERY matched person so the tenant admin can
 * review them in Field: auto-matches arrive `auto_approved`; confirm/unresolved
 * arrive `pending_review`. Approved rows later flow to canonical. Pure — no I/O.
 */
export function buildTenantRecords(proposal: MatrixIngestProposal, opts: TenantEmitOptions): TenantEmitResult {
  const defaultState = opts.defaultState ?? "NSW";
  const matchByIndex = new Map<number, PersonMatch>();
  for (const m of [...proposal.people.auto, ...proposal.people.confirm, ...proposal.people.unresolved]) {
    matchByIndex.set(m.source_index, m);
  }

  const seen = new Map<string, TenantLicence>();
  let skipped_unmapped = 0;
  let collapsed = 0;

  for (const pl of proposal.proposed_licences) {
    const match = matchByIndex.get(pl.source_index);
    if (!match || !match.email) continue; // no identity anchor → not a tenant row yet
    if (pl.licence_type === null) {
      skipped_unmapped++;
      continue;
    }
    const review_status = match.status === "auto" ? "auto_approved" : "pending_review";
    const rec: TenantLicence = {
      org_id: opts.orgId,
      person_id: null,
      holder_email: match.email,
      licence_type: pl.licence_type,
      licence_number: null,
      state: STATE_LICENSED.has(pl.licence_type) ? defaultState : null,
      expiry_date: pl.expiry_date,
      asserted_by: "employer",
      verification_status: "asserted",
      claim_status: "unclaimed",
      review_status,
      active: true,
      imported_from: opts.importedFrom,
      imported_at: opts.importedAt,
      notes: pl.state === "expired" ? "Imported as Expired (no date on file)" : null,
    };
    const key = `${rec.org_id}::${rec.holder_email.toLowerCase()}::${rec.licence_type}`;
    if (seen.has(key)) {
      collapsed++;
      const prev = seen.get(key)!;
      // prefer the one that needs review (so a dup never silently auto-approves), then one with an expiry
      if (prev.review_status === "auto_approved" && rec.review_status === "pending_review") seen.set(key, rec);
      else if (prev.expiry_date == null && rec.expiry_date != null) seen.set(key, rec);
      continue;
    }
    seen.set(key, rec);
  }

  const licences = [...seen.values()];
  return {
    licences,
    upsert_key: ["org_id", "holder_email", "licence_type"],
    summary: {
      auto_approved: licences.filter((l) => l.review_status === "auto_approved").length,
      pending_review: licences.filter((l) => l.review_status === "pending_review").length,
      licences: licences.length,
      skipped_unmapped,
      collapsed_duplicates: collapsed,
    },
  };
}

/** Convenience: which buckets still need an explicit approval decision before emit. */
export function pendingApprovals(proposal: MatrixIngestProposal): {
  needsDecision: Array<{ source_index: number; name: string; status: MatchStatus; reason: string }>;
} {
  const needsDecision = [...proposal.people.confirm, ...proposal.people.unresolved].map((m) => ({
    source_index: m.source_index,
    name: m.source_name,
    status: m.status,
    reason: m.status === "confirm" ? "spelling variant — confirm the staff match" : "no candidate — link or skip",
  }));
  return { needsDecision };
}
