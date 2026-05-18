/**
 * SimPRO customer rollup — in-browser port of the Node script at
 * `demos/simpro-customer-rollup/rollup.mjs`.
 *
 * Takes three ParsedSheet results (one per role — customer / contact /
 * site) and joins them by SimPRO Customer ID, producing one row per
 * customer with sites + contacts as pipe-separated cells.
 *
 * Pure function. No DOM, no React, no AI. Same logic as the standalone
 * script so the output is identical.
 */

import type { ParsedSheet } from "@eq/intake";

export type RoleName = "customer" | "contact" | "site";

export interface RollupInputs {
  /** Map of role → parsed sheet. All three roles required. */
  sheets: Record<RoleName, ParsedSheet>;
  /** Separator placed between concatenated sites/contacts in a cell. Default '|'. */
  separator?: string;
}

export interface RollupResult {
  /** Header row in output order. */
  headers: string[];
  /** One row per customer, keyed by header. */
  rows: Record<string, string>[];
  /** Diagnostic counts the UI can surface to the user. */
  stats: {
    customers: number;
    contacts: number;
    sites: number;
    customersWithSite: number;
    customersWithContact: number;
    orphanSites: number;
    orphanContacts: number;
  };
}

const DEFAULT_SEPARATOR = " | ";

const OUTPUT_COLUMNS = [
  "simPRO Customer ID",
  "Company Name",
  "Customer Type",
  "ABN",
  "Street Address",
  "Suburb",
  "State",
  "Postcode",
  "Primary Phone",
  "Mobile Phone",
  "Email",
  "Website",
  "Customer Group",
  "Account Manager",
  "Default Quote Method",
  "Notes",
  "Create Date",
  "Site Count",
  "Sites",
  "Contact Count",
  "Contacts",
];

export function rollup(input: RollupInputs): RollupResult {
  const sep = input.separator ?? DEFAULT_SEPARATOR;
  const customers = input.sheets.customer.rows;
  const contacts = input.sheets.contact.rows;
  const sites = input.sheets.site.rows;

  const contactsByCustomer = groupBy(contacts, "simPRO Customer ID");
  const sitesByCustomer = groupBy(sites, "simPRO Customer ID");

  const knownCustomerIds = new Set(
    customers.map((c) => stringOf(c["simPRO Customer ID"])).filter((v) => v !== ""),
  );

  const outputRows: Record<string, string>[] = [];
  let customersWithSite = 0;
  let customersWithContact = 0;
  for (const c of customers) {
    const id = stringOf(c["simPRO Customer ID"]);
    const customerSites = sitesByCustomer.get(id) ?? [];
    const customerContacts = contactsByCustomer.get(id) ?? [];
    if (customerSites.length > 0) customersWithSite++;
    if (customerContacts.length > 0) customersWithContact++;

    outputRows.push({
      "simPRO Customer ID": id,
      "Company Name": stringOf(c["Company Name"]),
      "Customer Type": stringOf(c["Type"]),
      "ABN": stringOf(c["ABN"]),
      "Street Address": stringOf(c["Street Address"]),
      "Suburb": stringOf(c["Suburb"]),
      "State": stringOf(c["State"]),
      "Postcode": stringOf(c["Postcode"]),
      "Primary Phone": stringOf(c["Primary Phone"]),
      "Mobile Phone": stringOf(c["Mobile Phone"]),
      "Email": stringOf(c["Email"]),
      "Website": stringOf(c["Website"]),
      "Customer Group": stringOf(c["Customer Group"]),
      "Account Manager": stringOf(c["Account Manager"]),
      "Default Quote Method": stringOf(c["Default Quote Method"]),
      "Notes": stringOf(c["Notes"]),
      "Create Date": stringOf(c["Create Date"]),
      "Site Count": String(customerSites.length),
      "Sites": customerSites.map(formatSite).join(sep),
      "Contact Count": String(customerContacts.length),
      "Contacts": customerContacts.map(formatContact).join(sep),
    });
  }

  // Orphan counts — site/contact rows whose Customer ID isn't in the
  // customers file. Surface to the user; not an error, just intelligence.
  let orphanSites = 0;
  for (const s of sites) {
    const id = stringOf(s["simPRO Customer ID"]);
    if (id && !knownCustomerIds.has(id)) orphanSites++;
  }
  let orphanContacts = 0;
  for (const cc of contacts) {
    const id = stringOf(cc["simPRO Customer ID"]);
    if (id && !knownCustomerIds.has(id)) orphanContacts++;
  }

  return {
    headers: OUTPUT_COLUMNS,
    rows: outputRows,
    stats: {
      customers: customers.length,
      contacts: contacts.length,
      sites: sites.length,
      customersWithSite,
      customersWithContact,
      orphanSites,
      orphanContacts,
    },
  };
}

/**
 * Serialise a RollupResult to RFC-4180 CSV bytes (CRLF line endings).
 * Always quotes cells containing comma / quote / CRLF.
 */
export function rollupToCsv(result: RollupResult): string {
  const lines: string[] = [result.headers.map(csvEscape).join(",")];
  for (const row of result.rows) {
    lines.push(result.headers.map((h) => csvEscape(row[h] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ============================================================================
// HELPERS
// ============================================================================

function stringOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function groupBy(
  rows: Record<string, unknown>[],
  key: string,
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = stringOf(r[key]);
    if (!k) continue;
    let bucket = map.get(k);
    if (!bucket) {
      bucket = [];
      map.set(k, bucket);
    }
    bucket.push(r);
  }
  return map;
}

function formatContact(c: Record<string, unknown>): string {
  const name = [stringOf(c["Contact First Name"]), stringOf(c["Contact Last Name"])]
    .filter(Boolean)
    .join(" ")
    .trim();
  const email = stringOf(c["Contact Email"]).trim();
  const mobile = stringOf(c["Contact Mobile Phone"]).trim();
  const work = stringOf(c["Contact Work Phone"]).trim();
  const position = stringOf(c["Contact Position"]).trim();
  const head = position ? `${name} (${position})` : name;
  return [head, email, mobile || work].filter((p) => p && p !== "").join(" · ");
}

function formatSite(s: Record<string, unknown>): string {
  const name = stringOf(s["Site Name"]).trim();
  const addr = [
    stringOf(s["Street Address"]),
    stringOf(s["Suburb"]),
    stringOf(s["State"]),
    stringOf(s["Postcode"]),
  ]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
  if (name && addr && name.toLowerCase() !== addr.toLowerCase()) {
    return `${name} — ${addr}`;
  }
  return name || addr || "(site, no address)";
}

function csvEscape(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
