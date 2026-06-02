/**
 * Emit tests — approved proposal → canonical write-records.
 *
 * Builds a small proposal via ingestLicenceMatrix, then asserts buildCanonicalRecords
 * stamps the ownership model, honours approvals, collapses duplicates, and never
 * writes a homeless (no-email) or unmapped record.
 */

import { describe, it, expect } from "vitest";
import { ingestLicenceMatrix, type StaffRef } from "../src/matrix.js";
import { buildCanonicalRecords, buildTenantRecords, pendingApprovals } from "../src/emit.js";
import type { ParsedSheet } from "../src/readers/csv.js";

const META = { encoding: "utf8", delimiter: ",", totalRows: 0, emptyRowsSkipped: 0, malformedRows: 0, malformed: [], bomDetected: false };

function sheet(headerRow: string[], rows: Record<string, unknown>[]): ParsedSheet {
  return { sheetName: "m", headerRow, rows, meta: { ...META, totalRows: rows.length } } as ParsedSheet;
}

const HEADERS = ["Name", "Title", "Construction Induction", "WAH", "Electrical Licence", "Other"];
const STAFF: StaffRef[] = [
  { staff_id: "s1", name: "James Patel", email: "james@x.com.au" },
  { staff_id: "s2", name: "Matthew Miller", email: "matt@x.com.au" },
  { staff_id: "s4", name: "Sarah O'Brien", email: "sarah@x.com.au" },
];

// James (auto), Matt↔Matthew (confirm), Sarah x2 (auto + duplicate), Nathan (unresolved)
const ROWS: Record<string, unknown>[] = [
  { Name: "James Patel", Title: "Tech", "Construction Induction": "Not Expiring", WAH: "24/07/2026", "Electrical Licence": "X", Other: "X" },
  { Name: "Matt Miller", Title: "Tech", "Construction Induction": "X", WAH: "X", "Electrical Licence": "12/09/2030", Other: "X" },
  { Name: "Sarah O'Brien", Title: "Office", "Construction Induction": "Not Expiring", WAH: "X", "Electrical Licence": "X", Other: "held-something" },
  { Name: "Sarah O'Brien", Title: "Office", "Construction Induction": "Not Expiring", WAH: "X", "Electrical Licence": "X", Other: "X" },
  { Name: "Nathan Ferris", Title: "Tech", "Construction Induction": "Not Expiring", WAH: "X", "Electrical Licence": "X", Other: "X" },
];

const OPTS = { tenantId: "tenant-sks", importedFrom: "Technology NSW Training Matrix.xlsx", importedAt: "2026-06-02T00:00:00.000Z" };

function proposal() {
  return ingestLicenceMatrix(sheet(HEADERS, ROWS), { source: "m", staff: STAFF });
}

describe("buildCanonicalRecords — ownership model", () => {
  it("stamps employer/asserted/unclaimed + holder_email + null licence_number", () => {
    const r = buildCanonicalRecords(proposal(), [], OPTS);
    expect(r.licences.length).toBeGreaterThan(0);
    for (const l of r.licences) {
      expect(l.asserted_by).toBe("employer");
      expect(l.verification_status).toBe("asserted");
      expect(l.claim_status).toBe("unclaimed");
      expect(l.licence_number).toBeNull();
      expect(l.holder_email).toBeTruthy();
      expect(l.source).toBe("matrix-import");
      expect(l.tenant_id).toBe("tenant-sks");
    }
  });

  it("creates one implied employer grant per holder", () => {
    const r = buildCanonicalRecords(proposal(), [], OPTS);
    for (const g of r.grants) {
      expect(g.status).toBe("implied");
      expect(g.granted_by).toBe("employer_assertion");
    }
    // unique holders among written licences == grant count
    const holders = new Set(r.licences.map((l) => l.holder_email!.toLowerCase()));
    expect(r.grants.length).toBe(holders.size);
  });
});

describe("buildCanonicalRecords — approvals gate", () => {
  it("auto rows are written; confirm/unresolved are withheld until approved", () => {
    const p = proposal();
    const r = buildCanonicalRecords(p, [], OPTS);
    // James (auto) written; Matt (confirm) + Nathan (unresolved) NOT written
    const holders = r.licences.map((l) => l.holder_email);
    expect(holders).toContain("james@x.com.au");
    expect(holders).not.toContain("matt@x.com.au"); // confirm, not approved
    // Nathan is unresolved (no email) — never written
    expect(r.summary.skipped_people).toBeGreaterThan(0);
  });

  it("approving a confirm row writes its licences with the confirmed staff link", () => {
    const p = proposal();
    const matt = p.people.confirm.find((m) => m.source_name === "Matt Miller")!;
    const r = buildCanonicalRecords(
      p,
      [{ source_index: matt.source_index, decision: "approve", staff_id: "s2", holder_email: "matt@x.com.au" }],
      OPTS,
    );
    const mattRec = r.licences.find((l) => l.holder_email === "matt@x.com.au");
    expect(mattRec).toBeDefined();
    expect(mattRec!.staff_id).toBe("s2");
    expect(mattRec!.licence_type).toBe("electrical_licence");
    expect(mattRec!.state).toBe("NSW"); // electrical is state-licensed
  });
});

describe("buildCanonicalRecords — dedupe & skips", () => {
  it("collapses the duplicate person to one record per licence_type", () => {
    const r = buildCanonicalRecords(proposal(), [], OPTS);
    const sarahWhiteCards = r.licences.filter(
      (l) => l.holder_email === "sarah@x.com.au" && l.licence_type === "white_card",
    );
    expect(sarahWhiteCards).toHaveLength(1); // two rows → one record
    expect(r.summary.collapsed_duplicates).toBeGreaterThanOrEqual(1);
  });

  it("never writes unmapped ('Other') columns", () => {
    const r = buildCanonicalRecords(proposal(), [], OPTS);
    expect(r.licences.every((l) => l.licence_type !== null)).toBe(true);
    expect(r.summary.skipped_unmapped).toBeGreaterThanOrEqual(1); // Sarah's "held-something" in Other
  });

  it("uses a holder-keyed upsert key for idempotency", () => {
    const r = buildCanonicalRecords(proposal(), [], OPTS);
    expect(r.upsert_key).toEqual(["tenant_id", "holder_email", "licence_type"]);
  });
});

describe("buildTenantRecords — review queue", () => {
  const TOPTS = { orgId: "org-sks", importedFrom: "matrix.xlsx", importedAt: "2026-06-02T00:00:00.000Z" };

  it("auto-matches arrive auto_approved; confirm/unresolved arrive pending_review", () => {
    const r = buildTenantRecords(proposal(), TOPTS);
    const james = r.licences.filter((l) => l.holder_email === "james@x.com.au");
    const matt = r.licences.filter((l) => l.holder_email === "matt@x.com.au");
    expect(james.every((l) => l.review_status === "auto_approved")).toBe(true);
    expect(matt.length).toBeGreaterThan(0);
    expect(matt.every((l) => l.review_status === "pending_review")).toBe(true); // confirm → review
    expect(r.summary.auto_approved).toBeGreaterThan(0);
    expect(r.summary.pending_review).toBeGreaterThan(0);
  });

  it("is org-scoped and stamps the ownership model", () => {
    const r = buildTenantRecords(proposal(), TOPTS);
    expect(r.upsert_key).toEqual(["org_id", "holder_email", "licence_type"]);
    for (const l of r.licences) {
      expect(l.org_id).toBe("org-sks");
      expect(l.asserted_by).toBe("employer");
      expect(l.licence_number).toBeNull();
      expect(l.person_id).toBeNull();
    }
  });

  it("excludes the no-email unresolved person and the unmapped column", () => {
    const r = buildTenantRecords(proposal(), TOPTS);
    expect(r.licences.some((l) => l.licence_type === null)).toBe(false);
    expect(r.licences.some((l) => l.holder_email === "")).toBe(false);
    expect(r.summary.skipped_unmapped).toBeGreaterThanOrEqual(1);
  });
});

describe("pendingApprovals", () => {
  it("lists confirm + unresolved as needing a decision, not the autos", () => {
    const { needsDecision } = pendingApprovals(proposal());
    const names = needsDecision.map((d) => d.name).sort();
    expect(names).toContain("Matt Miller"); // confirm
    expect(names).toContain("Nathan Ferris"); // unresolved
    expect(names).not.toContain("James Patel"); // auto
  });
});
