#!/usr/bin/env node
/**
 * SimPRO customer rollup — flattens three SimPRO exports
 * (customers, customer contacts, sites) into a single CSV with one row
 * per customer. Sites and contacts are concatenated into pipe-separated
 * lists inside cells.
 *
 * Output is a flat CSV that pastes cleanly into a SharePoint list. No
 * Graph API. No round-trip. No friction. Run it, open the file, paste.
 *
 * Usage:
 *   node rollup.mjs \
 *     --customers <path/to/customer_export.csv> \
 *     --contacts  <path/to/customer_contacts_export.csv> \
 *     --sites     <path/to/site_export.csv> \
 *     --out       <path/to/output.csv>
 *
 * All four flags are optional. Defaults expect SimPRO's standard
 * filenames in `C:\Projects\eq-intake\simpro\` and output beside this
 * script as `customer-rollup.csv`.
 *
 * Pure Node ESM, no npm deps. CSV parsing is RFC-4180 compliant for
 * the shapes SimPRO emits (quoted fields, embedded commas, doubled
 * quotes inside quoted fields, CRLF or LF line endings).
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// ARGS
// ============================================================================

function parseArgs() {
  const args = { customers: null, contacts: null, sites: null, out: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === "--customers") { args.customers = next; i++; }
    else if (a === "--contacts") { args.contacts = next; i++; }
    else if (a === "--sites") { args.sites = next; i++; }
    else if (a === "--out") { args.out = next; i++; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node rollup.mjs [--customers PATH] [--contacts PATH] [--sites PATH] [--out PATH]");
      process.exit(0);
    }
  }
  return args;
}

/**
 * If a flag wasn't given, look in C:\Projects\eq-intake\simpro\ for the
 * latest file matching SimPRO's naming convention:
 *   customer_export_*.csv, customer_contacts_export_*.csv, site_export_*.csv
 */
function autoDiscover(dir, prefix) {
  let entries;
  try { entries = readdirSync(dir); }
  catch { return null; }
  const matches = entries
    .filter((e) => e.toLowerCase().startsWith(prefix) && e.toLowerCase().endsWith(".csv"))
    .sort()
    .reverse();
  return matches[0] ? join(dir, matches[0]) : null;
}

const argv = parseArgs();
const SIMPRO_DIR = "C:/Projects/eq-intake/simpro";

const customersPath = argv.customers ?? autoDiscover(SIMPRO_DIR, "customer_export");
const contactsPath  = argv.contacts  ?? autoDiscover(SIMPRO_DIR, "customer_contacts_export");
const sitesPath     = argv.sites     ?? autoDiscover(SIMPRO_DIR, "site_export");
const outPath       = argv.out       ?? join(__dirname, "customer-rollup.csv");

if (!customersPath || !contactsPath || !sitesPath) {
  console.error("Missing one or more inputs. Pass --customers / --contacts / --sites, or drop SimPRO exports into:");
  console.error("  " + SIMPRO_DIR);
  process.exit(1);
}

console.log(`customers : ${customersPath}`);
console.log(`contacts  : ${contactsPath}`);
console.log(`sites     : ${sitesPath}`);
console.log(`out       : ${outPath}`);

// ============================================================================
// CSV
// ============================================================================

/**
 * RFC-4180-ish CSV parser. Returns array of row-objects keyed by header.
 *   - Quoted fields supported, with doubled "" → literal "
 *   - CRLF or LF line endings supported
 *   - First non-empty row is the header
 *   - Empty cells return as "" (not null), as SimPRO emits them
 */
function parseCsv(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue; // skip CR; LF triggers row commit
    if (ch === "\n") {
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  // Last field / row
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c) => c !== "")) rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).map((r) => {
    const o = {};
    for (let j = 0; j < headers.length; j++) o[headers[j]] = r[j] ?? "";
    return o;
  });
  return { headers, rows: dataRows };
}

/** Write a row array as a CSV line. RFC-4180 quoting. */
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function emitCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  // UTF-8 BOM so Excel doesn't open the file as Windows-1252 and mangle
  // every em-dash + curly quote + accented company name.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ============================================================================
// LOAD
// ============================================================================

const customersFile = parseCsv(readFileSync(customersPath, "utf8"));
const contactsFile  = parseCsv(readFileSync(contactsPath,  "utf8"));
const sitesFile     = parseCsv(readFileSync(sitesPath,     "utf8"));

console.log(`\nLoaded:`);
console.log(`  ${customersFile.rows.length.toString().padStart(5)} customers`);
console.log(`  ${contactsFile.rows.length.toString().padStart(5)} contacts`);
console.log(`  ${sitesFile.rows.length.toString().padStart(5)} sites`);

// ============================================================================
// INDEX
// ============================================================================

// Group contacts + sites by simPRO Customer ID for O(1) lookup per customer.
function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!k) continue;
    let bucket = map.get(k);
    if (!bucket) { bucket = []; map.set(k, bucket); }
    bucket.push(r);
  }
  return map;
}

// SimPRO sites can belong to multiple customers — the "simPRO Customer ID"
// cell may contain a comma-separated list like "176, 31, 208" (typical of
// data-centre tenants where multiple legal entities co-own a site). Parse
// it so the same site lands in every co-owning customer's bucket.
function parseCustomerIds(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const contactsByCustomer = groupBy(contactsFile.rows, "simPRO Customer ID");
const sitesByCustomer    = new Map();
for (const s of sitesFile.rows) {
  for (const id of parseCustomerIds(s["simPRO Customer ID"])) {
    let bucket = sitesByCustomer.get(id);
    if (!bucket) { bucket = []; sitesByCustomer.set(id, bucket); }
    bucket.push(s);
  }
}

// ============================================================================
// FLATTEN
// ============================================================================

/** Format a contact for the rolled-up "Contacts" cell. */
function formatContact(c) {
  const name = [c["Contact First Name"], c["Contact Last Name"]].filter(Boolean).join(" ").trim();
  const email = c["Contact Email"]?.trim();
  const mobile = c["Contact Mobile Phone"]?.trim();
  const work = c["Contact Work Phone"]?.trim();
  const position = c["Contact Position"]?.trim();
  const parts = [name];
  if (position) parts.push(`(${position})`);
  const contact = [
    parts.join(" "),
    email,
    mobile || work,
  ].filter(Boolean).join(" · ");
  return contact;
}

/** Format a site for the rolled-up "Sites" cell. */
function formatSite(s) {
  const name = s["Site Name"]?.trim();
  const addr = [s["Street Address"], s["Suburb"], s["State"], s["Postcode"]]
    .map((x) => x?.trim())
    .filter(Boolean)
    .join(", ");
  if (name && addr && name.toLowerCase() !== addr.toLowerCase()) {
    return `${name} — ${addr}`;
  }
  return name || addr || "(site, no address)";
}

const SEP = " | ";

// Columns chosen for a SharePoint quoting project — customer-level fields
// most useful for picking who to chase, plus the rollups. Drop columns
// you don't want by deleting them from this list.
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

const outputRows = [];
let withSites = 0;
let withContacts = 0;
for (const c of customersFile.rows) {
  const id = c["simPRO Customer ID"];
  const sites = sitesByCustomer.get(id) ?? [];
  const contacts = contactsByCustomer.get(id) ?? [];
  if (sites.length > 0) withSites++;
  if (contacts.length > 0) withContacts++;

  outputRows.push({
    "simPRO Customer ID": id,
    "Company Name":       c["Company Name"],
    "Customer Type":      c["Type"],
    "ABN":                c["ABN"],
    "Street Address":     c["Street Address"],
    "Suburb":             c["Suburb"],
    "State":              c["State"],
    "Postcode":           c["Postcode"],
    "Primary Phone":      c["Primary Phone"],
    "Mobile Phone":       c["Mobile Phone"],
    "Email":              c["Email"],
    "Website":            c["Website"],
    "Customer Group":     c["Customer Group"],
    "Account Manager":    c["Account Manager"],
    "Default Quote Method": c["Default Quote Method"],
    "Notes":              c["Notes"],
    "Create Date":        c["Create Date"],
    "Site Count":         sites.length,
    "Sites":              sites.map(formatSite).join(SEP),
    "Contact Count":      contacts.length,
    "Contacts":           contacts.map(formatContact).join(SEP),
  });
}

// Surface orphan sites in a synthetic row so they don't vanish from output.
// A site is orphan when none of its listed customer IDs match a customer row.
// We emit one "(Unassigned)" pseudo-customer at the end with every orphan site
// bundled in — the referenced ID is preserved in the Sites cell prefix so a
// human can chase it up.
const customerIdSetForOrphans = new Set(customersFile.rows.map((c) => c["simPRO Customer ID"]));
const orphanSiteRows = sitesFile.rows.filter((s) => {
  const ids = parseCustomerIds(s["simPRO Customer ID"]);
  return ids.length === 0 || !ids.some((id) => customerIdSetForOrphans.has(id));
});
if (orphanSiteRows.length > 0) {
  outputRows.push({
    "simPRO Customer ID": "(orphan)",
    "Company Name":       `(Unassigned — ${orphanSiteRows.length} sites reference missing customer IDs)`,
    "Customer Type":      "",
    "ABN":                "",
    "Street Address":     "",
    "Suburb":             "",
    "State":              "",
    "Postcode":           "",
    "Primary Phone":      "",
    "Mobile Phone":       "",
    "Email":              "",
    "Website":            "",
    "Customer Group":     "",
    "Account Manager":    "",
    "Default Quote Method": "",
    "Notes":              "Sites listed below reference customer IDs not present in the customers export — check if the customers file is filtered (e.g. active-only) and re-export.",
    "Create Date":        "",
    "Site Count":         orphanSiteRows.length,
    "Sites":              orphanSiteRows.map((s) => `[ref customer ID ${s["simPRO Customer ID"] || "(blank)"}] ${formatSite(s)}`).join(SEP),
    "Contact Count":      0,
    "Contacts":           "",
  });
}

// Surface orphan contacts the same way — contacts whose customer ID has no
// matching customer row are visible to the operator, not silently lost.
const orphanContactRows = contactsFile.rows.filter(
  (cc) => !customerIdSetForOrphans.has(cc["simPRO Customer ID"])
);
if (orphanContactRows.length > 0) {
  outputRows.push({
    "simPRO Customer ID": "(orphan)",
    "Company Name":       `(Unassigned — ${orphanContactRows.length} contacts reference missing customer IDs)`,
    "Customer Type":      "",
    "ABN":                "",
    "Street Address":     "",
    "Suburb":             "",
    "State":              "",
    "Postcode":           "",
    "Primary Phone":      "",
    "Mobile Phone":       "",
    "Email":              "",
    "Website":            "",
    "Customer Group":     "",
    "Account Manager":    "",
    "Default Quote Method": "",
    "Notes":              "Contacts listed below reference customer IDs not present in the customers export — check if the customers file is filtered (e.g. active-only) and re-export.",
    "Create Date":        "",
    "Site Count":         0,
    "Sites":              "",
    "Contact Count":      orphanContactRows.length,
    "Contacts":           orphanContactRows.map((cc) => `[ref customer ID ${cc["simPRO Customer ID"] || "(blank)"}] ${formatContact(cc)}`).join(SEP),
  });
}

// ============================================================================
// EMIT
// ============================================================================

const csv = emitCsv(OUTPUT_COLUMNS, outputRows);
writeFileSync(outPath, csv, "utf8");

const totalSites = sitesFile.rows.length;
const totalContacts = contactsFile.rows.length;
const customerIdSet = new Set(customersFile.rows.map((c) => c["simPRO Customer ID"]));
const orphanSites = sitesFile.rows.filter((s) => {
  const ids = parseCustomerIds(s["simPRO Customer ID"]);
  return ids.length === 0 || !ids.some((id) => customerIdSet.has(id));
}).length;
const orphanContacts = totalContacts - contactsFile.rows.filter((cc) => customersFile.rows.some((c) => c["simPRO Customer ID"] === cc["simPRO Customer ID"])).length;

console.log(`\nWrote ${outputRows.length} customer rows to ${basename(outPath)}`);
console.log(`  ${withSites} customers have at least one site`);
console.log(`  ${withContacts} customers have at least one contact`);
if (orphanSites > 0)    console.log(`  ⚠ ${orphanSites} site rows reference a customer ID not in customers file`);
if (orphanContacts > 0) console.log(`  ⚠ ${orphanContacts} contact rows reference a customer ID not in customers file`);
console.log(`\nOpen ${outPath} and paste the rows into your SharePoint list.`);
