#!/usr/bin/env node
/**
 * Produces the EQ Quotes import CSV from the three SimPRO exports.
 *
 * Row-per-site. Each row carries the parent customer details + primary
 * contact denormalised, so EQ Quotes' import / picker can show site →
 * customer → contact relationships from a single flat file.
 *
 * Uses the same template logic that powers the in-browser demo's
 * SIMPRO_QUOTES_BY_SITE template, just runs it in Node against the real
 * files in C:\Projects\eq-intake\simpro\. Output written beside this
 * script.
 *
 * Mirrors `rollup.mjs` shape — pure Node ESM, no deps, RFC-4180 CSV
 * parser inline.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SIMPRO_DIR = "C:/Projects/eq-intake/simpro";

function autoDiscover(dir, prefix) {
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const matches = entries
    .filter((e) => e.toLowerCase().startsWith(prefix) && e.toLowerCase().endsWith(".csv"))
    .sort()
    .reverse();
  return matches[0] ? join(dir, matches[0]) : null;
}

const customersPath = autoDiscover(SIMPRO_DIR, "customer_export");
const contactsPath  = autoDiscover(SIMPRO_DIR, "customer_contacts_export");
const sitesPath     = autoDiscover(SIMPRO_DIR, "site_export");
const outPath       = join(__dirname, "eq-quotes-by-site.csv");

if (!customersPath || !contactsPath || !sitesPath) {
  console.error("Missing one or more SimPRO inputs in " + SIMPRO_DIR);
  process.exit(1);
}

console.log(`customers : ${customersPath}`);
console.log(`contacts  : ${contactsPath}`);
console.log(`sites     : ${sitesPath}`);
console.log(`out       : ${outPath}`);

// ============================================================================
// CSV (RFC-4180-ish)
// ============================================================================

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
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

const customers = parseCsv(readFileSync(customersPath, "utf8")).rows;
const contacts  = parseCsv(readFileSync(contactsPath,  "utf8")).rows;
const sites     = parseCsv(readFileSync(sitesPath,     "utf8")).rows;

console.log(`\nLoaded: ${customers.length} customers, ${contacts.length} contacts, ${sites.length} sites`);

// ============================================================================
// INDEX
// ============================================================================

const customerById = new Map();
for (const c of customers) {
  const id = String(c["simPRO Customer ID"] || "");
  if (id) customerById.set(id, c);
}

const contactsByCustomer = new Map();
for (const c of contacts) {
  const id = String(c["simPRO Customer ID"] || "");
  if (!id) continue;
  let bucket = contactsByCustomer.get(id);
  if (!bucket) { bucket = []; contactsByCustomer.set(id, bucket); }
  bucket.push(c);
}

// ============================================================================
// HELPERS (mirror template helpers in eq-intake-demo/src/rollup/template.ts)
// ============================================================================

function isTruthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "true" || t === "yes" || t === "y" || t === "1";
  }
  return false;
}

const QUOTE_RELEVANT_POSITIONS = [
  "procurement", "purchasing", "accounts", "project manager",
  "construction manager", "director", "owner", "operations", "estimating",
];

/**
 * Pick a primary contact for quoting. Fallback chain mirrors the in-browser
 * template engine — see templates.ts pickPrimaryContact for the full rationale.
 *   1. Explicit Is Default Quote Contact flag
 *   2. Contact whose Position matches a quoting-relevant title
 *   3. First contact whose name isn't the customer's Account Manager
 *   4. First contact in the file (final fallback)
 *
 * Returns { contact, certain }. certain=false means the name should be
 * suffixed with "(no default contact set)" so the quoter knows to verify.
 */
function pickPrimaryContact(contacts, customer) {
  if (contacts.length === 0) return { contact: undefined, certain: false, internalOnly: false };

  const am = String(customer["Account Manager"] || "").trim().toLowerCase();
  const isAm = (c) => {
    if (!am) return false;
    const full = [c["Contact First Name"], c["Contact Last Name"]]
      .filter(Boolean).join(" ").trim().toLowerCase();
    if (!full) return false;
    if (full === am) return true;
    if (full.includes(am) || am.includes(full)) return true;
    const aParts = full.split(/\s+/).filter(Boolean);
    const bParts = am.split(/\s+/).filter(Boolean);
    return (
      aParts.length > 0 && bParts.length > 0 &&
      aParts[0] === bParts[0] &&
      aParts[aParts.length - 1] === bParts[bParts.length - 1]
    );
  };
  const nonAm = contacts.filter((c) => !isAm(c));

  // 1a. Explicit flag on a NON-AM contact — certain
  const flaggedNonAm = nonAm.find((c) => isTruthy(c["Is Default Quote Contact"]));
  if (flaggedNonAm) return { contact: flaggedNonAm, certain: true, internalOnly: false };

  // 2. Quote-relevant position among non-AM
  const posMatch = nonAm.find((c) => {
    const pos = String(c["Contact Position"] || "").toLowerCase();
    return pos && QUOTE_RELEVANT_POSITIONS.some((t) => pos.includes(t));
  });
  if (posMatch) return { contact: posMatch, certain: false, internalOnly: false };

  // 3. First non-AM contact
  if (nonAm.length > 0) return { contact: nonAm[0], certain: false, internalOnly: false };

  // 4. Every contact matches the AM. Fall back, flag as internal-only.
  const flaggedAm = contacts.find((c) => isTruthy(c["Is Default Quote Contact"]));
  if (flaggedAm) return { contact: flaggedAm, certain: false, internalOnly: true };
  return { contact: contacts[0], certain: false, internalOnly: true };
}

function siteAddress(s) {
  return [s["Street Address"], s["Suburb"], s["State"], s["Postcode"]]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .join(", ");
}

function contactRollup(contacts) {
  return contacts.map((c) => {
    const name = [c["Contact First Name"], c["Contact Last Name"]].filter(Boolean).join(" ").trim();
    const email = String(c["Contact Email"] || "").trim();
    const mobile = String(c["Contact Mobile Phone"] || "").trim();
    const work = String(c["Contact Work Phone"] || "").trim();
    const position = String(c["Contact Position"] || "").trim();
    const head = position ? `${name} (${position})` : name;
    return [head, email, mobile || work].filter(Boolean).join(" · ");
  }).filter(Boolean).join(" | ");
}

// ============================================================================
// BUILD ROWS
// ============================================================================

const OUTPUT_COLUMNS = [
  "Site ID",
  "Site Name",
  "Site Address",
  "Customer ID",
  "Customer Name",
  "Customer Type",
  "Customer Group",
  "Account Manager",
  "Customer ABN",
  "Primary Contact Name",
  "Primary Contact Email",
  "Primary Contact Phone",
  "Primary Contact Position",
  "All Customer Contacts",
  "Customer Default Quote Method",
  "Customer Notes",
  "Currency",
  "Linked Customer IDs",
  "Linked Customer Names",
];

// SimPRO models a site as belonging to one OR MORE customers — the "simPRO
// Customer ID" cell may contain a comma-separated list like "31, 32, 208"
// (typical of data-centre tenants where multiple legal entities co-own a
// site). We treat the first listed ID as primary and surface the rest in
// the Linked Customer columns so the quoter can see all relationships.
function parseCustomerIds(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const outputRows = [];
let multiCustomerSplit = 0;
let orphanSurfaced = 0;
for (const s of sites) {
  const ids = parseCustomerIds(s["simPRO Customer ID"]);
  const customerId = ids[0] ?? "";
  const customer = customerId ? customerById.get(customerId) : undefined;
  if (!customer) {
    // No silent drops — emit the site with placeholder customer fields so
    // the row is still visible to the quoter, flagged in the Customer Name.
    orphanSurfaced++;
    outputRows.push({
      "Site ID":                       String(s["simPRO Site ID"] || ""),
      "Site Name":                     String(s["Site Name"] || ""),
      "Site Address":                  siteAddress(s),
      "Customer ID":                   customerId,
      "Customer Name":                 customerId
        ? `(orphan — references unknown customer ID ${customerId})`
        : "(orphan — site has no customer ID)",
      "Customer Type":                 "",
      "Customer Group":                "",
      "Account Manager":               "",
      "Customer ABN":                  "",
      "Primary Contact Name":          "",
      "Primary Contact Email":         "",
      "Primary Contact Phone":         "",
      "Primary Contact Position":      "",
      "All Customer Contacts":         "",
      "Customer Default Quote Method": "",
      "Customer Notes":                "",
      "Currency":                      "AUD",
      "Linked Customer IDs":           ids.slice(1).join(", "),
      "Linked Customer Names":         "",
    });
    continue;
  }
  if (ids.length > 1) multiCustomerSplit++;
  const linkedIds = ids.slice(1);
  const linkedNames = linkedIds
    .map((id) => {
      const c = customerById.get(id);
      return c ? String(c["Company Name"] || "").trim() : `(unknown ID ${id})`;
    })
    .filter(Boolean);
  const customerContacts = contactsByCustomer.get(customerId) ?? [];
  const pick = pickPrimaryContact(customerContacts, customer);
  const def = pick.contact;
  let primaryName = def
    ? [def["Contact First Name"], def["Contact Last Name"]].filter(Boolean).join(" ").trim()
    : "";
  if (primaryName && !pick.certain) {
    primaryName += pick.internalOnly
      ? " (matches your Account Manager — verify)"
      : " (no default contact set)";
  }
  const primaryPhone = def
    ? (String(def["Contact Mobile Phone"] || "").trim() || String(def["Contact Work Phone"] || "").trim())
    : "";

  outputRows.push({
    "Site ID":                       String(s["simPRO Site ID"] || ""),
    "Site Name":                     String(s["Site Name"] || ""),
    "Site Address":                  siteAddress(s),
    "Customer ID":                   customerId,
    "Customer Name":                 String(customer["Company Name"] || ""),
    "Customer Type":                 String(customer["Type"] || ""),
    "Customer Group":                String(customer["Customer Group"] || ""),
    "Account Manager":               String(customer["Account Manager"] || ""),
    "Customer ABN":                  String(customer["ABN"] || ""),
    "Primary Contact Name":          primaryName,
    "Primary Contact Email":         def ? String(def["Contact Email"] || "") : "",
    "Primary Contact Phone":         primaryPhone,
    "Primary Contact Position":      def ? String(def["Contact Position"] || "") : "",
    "All Customer Contacts":         contactRollup(customerContacts),
    "Customer Default Quote Method": String(customer["Default Quote Method"] || ""),
    "Customer Notes":                String(customer["Notes"] || ""),
    "Currency":                      String(customer["Currency"] || "") || "AUD",
    "Linked Customer IDs":           linkedIds.join(", "),
    "Linked Customer Names":         linkedNames.join(" | "),
  });
}

writeFileSync(outPath, emitCsv(OUTPUT_COLUMNS, outputRows), "utf8");

console.log(`\nWrote ${outputRows.length} site rows to ${basename(outPath)}`);
console.log(`  ${multiCustomerSplit} sites had multiple linked customers — first ID used as primary, others in Linked Customer columns`);
console.log(`  ${orphanSurfaced} orphan site rows surfaced with placeholder customer fields (primary customer ID not in customers file)`);
console.log(`\nOpen ${outPath} — ready for EQ Quotes' import logic.`);
