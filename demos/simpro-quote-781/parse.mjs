#!/usr/bin/env node
/**
 * SimPRO quote -> EQ canonical demo.
 *
 * Reads source.csv (a SimPRO quote export), classifies rows by Item Type,
 * emits three artefacts that map to canonical entities + derived export
 * profiles per EQ-AS-CONDUIT:
 *
 *   - bom.csv                    (procurement-ready material list)
 *   - knx-device-register.csv    (commissioning placeholder, one row per
 *                                 addressed KNX device)
 *   - labour-summary.csv         (hours by section + cost centre)
 *
 * No external deps. ESM. Run from the demo folder:
 *
 *   cd demos/simpro-quote-781
 *   node parse.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, "source.csv");

// -----------------------------------------------------------------------------
// CSV parser - small, handles double-quoted fields with embedded commas.
// SimPRO exports the Cost Centre Subtotal column with thousands separators
// inside quotes (e.g. "2,368.73") so we can't use a naive comma split.
// -----------------------------------------------------------------------------
function parseCsv(text) {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  const parseRow = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQ = false; }
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const header = parseRow(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = parseRow(line);
    const r = {};
    header.forEach((h, i) => { r[h] = (cells[i] ?? "").trim(); });
    return r;
  });
  return { header, rows };
}

const num = (s) => {
  if (s == null || s === "") return 0;
  return Number(String(s).replace(/[$,\s]/g, "")) || 0;
};

// -----------------------------------------------------------------------------
// CSV writer
// -----------------------------------------------------------------------------
function toCsv(header, rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// KNX heuristic - which line items represent addressed KNX devices
// -----------------------------------------------------------------------------
const KNX_TERMS = [
  /\bactuator\b/i,
  /\bdimmer\b/i,
  /\bsensor\b/i,
  /\bbinary\s*input\b/i,
  /\bpresence\b/i,
  /\bthermostat\b/i,
  /\btouch\s*panel\b/i,
  /\bIP\s*router\b/i,
  /\bline\s*coupler\b/i,
  /\bpower\s*supply\b/i, // KNX bus PS, not always present in this export
];
const isKnxDevice = (description, costCentre) => {
  const haystack = (description + " " + costCentre).toLowerCase();
  if (haystack.includes("knx")) return true;
  return KNX_TERMS.some((re) => re.test(haystack));
};

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
const raw = await readFile(SOURCE, "utf8");
const { rows } = parseCsv(raw);

// Classify each row.
const materials = [];
const labour = [];
for (const r of rows) {
  const itemType = r["Item Type"];
  if (itemType === "Labour") labour.push(r);
  else if (itemType === "One off Item" || itemType === "Prebuild") materials.push(r);
}

// ---- BOM ----
// Group materials by (Section, Cost Centre, Description, Part Number).
// Quantity is summed; sell prices preserved as the unit price (assume
// uniform within a cost-centre line which is true for this export shape).
const bomKey = (m) => `${m["Section Name"]}|${m["Cost Centre Name"]}|${m["Part Description"]}|${m["Part Number"]}`;
const bomGroups = new Map();
for (const m of materials) {
  const k = bomKey(m);
  const qty = num(m["Quantity"]);
  const unitSell = num(m["Item Sell Price"]);
  const unitCost = num(m["Material Unit Cost Price"]);
  const existing = bomGroups.get(k);
  if (existing) {
    existing.quantity += qty;
    existing.total_cost += qty * unitCost;
    existing.total_sell += qty * unitSell;
  } else {
    bomGroups.set(k, {
      section: m["Section Name"],
      cost_centre: m["Cost Centre Name"],
      part_number: m["Part Number"] || "",
      description: m["Part Description"],
      uom: m["Unit Of Measurement"] || "ea",
      quantity: qty,
      unit_cost: unitCost,
      unit_sell: unitSell,
      total_cost: qty * unitCost,
      total_sell: qty * unitSell,
    });
  }
}
const bom = [...bomGroups.values()].sort((a, b) =>
  (a.section + a.cost_centre).localeCompare(b.section + b.cost_centre),
);
const bomCsv = toCsv(
  ["section","cost_centre","part_number","description","uom","quantity","unit_cost","unit_sell","total_cost","total_sell"],
  bom.map((r) => ({
    ...r,
    unit_cost: r.unit_cost.toFixed(2),
    unit_sell: r.unit_sell.toFixed(2),
    total_cost: r.total_cost.toFixed(2),
    total_sell: r.total_sell.toFixed(2),
  })),
);
await writeFile(join(__dirname, "bom.csv"), bomCsv);

// ---- KNX device register ----
// Expand each KNX-device material into one row per individual device with
// placeholder commissioning fields. Auto-suggest physical addresses 1.1.x.
const knxRegisterRows = [];
let physCounter = 1;
for (const m of materials) {
  if (!isKnxDevice(m["Part Description"], m["Cost Centre Name"])) continue;
  const qty = Math.max(1, Math.round(num(m["Quantity"])));
  for (let i = 0; i < qty; i++) {
    knxRegisterRows.push({
      device_id: `D-${String(physCounter).padStart(3, "0")}`,
      description: m["Part Description"],
      part_number: m["Part Number"] || "",
      section: m["Section Name"],
      cost_centre: m["Cost Centre Name"],
      physical_address: `1.1.${physCounter}`,
      group_address_main: "",
      group_address_middle: "",
      group_address_sub: "",
      function: "",
      programmed: "",
      tested_by: "",
      tested_date: "",
      status: "pending",
      notes: "",
    });
    physCounter++;
  }
}
const knxCsv = toCsv(
  ["device_id","description","part_number","section","cost_centre","physical_address","group_address_main","group_address_middle","group_address_sub","function","programmed","tested_by","tested_date","status","notes"],
  knxRegisterRows,
);
await writeFile(join(__dirname, "knx-device-register.csv"), knxCsv);

// ---- Labour summary ----
const labourSum = labour.map((l) => ({
  section: l["Section Name"],
  cost_centre: l["Cost Centre Name"],
  description: l["Part Description"],
  hours: num(l["Time (hrs)"]),
  unit_cost: num(l["Labour Unit Cost Price"]).toFixed(2),
  unit_sell: num(l["Labour Unit Sell Price"]).toFixed(2),
  line_total: num(l["Item Sell Price inc. Adjustments"]) * num(l["Time (hrs)"]),
}));
// Compute totals + rate-friendly view
const labourRows = labourSum
  .filter((l) => l.hours > 0 || num(l.unit_sell) > 0)
  .map((l) => ({ ...l, line_total: l.line_total.toFixed(2) }));
const labourCsv = toCsv(
  ["section","cost_centre","description","hours","unit_cost","unit_sell","line_total"],
  labourRows,
);
await writeFile(join(__dirname, "labour-summary.csv"), labourCsv);

// ---- Console summary ----
const totalSell = bom.reduce((s, r) => s + r.total_sell, 0)
  + labourSum.reduce((s, l) => s + (num(l.unit_sell) * l.hours), 0);

console.log(`Parsed ${rows.length} rows from source.csv`);
console.log(`  - ${materials.length} material lines`);
console.log(`  - ${labour.length} labour lines`);
console.log(``);
console.log(`Wrote bom.csv:                    ${bom.length} grouped material rows`);
console.log(`Wrote knx-device-register.csv:    ${knxRegisterRows.length} individual KNX devices (placeholder commissioning data)`);
console.log(`Wrote labour-summary.csv:         ${labourRows.length} labour entries`);
console.log(``);
console.log(`Quote total (sell, excl tax):     $${totalSell.toFixed(2)}`);
