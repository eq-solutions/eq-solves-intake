/**
 * quality-guardian — Supabase Edge Function
 *
 * Runs the nightly quality checks across all tenants:
 *   1. Licence expiry alerts (critical/warning/info by days remaining)
 *   2. Data health scores (completeness % per entity type)
 *   3. Orphan check (broken FK relationships)
 *
 * Each run is logged to eq_quality_runs with a summary JSONB.
 *
 * ── Schedule ──────────────────────────────────────────────────────────────
 * Registered as a pg_cron job by sql/060_quality_guardian_cron_sks.sql
 * ('quality-guardian-nightly', 17:00 UTC daily = 03:00 AEST). The job reads the
 * service-role key from Vault (secret name: edge_service_role_key) at fire
 * time — see that file for the one-time vault.create_secret prerequisite.
 *
 * Or invoke manually:
 *   POST /functions/v1/quality-guardian
 *   Authorization: Bearer <service-role-key>
 *   Body: { "triggered_by": "manual", "tenant_id": "<uuid>" }
 *
 * ── Auth ──────────────────────────────────────────────────────────────────
 * Requires the service-role key EXACTLY — the platform's verify_jwt gate
 * admits any valid project JWT (including tenant users), so the handler
 * compares the bearer token to SUPABASE_SERVICE_ROLE_KEY itself and rejects
 * everything else. Tenant scope is passed explicitly to the service-role RPC
 * variants from sql/059 (eq_tidy_read_entity_admin, eq_tidy_orphan_check_admin,
 * eq_quality_start_run, eq_quality_complete_run, eq_quality_list_tenants);
 * the JWT-scoped tidy RPCs raise 'no tenant_id in JWT' under a bare
 * service-role call and must not be used here.
 *
 * ── Environment variables ──────────────────────────────────────────────────
 *   SUPABASE_URL               — set automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY  — set automatically by Supabase
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RequestBody {
  triggered_by?: string;
  tenant_id?:    string;   // limit to single tenant when set
}

interface RunSummary {
  licence_alerts:  { total: number; critical: number; warning: number; info: number; alerts_failed: number };
  health_scores:   Array<{ entity: string; score: number; total: number; complete: number; gaps: string[] }>;
  orphan_totals:   {
    assets_no_site:     number;
    contacts_no_parent: number;
    licences_no_staff:  number;
    sites_no_customer:  number;
    total:              number;
  };
  errors: string[];
}

// ---------------------------------------------------------------------------
// Minimal inline implementations
// We can't import @eq/intake directly from a Supabase edge function (no monorepo
// bundling in the Deno runtime). The logic is thin enough to inline here, with
// calls to the canonical RPCs already on the database.
// ---------------------------------------------------------------------------

async function runLicenceExpiry(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<RunSummary['licence_alerts']> {
  const summary = { total: 0, critical: 0, warning: 0, info: 0, alerts_failed: 0 };

  const { data: rawData, error } = await supabase.rpc('eq_tidy_read_entity_admin', {
    p_tenant_id: tenantId,
    p_table:     'licences',
  });
  if (error) throw new Error(`licence read failed: ${error.message}`);

  const rows = (rawData as Array<{
    licence_id: string;
    licence_type: string | null;
    expiry_date:  string | null;
    staff_id:     string | null;
  }> | null) ?? [];

  const now   = new Date();
  const limit = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  for (const row of rows) {
    if (!row.expiry_date) continue;
    const expiry = new Date(row.expiry_date);
    if (expiry > limit) continue;

    const days =
      Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const severity: 'critical' | 'warning' | 'info' =
      days < 14 ? 'critical' : days < 30 ? 'warning' : 'info';

    const message =
      days <= 0
        ? `${row.licence_type ?? 'Licence'} expired ${Math.abs(days)} day(s) ago.`
        : `${row.licence_type ?? 'Licence'} expires in ${days} day(s).`;

    // Count from the data before attempting persistence — an expired licence
    // must show in the run summary even if the alert upsert fails.
    summary.total++;
    (summary as Record<string, number>)[severity]++;

    const { error: alertErr } = await supabase.rpc('eq_quality_upsert_alert', {
      p_tenant_id:   tenantId,
      p_alert_type:  'licence_expiry',
      p_entity_type: 'licence',
      p_entity_id:   row.licence_id,
      p_message:     message,
      p_severity:    severity,
    });

    if (alertErr) {
      summary.alerts_failed++;
      console.warn(`alert upsert failed for ${row.licence_id}: ${alertErr.message}`);
    }
  }

  return summary;
}

async function computeHealthScores(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<RunSummary['health_scores']> {
  const ENTITIES: Record<string, { required: string[]; inspected: string[] }> = {
    customers: {
      required:  ['company_name'],
      inspected: ['company_name', 'email', 'phone', 'abn'],
    },
    sites: {
      required:  ['site_name'],
      inspected: ['site_name', 'address', 'suburb', 'state', 'postcode'],
    },
    contacts: {
      required:  ['full_name'],
      inspected: ['full_name', 'email', 'phone'],
    },
    staff: {
      required:  ['first_name', 'last_name'],
      inspected: ['first_name', 'last_name', 'email', 'phone'],
    },
    assets: {
      required:  ['asset_name'],
      inspected: ['asset_name', 'asset_type', 'serial_number', 'site_id'],
    },
  };

  const scores: RunSummary['health_scores'] = [];

  for (const [entity, { required, inspected }] of Object.entries(ENTITIES)) {
    const { data: rawData, error } = await supabase.rpc('eq_tidy_read_entity_admin', {
      p_tenant_id: tenantId,
      p_table:     entity,
    });
    if (error) {
      scores.push({ entity, total: 0, complete: 0, score: 0, gaps: [`read error: ${error.message}`] });
      continue;
    }

    const rows = (rawData as Record<string, unknown>[] | null) ?? [];
    const total    = rows.length;
    const complete = rows.filter((r) =>
      required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ''),
    ).length;
    const score = total === 0 ? 1 : complete / total;

    // Top gaps
    const gapCounts: Record<string, number> = {};
    for (const row of rows) {
      for (const f of inspected) {
        if (row[f] === null || row[f] === undefined || row[f] === '') {
          gapCounts[f] = (gapCounts[f] ?? 0) + 1;
        }
      }
    }
    const gaps = Object.entries(gapCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .filter(([, c]) => c > 0)
      .map(([f]) => f);

    scores.push({ entity, total, complete, score, gaps });
  }

  return scores;
}

async function runOrphanCheck(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<RunSummary['orphan_totals']> {
  const { data, error } = await supabase.rpc('eq_tidy_orphan_check_admin', {
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(`orphan check failed: ${error.message}`);

  const raw = data as {
    summary: {
      assets_no_site_count:       number;
      contacts_no_parent_count:   number;
      licences_no_staff_count:    number;
      sites_no_customer_count:    number;
    };
  } | null;

  if (!raw) {
    return { assets_no_site: 0, contacts_no_parent: 0, licences_no_staff: 0, sites_no_customer: 0, total: 0 };
  }

  const s = raw.summary;
  return {
    assets_no_site:     s.assets_no_site_count,
    contacts_no_parent: s.contacts_no_parent_count,
    licences_no_staff:  s.licences_no_staff_count,
    sites_no_customer:  s.sites_no_customer_count,
    total:
      s.assets_no_site_count +
      s.contacts_no_parent_count +
      s.licences_no_staff_count +
      s.sites_no_customer_count,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // verify_jwt admits any valid project JWT — require the service-role key
  // itself. Tenant-user tokens must not be able to trigger runs.
  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${serviceKey}`) {
    return new Response(
      JSON.stringify({ error: 'service-role key required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let body: RequestBody = {};
  try {
    body = await req.json() as RequestBody;
  } catch {
    // Body is optional — schedule triggers may send empty body
  }

  const triggeredBy = body.triggered_by ?? 'schedule';
  const runType     = triggeredBy === 'schedule' ? 'scheduled' : 'manual';
  const admin = createClient(supabaseUrl, serviceKey);

  // Resolve tenant list
  let tenantIds: string[] = [];

  if (body.tenant_id) {
    tenantIds = [body.tenant_id];
  } else {
    const { data, error } = await admin.rpc('eq_quality_list_tenants');
    if (error) {
      return new Response(
        JSON.stringify({ error: `Could not load tenants: ${error.message}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    tenantIds = (data as string[] | null) ?? [];
  }

  const results: Array<{ tenant_id: string; run_id: string | null; summary: RunSummary }> = [];

  for (const tenantId of tenantIds) {
    const summary: RunSummary = {
      licence_alerts: { total: 0, critical: 0, warning: 0, info: 0, alerts_failed: 0 },
      health_scores:  [],
      orphan_totals:  { assets_no_site: 0, contacts_no_parent: 0, licences_no_staff: 0, sites_no_customer: 0, total: 0 },
      errors:         [],
    };

    // Open the run record
    const { data: runData, error: runErr } = await admin.rpc('eq_quality_start_run', {
      p_tenant_id:    tenantId,
      p_run_type:     runType,
      p_triggered_by: triggeredBy,
    });
    const runId = (runData as string | null) ?? null;
    if (runErr) {
      summary.errors.push(`start_run: ${runErr.message}`);
      console.error(`start_run failed for tenant ${tenantId}: ${runErr.message}`);
    }

    try {
      summary.licence_alerts = await runLicenceExpiry(admin, tenantId);
    } catch (e) {
      summary.errors.push(`licence_expiry: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      summary.health_scores = await computeHealthScores(admin, tenantId);
    } catch (e) {
      summary.errors.push(`health_scores: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      summary.orphan_totals = await runOrphanCheck(admin, tenantId);
    } catch (e) {
      summary.errors.push(`orphan_check: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Stamp completed_at + summary
    if (runId) {
      const { error: doneErr } = await admin.rpc('eq_quality_complete_run', {
        p_run_id:  runId,
        p_summary: summary,
      });
      if (doneErr) {
        console.error(`complete_run failed for run ${runId}: ${doneErr.message}`);
      }
    }

    results.push({ tenant_id: tenantId, run_id: runId, summary });
  }

  return new Response(
    JSON.stringify({ ok: true, processed: results.length, results }),
    {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
});
