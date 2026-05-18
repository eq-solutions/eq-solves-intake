#!/usr/bin/env node
/**
 * EQ reshape-out demo: canonical register + annual schedule + visit
 * allocation → next month's per-site SOW spreadsheet.
 *
 * The pain this removes: a coordinator currently builds next month's SOW
 * by hand. They open the Master Asset Register, cross-reference the annual
 * PPM schedule to figure out which services are due in May, look up which
 * crews are assigned to which days, and write out a per-day-per-site
 * asset list with task tickboxes. For one client, that's an evening.
 * For thirty clients, that's a full-time coordinator role.
 *
 * Inputs (canonical shape):
 *   register.csv  — Master Asset Register (20 assets across 4 sites)
 *   schedule.csv  — Annual PPM Schedule (which services fall in which months)
 *   visits.csv    — May 2026 visit-day allocation (which crew goes when)
 *
 * Outputs:
 *   sow-asset-schedule.csv  — one row per (visit × asset × applicable task)
 *                             with tickbox columns the field tech fills in
 *   sow-summary-<site>.csv  — per-site summary form (one file per site visit)
 *
 * Pure Node ESM. No deps. Run:
 *   cd demos/reshape-out-ppm-sow
 *   node derive.mjs
 *
 * Generic placeholder names only — no real client identifiers.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// CSV helpers (same shape as demos/simpro-quote-781)
// -----------------------------------------------------------------------------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length > 0);
  const parseRow = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
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
    header.forEach((h, i) => { r[h] = (cells[i] ?? '').trim(); });
    return r;
  });
  return { header, rows };
}

function toCsv(header, rows) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(','));
  return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Service-type → applicable-task-types mapping. The canonical relationship
// between "what's scheduled" and "what gets ticked off on site." Real EQ
// would store this in a service_task_completion lookup table.
// -----------------------------------------------------------------------------
const TASKS_FOR_SERVICE = {
  '6 Monthly PPM': ['Annual DB Maint', 'MSB Maint', 'Thermo Test', 'RCD Time Test'],
  'Monthly Generator Run Start': ['Generator Run Start'],
  'Annual UPS Maintenance': ['UPS Maint'],
};

// Which task applies to which asset_type. A DB doesn't get an MSB Maint,
// a generator doesn't get an RCD time test, etc.
const TASK_APPLIES_TO = {
  'Annual DB Maint': (t) => t === 'Distribution Board' || t === 'UPS Distribution Board',
  'MSB Maint': (t) => t === 'Main Switchboard',
  'Thermo Test': (t) => t === 'Main Switchboard' || t === 'Distribution Board' || t === 'UPS Distribution Board',
  'RCD Time Test': (t) => t === 'Distribution Board' || t === 'UPS Distribution Board',
  'Generator Run Start': (t) => t === 'Generator',
  'UPS Maint': (t) => t === 'UPS Distribution Board',
};

// All possible task columns — used to render the SOW asset schedule with
// every task as a column, "—" where not applicable, empty checkbox where it is.
const ALL_TASKS = ['Annual DB Maint', 'MSB Maint', 'Thermo Test', 'RCD Time Test', 'Generator Run Start', 'UPS Maint'];

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
const register = parseCsv(await readFile(join(__dirname, 'register.csv'), 'utf8')).rows;
const schedule = parseCsv(await readFile(join(__dirname, 'schedule.csv'), 'utf8')).rows;
const visits = parseCsv(await readFile(join(__dirname, 'visits.csv'), 'utf8')).rows;

// Index assets by site
const assetsBySite = new Map();
for (const a of register) {
  const list = assetsBySite.get(a.site) ?? [];
  list.push(a);
  assetsBySite.set(a.site, list);
}

// Index schedule by (site, month)
const monthOf = (dateStr) => {
  // "Fri 1 May 2026" -> "2026-05"
  const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = dateStr.match(/(\w{3})\s+(\d{4})$/);
  if (!m) throw new Error(`Cannot parse month from "${dateStr}"`);
  return `${m[2]}-${monthMap[m[1]]}`;
};

const scheduleBySite = new Map();
for (const s of schedule) {
  const list = scheduleBySite.get(s.site) ?? [];
  list.push(s);
  scheduleBySite.set(s.site, list);
}

// -----------------------------------------------------------------------------
// Build the SOW Asset Schedule — one row per (visit × asset × applicable tasks)
// -----------------------------------------------------------------------------
const sowRows = [];
for (const v of visits) {
  const month = monthOf(v.date);
  const siteAssets = assetsBySite.get(v.site) ?? [];
  const siteSchedule = (scheduleBySite.get(v.site) ?? []).filter((s) => s.month === month);

  // Aggregate which task-types are due this site × month across all scheduled services
  const taskSet = new Set();
  for (const s of siteSchedule) {
    for (const t of TASKS_FOR_SERVICE[s.service_type] ?? []) taskSet.add(t);
  }

  for (const a of siteAssets) {
    // Filter to assets that have at least one applicable task this visit
    const applicableTasks = [...taskSet].filter((t) => TASK_APPLIES_TO[t]?.(a.asset_type));
    if (applicableTasks.length === 0) continue;

    const row = {
      date: v.date,
      site: v.site,
      region: a.region,
      crew: v.crew,
      crew_contact: v.crew_contact,
      asset_id: a.asset_id,
      asset_type: a.asset_type,
      asset_name: a.asset_name,
      make: a.make,
      model: a.model,
      circuits_qty: a.circuits_qty,
      location: a.location,
      defects_outstanding: a.defects_outstanding,
    };
    for (const t of ALL_TASKS) {
      row[t] = applicableTasks.includes(t) ? '☐' : '—';
    }
    row.tech_initials = '';
    row.notes = '';
    sowRows.push(row);
  }
}

const SOW_COLUMNS = [
  'date', 'site', 'region', 'crew', 'crew_contact',
  'asset_id', 'asset_type', 'asset_name', 'make', 'model', 'circuits_qty', 'location',
  ...ALL_TASKS,
  'defects_outstanding', 'tech_initials', 'notes',
];

await writeFile(join(__dirname, 'sow-asset-schedule.csv'), toCsv(SOW_COLUMNS, sowRows));

// -----------------------------------------------------------------------------
// Per-site SOW Summary forms (one file per visit). Header block + the day's
// scope; the field tech fills in completion + defects + signoff on site.
// -----------------------------------------------------------------------------
for (const v of visits) {
  const month = monthOf(v.date);
  const siteAssets = assetsBySite.get(v.site) ?? [];
  const siteSchedule = (scheduleBySite.get(v.site) ?? []).filter((s) => s.month === month);
  const taskSet = new Set();
  for (const s of siteSchedule) {
    for (const t of TASKS_FOR_SERVICE[s.service_type] ?? []) taskSet.add(t);
  }
  const assetCount = siteAssets.filter((a) =>
    [...taskSet].some((t) => TASK_APPLIES_TO[t]?.(a.asset_type)),
  ).length;
  const totalCircuits = siteAssets.reduce((sum, a) => sum + (parseInt(a.circuits_qty, 10) || 0), 0);

  const summaryLines = [
    `Site SOW Summary — ${v.site}`,
    ``,
    `Date,${v.date}`,
    `Site,${v.site}`,
    `Region,${siteAssets[0]?.region ?? ''}`,
    `Crew,${v.crew}`,
    `Crew contact,${v.crew_contact}`,
    `Assets in scope,${assetCount}`,
    `Total circuits,${totalCircuits}`,
    `Scheduled services,"${siteSchedule.map((s) => s.service_type).join('; ')}"`,
    ``,
    `Tasks to complete this visit:`,
    ...[...taskSet].map((t) => `,☐ ${t}`),
    ``,
    `Defects raised on site:`,
    `,`,
    `,`,
    ``,
    `Tech name,`,
    `Tech licence number,`,
    `Signoff (signature attached separately),`,
  ];
  await writeFile(
    join(__dirname, `sow-summary-${v.site.toLowerCase()}.csv`),
    summaryLines.join('\n') + '\n',
  );
}

// -----------------------------------------------------------------------------
// Console summary
// -----------------------------------------------------------------------------
console.log(`Read register: ${register.length} assets across ${assetsBySite.size} sites`);
console.log(`Read schedule: ${schedule.length} scheduled services`);
console.log(`Read visits:   ${visits.length} day allocations`);
console.log(``);
console.log(`Wrote sow-asset-schedule.csv: ${sowRows.length} task rows across ${visits.length} visits`);
console.log(`Wrote sow-summary-<site>.csv: ${visits.length} per-site summary forms`);
console.log(``);
console.log(`The bookkeeper would normally write this list by hand. Today: zero typing.`);
