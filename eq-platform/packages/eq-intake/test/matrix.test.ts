/**
 * Training-matrix ingest tests.
 *
 * Builds a synthetic wide licence-matrix workbook programmatically (no binary
 * fixtures, no real personnel data) that reproduces every shape of mess the
 * real SKS NSW matrix contains:
 *   - a clean exact-match name        → auto
 *   - two spelling variants           → confirm   (Matt↔Matthew, Tadhg↔Tadgh)
 *   - the same person twice           → duplicate_row
 *   - a person absent from the roster → unresolved
 *   - all four cell states            → date / Not Expiring / Expired / X
 *
 * The proposal is asserted against hand-computed expectations — this file IS
 * the golden target. Nothing is written; ingestLicenceMatrix only proposes.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseXlsx } from "../src/readers/xlsx.js";
import {
  ingestLicenceMatrix,
  mapLicenceColumn,
  classifyCell,
  parseDayFirst,
  nameScore,
  type StaffRef,
} from "../src/matrix.js";

function buildXlsx(rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Matrix");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

const HEADERS = [
  "Name",
  "Title",
  "Timesheet Group",
  "Construction Induction",
  "WAH",
  "Electrical Licence",
  "HRL(Dogging)",
  "Open Cabling",
  "First Aid",
  "Other",
];

const ROWS: unknown[][] = [
  ["James Patel", "Tech", "Tech NSW", "Not Expiring", "24/07/2026", "X", "X", "Expired", "X", "X"],
  ["Matt Miller", "Tech", "Tech NSW", "X", "10/06/2028", "X", "X", "X", "Not Expiring", "X"],
  ["Tadhg Byrne", "Tech", "Tech NSW", "Not Expiring", "X", "X", "X", "X", "X", "X"],
  ["Sarah O'Brien", "Office", "Tech NSW", "Not Expiring", "X", "X", "X", "X", "X", "X"],
  ["Sarah O'Brien", "Office", "Tech NSW", "Not Expiring", "X", "X", "X", "X", "X", "X"],
  ["Nathan Ferris", "Tech", "Tech NSW", "X", "X", "12/09/2030", "X", "X", "X", "X"],
];

const STAFF: StaffRef[] = [
  { staff_id: "s1", name: "James Patel", email: "james.patel@example.com.au" },
  { staff_id: "s2", name: "Matthew Miller", email: "matthew.miller@example.com.au" },
  { staff_id: "s3", name: "Tadgh Byrne", email: "tadgh.byrne@example.com.au" },
  { staff_id: "s4", name: "Sarah O'Brien", email: "sarah.obrien@example.com.au" },
];

async function runProposal() {
  const buf = buildXlsx([HEADERS, ...ROWS]);
  const wb = await parseXlsx(buf);
  return ingestLicenceMatrix(wb.sheets[0]!, { source: "test-matrix.xlsx", staff: STAFF });
}

describe("ingestLicenceMatrix — people reconciliation", () => {
  it("buckets names into auto / confirm / unresolved with a duplicate flagged", async () => {
    const p = await runProposal();
    expect(p.summary.people_total).toBe(6);
    expect(p.summary.auto).toBe(3); // James + Sarah x2
    expect(p.summary.confirm).toBe(2); // Matt↔Matthew, Tadhg↔Tadgh
    expect(p.summary.unresolved).toBe(1); // Nathan absent
    expect(p.summary.duplicates).toBe(1); // Sarah twice → s4
  });

  it("flags the duplicate rows but still matches them", async () => {
    const p = await runProposal();
    const dup = p.people.duplicates[0]!;
    expect(dup.staff_id).toBe("s4");
    expect(dup.source_indices).toEqual([3, 4]);
    for (const m of p.people.auto.filter((x) => x.staff_id === "s4")) {
      expect(m.flags).toContain("duplicate_row");
    }
  });

  it("surfaces spelling variants as confirm — never a silent merge", async () => {
    const p = await runProposal();
    const names = p.people.confirm.map((m) => m.source_name).sort();
    expect(names).toEqual(["Matt Miller", "Tadhg Byrne"]);
    for (const m of p.people.confirm) {
      expect(m.flags).toContain("spelling_variant");
      expect(m.score).toBeGreaterThanOrEqual(0.6);
      expect(m.score).toBeLessThan(0.92);
    }
  });

  it("leaves an absent person unresolved with no staff_id", async () => {
    const p = await runProposal();
    const u = p.people.unresolved[0]!;
    expect(u.source_name).toBe("Nathan Ferris");
    expect(u.staff_id).toBeNull();
    expect(u.flags).toContain("no_candidate");
  });
});

describe("ingestLicenceMatrix — column mapping", () => {
  it("maps schema-known types confidently and proposes new types for confirmation", async () => {
    const p = await runProposal();
    const by = (h: string) => p.column_mappings.find((m) => m.source_header === h)!;

    expect(by("Construction Induction")).toMatchObject({ licence_type: "white_card", method: "schema_alias" });
    expect(by("WAH")).toMatchObject({ licence_type: "working_at_heights", method: "schema_alias" });
    expect(by("Electrical Licence")).toMatchObject({ licence_type: "electrical_licence", method: "schema_alias" });
    expect(by("First Aid")).toMatchObject({ licence_type: "first_aid", method: "schema_alias" });

    const dogging = by("HRL(Dogging)");
    expect(dogging.licence_type).toBe("dogging_hrwl");
    expect(dogging.method).toBe("matrix_dictionary");
    expect(dogging.flags).toContain("new_type");

    const other = by("Other");
    expect(other.licence_type).toBeNull();
    expect(other.method).toBe("unmapped");
    expect(other.flags).toContain("unmapped_column");
  });

  it("treats identity columns as identity, not licences", async () => {
    const p = await runProposal();
    expect(p.identity_columns).toEqual(["Name", "Title", "Timesheet Group"]);
    expect(p.licence_columns).not.toContain("Name");
  });
});

describe("ingestLicenceMatrix — proposed licences (wide → long)", () => {
  it("emits one record per HELD cell and nothing for X / blank", async () => {
    const p = await runProposal();
    expect(p.summary.licences_proposed).toBe(9);
    // James's 'X' cells (Electrical, Dogging, First Aid, Other) produced nothing
    const jamesElectrical = p.proposed_licences.find(
      (l) => l.source_index === 0 && l.source_column === "Electrical Licence",
    );
    expect(jamesElectrical).toBeUndefined();
  });

  it("classifies the four cell states correctly for the clean row", async () => {
    const p = await runProposal();
    const james = p.proposed_licences.filter((l) => l.source_index === 0);
    const ci = james.find((l) => l.source_column === "Construction Induction")!;
    const wah = james.find((l) => l.source_column === "WAH")!;
    const cabling = james.find((l) => l.source_column === "Open Cabling")!;

    expect(ci.state).toBe("held_permanent");
    expect(ci.expiry_date).toBeNull();

    expect(wah.state).toBe("held_expiry");
    expect(wah.expiry_date).toBe("2026-07-24"); // day-first parse

    expect(cabling.state).toBe("expired");
    expect(cabling.flags).toContain("expired");
  });

  it("flags EVERY proposed record as missing_licence_number (matrix carries none)", async () => {
    const p = await runProposal();
    for (const l of p.proposed_licences) {
      expect(l.flags).toContain("missing_licence_number");
    }
  });

  it("propagates person uncertainty onto the licence records", async () => {
    const p = await runProposal();
    const nathan = p.proposed_licences.find((l) => l.source_index === 5)!;
    expect(nathan.staff_ref.staff_id).toBeNull();
    expect(nathan.staff_ref.match_status).toBe("unresolved");
    expect(nathan.flags).toContain("person_needs_confirmation");
  });

  it("never writes — it only proposes", async () => {
    const p = await runProposal();
    expect(p.proposal_only).toBe(true);
  });
});

describe("unit: pure helpers", () => {
  it("classifyCell decodes the matrix vocabulary", () => {
    expect(classifyCell("X").state).toBe("none");
    expect(classifyCell(null).state).toBe("none");
    expect(classifyCell("Not Expiring").state).toBe("held_permanent");
    expect(classifyCell("Expired").state).toBe("expired");
    expect(classifyCell("21/08/2030")).toMatchObject({ state: "held_expiry", expiry_date: "2030-08-21" });
  });

  it("parseDayFirst is day-first and rejects junk", () => {
    expect(parseDayFirst("06/01/2031")).toBe("2031-01-06");
    expect(parseDayFirst("31/12/2025")).toBe("2025-12-31");
    expect(parseDayFirst("13/13/2025")).toBeNull(); // invalid month
    expect(parseDayFirst("not a date")).toBeNull();
  });

  it("mapLicenceColumn resolves abbreviations", () => {
    expect(mapLicenceColumn("WAH").licence_type).toBe("working_at_heights");
    expect(mapLicenceColumn("HRL(Forklift)").licence_type).toBe("forklift_hrwl");
    expect(mapLicenceColumn("Silica Awareness").licence_type).toBe("silica_awareness");
    expect(mapLicenceColumn("Gibberish").method).toBe("unmapped");
  });

  it("nameScore: exact = 1, spelling variant in confirm band, stranger low", () => {
    expect(nameScore("James Patel", { staff_id: "x", name: "James Patel" })).toBe(1);
    const variant = nameScore("Matt Miller", { staff_id: "x", name: "Matthew Miller" });
    expect(variant).toBeGreaterThanOrEqual(0.6);
    expect(variant).toBeLessThan(0.92);
    expect(nameScore("Nathan Ferris", { staff_id: "x", name: "James Patel" })).toBeLessThan(0.3);
  });
});
