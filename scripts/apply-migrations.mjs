#!/usr/bin/env node
/**
 * apply-migrations.mjs
 *
 * Applies pending SQL migrations to a Supabase project in sequential order.
 * Tracks applied migrations in `app_data.eq_migrations` so re-running is safe.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/apply-migrations.mjs \
 *     --url  https://xxxx.supabase.co \
 *     --key  eyJ...  (service-role key)
 *     [--dir sql/]
 *     [--dry-run]
 *     [--from 020]    # only apply from migration 020 onward
 *     [--to 025]      # only apply up to and including migration 025
 *
 * ── Migration tracking table ──────────────────────────────────────────────────
 * Creates `app_data.eq_migrations` if it doesn't exist:
 *   filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ
 *
 * Migrations already in this table are skipped. A migration is tracked only
 * after it completes successfully — if a migration fails halfway through,
 * it won't be marked applied and will retry on the next run.
 *
 * ── File naming convention ────────────────────────────────────────────────────
 * Files must match: /^\d{3}[a-z]?_.*\.sql$/ (e.g. 028_ppm_tables.sql)
 * Files matching seed-schemas.ts or .ts are skipped.
 * Files in subdirectories are also skipped — put migrations directly in sql/.
 *
 * ── Error handling ────────────────────────────────────────────────────────────
 * On failure: prints the error, marks the file as FAILED, and stops.
 * Re-run after fixing the SQL — the failed file will retry.
 * Skipped (already applied) files show as ✓ in the log.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "url":     { type: "string" },
    "key":     { type: "string" },
    "dir":     { type: "string", default: "sql" },
    "dry-run": { type: "boolean", default: false },
    "from":    { type: "string" },
    "to":      { type: "string" },
    "help":    { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
apply-migrations.mjs — apply pending SQL migrations to a Supabase project

Options:
  --url       Supabase project URL (or SUPABASE_URL env var)
  --key       Service-role key (or SUPABASE_SERVICE_ROLE_KEY env var)
  --dir       Directory containing migrations (default: sql/)
  --dry-run   Print what would run without executing
  --from NNN  Only apply migrations starting at number NNN (inclusive)
  --to   NNN  Only apply migrations up to and including number NNN
  --help      Show this help
`);
  process.exit(0);
}

const url = args["url"] ?? process.env.SUPABASE_URL;
const key = args["key"] ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const dir = resolve(args["dir"] ?? "sql");
const dryRun = args["dry-run"] ?? false;
const fromNum = args["from"] ? parseInt(args["from"], 10) : null;
const toNum   = args["to"]   ? parseInt(args["to"],   10) : null;

if (!url || !key) {
  console.error("apply-migrations: --url and --key are required (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars)");
  process.exit(1);
}

// ── Supabase client ──────────────────────────────────────────────────────────

const db = createClient(url, key, { auth: { persistSession: false } });

// ── Migration file discovery ──────────────────────────────────────────────────

const MIGRATION_RE = /^(\d{3}[a-z]?)_.*\.sql$/;

function discoverMigrations(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.error(`apply-migrations: cannot read directory "${dir}": ${e.message}`);
    process.exit(1);
  }

  return entries
    .filter((e) => MIGRATION_RE.test(e))
    .sort()
    .map((filename) => {
      const match = filename.match(/^(\d+)/);
      const num = match ? parseInt(match[1], 10) : 0;
      return { filename, num, path: join(dir, filename) };
    })
    .filter(({ num }) => {
      if (fromNum !== null && num < fromNum) return false;
      if (toNum   !== null && num > toNum)   return false;
      return true;
    });
}

// ── Migration tracking table ──────────────────────────────────────────────────

async function ensureMigrationsTable() {
  const { error } = await db.rpc("eq_exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS app_data.eq_migrations (
        filename    TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        duration_ms INT
      );
    `,
  });
  if (error) {
    // eq_exec_sql might not exist — fall back to a direct SQL check.
    // If this also fails, the caller must create the table manually.
    console.warn(`apply-migrations: could not ensure eq_migrations table: ${error.message}`);
    console.warn("  You may need to create it manually:");
    console.warn("  CREATE TABLE IF NOT EXISTS app_data.eq_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_ms INT);");
  }
}

async function getAppliedMigrations() {
  const { data, error } = await db
    .from("eq_migrations")
    .select("filename")
    .order("filename");
  if (error) {
    if (error.code === "42P01") {
      // Table doesn't exist yet — treat as empty (no migrations applied).
      return new Set();
    }
    throw new Error(`Failed to read eq_migrations: ${error.message}`);
  }
  return new Set((data ?? []).map((r) => r.filename));
}

async function markApplied(filename, durationMs) {
  const { error } = await db
    .from("eq_migrations")
    .upsert({ filename, applied_at: new Date().toISOString(), duration_ms: durationMs });
  if (error) {
    throw new Error(`Failed to record migration ${filename}: ${error.message}`);
  }
}

// ── Execute SQL ───────────────────────────────────────────────────────────────

async function executeSql(sql) {
  // Supabase doesn't expose raw SQL execution to clients by default.
  // Options in order of preference:
  //   1. eq_exec_sql RPC (if you've deployed it — a SECURITY DEFINER wrapper)
  //   2. Supabase Management API (requires a management API key)
  //
  // For this script we use option 1. If eq_exec_sql isn't deployed, the
  // caller must use `supabase db push` or paste into Studio instead.
  const { error } = await db.rpc("eq_exec_sql", { sql });
  if (error) throw error;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const migrations = discoverMigrations(dir);

  if (migrations.length === 0) {
    console.log("apply-migrations: no migration files found in", dir);
    process.exit(0);
  }

  console.log(`apply-migrations — ${url}`);
  console.log(`  Directory : ${dir}`);
  console.log(`  Migrations: ${migrations.length} files found`);
  if (dryRun) console.log("  [DRY RUN — nothing will be written]");
  console.log("");

  if (!dryRun) {
    await ensureMigrationsTable();
  }

  const applied = dryRun ? new Set() : await getAppliedMigrations();

  let skipped = 0;
  let ran = 0;
  let failed = 0;

  for (const { filename, path: filePath } of migrations) {
    if (applied.has(filename)) {
      console.log(`  ✓ ${filename} (already applied)`);
      skipped++;
      continue;
    }

    const sql = readFileSync(filePath, "utf8");

    if (dryRun) {
      console.log(`  → ${filename} [would run ${sql.length} chars]`);
      ran++;
      continue;
    }

    const start = Date.now();
    process.stdout.write(`  → ${filename} … `);

    try {
      await executeSql(sql);
      const ms = Date.now() - start;
      await markApplied(filename, ms);
      process.stdout.write(`done (${ms}ms)\n`);
      ran++;
    } catch (e) {
      process.stdout.write(`FAILED\n`);
      console.error(`     ${e.message ?? String(e)}`);
      failed++;
      // Stop on first failure — later migrations may depend on this one.
      break;
    }
  }

  console.log("");
  console.log(`  Applied : ${ran}`);
  console.log(`  Skipped : ${skipped}`);
  if (failed > 0) {
    console.log(`  Failed  : ${failed}`);
    console.error("\napply-migrations: stopped due to failure. Fix the SQL and re-run.");
    process.exit(1);
  }
  console.log("\napply-migrations: complete.");
}

main().catch((err) => {
  console.error("apply-migrations:", err.message ?? String(err));
  process.exit(1);
});
