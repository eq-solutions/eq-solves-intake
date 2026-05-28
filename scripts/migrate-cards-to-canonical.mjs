#!/usr/bin/env node
/**
 * migrate-cards-to-canonical.mjs
 *
 * One-shot migration: reads worker records from the Cards Supabase (the
 * shared pool, `sks-canonical-eq`) and writes them into the per-tenant
 * canonical Supabase as staff + licence rows.
 *
 * Run this ONCE after sks-canonical-eq is provisioned and the first batch
 * of worker onboarding data has come in through EQ Cards.
 *
 * ── Prereqs ─────────────────────────────────────────────────────────────────
 *   1. sks-canonical-eq Supabase must exist and have the Cards schema.
 *   2. The target tenant Supabase must have run sql/001–028 migrations.
 *   3. Both SUPABASE_URL/KEY vars must be set (see below).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/migrate-cards-to-canonical.mjs \
 *     --cards-url   https://xxxx.supabase.co \
 *     --cards-key   eyJ... \
 *     --target-url  https://yyyy.supabase.co \
 *     --target-key  eyJ... \
 *     --tenant-id   00000000-0000-4000-8000-000000000001 \
 *     [--dry-run]
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *   1. Reads workers from cards Supabase (table: workers).
 *   2. Reads worker_licences from cards Supabase (table: worker_licences).
 *   3. Upserts staff rows into target canonical (via eq_commit_batch RPC).
 *   4. Upserts licence rows into target canonical (via eq_commit_batch RPC).
 *   5. Prints a summary: committed / flagged / rejected per entity.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *   Safe to run multiple times. The canonical commit uses ON CONFLICT
 *   (tenant_id, external_id) — re-running just updates changed fields.
 *
 * ── Column mapping ────────────────────────────────────────────────────────────
 *   Cards worker → canonical staff:
 *     worker.id               → external_id
 *     worker.given_name       → first_name
 *     worker.family_name      → last_name
 *     worker.email            → email
 *     worker.phone            → phone
 *     worker.trade_type       → trade_type
 *     worker.abn              → abn
 *     worker.status           → employment_status (active/inactive)
 *     worker.created_at       → (sourced_at metadata)
 *
 *   Cards worker_licence → canonical licence:
 *     licence.id              → external_id
 *     licence.worker_id       → staff_external_id (resolved to staff_id FK)
 *     licence.licence_type    → licence_type
 *     licence.licence_number  → licence_number
 *     licence.state           → state
 *     licence.expires_at      → expiry_date
 *     licence.verified        → verified
 */

import { createClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

// ── Arg parsing ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "cards-url":  { type: "string" },
    "cards-key":  { type: "string" },
    "target-url": { type: "string" },
    "target-key": { type: "string" },
    "tenant-id":  { type: "string" },
    "dry-run":    { type: "boolean", default: false },
    "batch-size": { type: "string", default: "500" },
  },
});

const cardsUrl   = args["cards-url"]  ?? process.env.CARDS_SUPABASE_URL;
const cardsKey   = args["cards-key"]  ?? process.env.CARDS_SUPABASE_KEY;
const targetUrl  = args["target-url"] ?? process.env.TARGET_SUPABASE_URL;
const targetKey  = args["target-key"] ?? process.env.TARGET_SUPABASE_KEY;
const tenantId   = args["tenant-id"]  ?? process.env.TARGET_TENANT_ID;
const dryRun     = args["dry-run"];
const batchSize  = parseInt(args["batch-size"] ?? "500", 10);

if (!cardsUrl || !cardsKey || !targetUrl || !targetKey || !tenantId) {
  console.error(`
migrate-cards-to-canonical: missing required arguments.

Required:
  --cards-url   URL of the Cards Supabase (or CARDS_SUPABASE_URL env var)
  --cards-key   Service-role key for Cards Supabase
  --target-url  URL of the target tenant Supabase
  --target-key  Service-role key for target Supabase
  --tenant-id   UUID of the target tenant

Optional:
  --dry-run     Print what would be committed without writing anything
  --batch-size  Rows per RPC call (default: 500)
`);
  process.exit(1);
}

// ── Clients ──────────────────────────────────────────────────────────────────

const cards  = createClient(cardsUrl,  cardsKey,  { auth: { persistSession: false } });
const target = createClient(targetUrl, targetKey, { auth: { persistSession: false } });

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function logErr(msg) {
  process.stderr.write(`[${new Date().toISOString()}] ERROR: ${msg}\n`);
}

async function fetchAll(client, table, columns = "*") {
  const allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return allRows;
}

async function commitBatch(entity, rows) {
  if (dryRun) {
    log(`[dry-run] Would commit ${rows.length} ${entity} rows`);
    return { committed_count: rows.length, rejected_rows: [], flagged_rows: [] };
  }

  // Chunk into batchSize to match the chunked commit logic in commit-canonical.ts.
  let totalCommitted = 0;
  const allRejected = [];
  const allFlagged = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { data, error } = await target.rpc("eq_commit_batch", {
      p_entity:    entity,
      p_tenant_id: tenantId,
      p_rows:      chunk,
      p_source:    "migrate-cards-to-canonical",
    });
    if (error) {
      logErr(`${entity} chunk ${i}–${i + chunk.length}: ${error.message}`);
      // Record all rows in this chunk as rejected rather than aborting entirely.
      for (let ri = 0; ri < chunk.length; ri++) {
        allRejected.push({ source_row_index: i + ri, reasons: [error.message] });
      }
      continue;
    }
    const result = Array.isArray(data) ? data[0] : data;
    totalCommitted += result?.committed_count ?? 0;
    if (result?.rejected_rows) allRejected.push(...result.rejected_rows);
    if (result?.flagged_rows)  allFlagged.push(...result.flagged_rows);
  }

  return {
    committed_count: totalCommitted,
    rejected_rows:   allRejected,
    flagged_rows:    allFlagged,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`migrate-cards-to-canonical — tenant: ${tenantId}${dryRun ? " [DRY RUN]" : ""}`);

  // ── 1. Read Cards data ────────────────────────────────────────────────────
  log("Reading workers from Cards Supabase…");
  const workers = await fetchAll(cards, "workers");
  log(`  ${workers.length} workers found`);

  log("Reading worker_licences from Cards Supabase…");
  const licences = await fetchAll(cards, "worker_licences");
  log(`  ${licences.length} licences found`);

  // ── 2. Map workers → canonical staff rows ────────────────────────────────
  const staffRows = workers.map((w) => ({
    external_id:        str(w.id),
    first_name:         str(w.given_name)   || str(w.first_name),
    last_name:          str(w.family_name)  || str(w.last_name),
    email:              str(w.email),
    phone:              str(w.phone)        || str(w.mobile),
    trade_type:         str(w.trade_type)   || str(w.trade),
    abn:                str(w.abn),
    employment_status:  str(w.status) === "inactive" ? "inactive" : "active",
    // Cards doesn't have these yet — leave blank rather than guessing.
    job_title:          str(w.job_title),
    emergency_contact_name:  str(w.emergency_contact_name),
    emergency_contact_phone: str(w.emergency_contact_phone),
  }));

  // ── 3. Map worker_licences → canonical licence rows ────────────────────────
  const licenceRows = licences.map((l) => ({
    external_id:          str(l.id),
    staff_external_id:    str(l.worker_id),  // resolved to FK in the RPC
    licence_type:         str(l.licence_type) || str(l.type),
    licence_number:       str(l.licence_number) || str(l.number),
    state:                str(l.state),
    expiry_date:          str(l.expires_at)  || str(l.expiry_date),
    verified:             l.verified === true,
    issuing_body:         str(l.issuing_body) || str(l.authority),
    notes:                str(l.notes),
  }));

  // ── 4. Commit staff ───────────────────────────────────────────────────────
  log(`Committing ${staffRows.length} staff rows…`);
  const staffResult = await commitBatch("staff", staffRows);
  log(`  ✓ staff: ${staffResult.committed_count} committed, ${staffResult.rejected_rows.length} rejected, ${staffResult.flagged_rows.length} flagged`);

  if (staffResult.rejected_rows.length > 0) {
    log("  Rejected staff (first 5):");
    for (const r of staffResult.rejected_rows.slice(0, 5)) {
      log(`    Row ${r.source_row_index}: ${r.reasons.join("; ")}`);
    }
  }

  // ── 5. Commit licences ────────────────────────────────────────────────────
  log(`Committing ${licenceRows.length} licence rows…`);
  const licenceResult = await commitBatch("licence", licenceRows);
  log(`  ✓ licences: ${licenceResult.committed_count} committed, ${licenceResult.rejected_rows.length} rejected, ${licenceResult.flagged_rows.length} flagged`);

  if (licenceResult.rejected_rows.length > 0) {
    log("  Rejected licences (first 5):");
    for (const r of licenceResult.rejected_rows.slice(0, 5)) {
      log(`    Row ${r.source_row_index}: ${r.reasons.join("; ")}`);
    }
  }

  // ── 6. Summary ────────────────────────────────────────────────────────────
  const totalCommitted = staffResult.committed_count + licenceResult.committed_count;
  const totalRejected  = staffResult.rejected_rows.length + licenceResult.rejected_rows.length;
  const totalFlagged   = staffResult.flagged_rows.length  + licenceResult.flagged_rows.length;

  log("─".repeat(60));
  log(`Migration complete.`);
  log(`  Committed : ${totalCommitted}`);
  log(`  Flagged   : ${totalFlagged}`);
  log(`  Rejected  : ${totalRejected}`);

  if (totalRejected > 0) {
    log("  ⚠ Some rows were not migrated. Review the output above and fix in Cards before re-running.");
    process.exit(1);
  }

  log("  ✓ All rows migrated successfully.");
}

main().catch((err) => {
  logErr(err.message ?? String(err));
  process.exit(1);
});
