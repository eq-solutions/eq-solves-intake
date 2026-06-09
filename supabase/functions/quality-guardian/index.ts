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
 * Register as a pg_cron job (run once after applying sql/053):
 *
 *   SELECT cron.schedule(
 *     'quality-guardian-nightly',
 *     '0 1 * * *',                              -- 01:00 UTC daily
 *     $$
 *     SELECT net.http_post(
 *       url    := current_setting('app.edge_function_base_url') || '/quality-guardian',
 *       headers := jsonb_build_object(
 *         'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
 *         'Content-Type',  'application/json'
 *       ),
 *       body   := '{"triggered_by":"schedule"}'::jsonb
 *     );
 *     $$
 *   );
 *
 * Or invoke manually:
 *   POST /functions/v1/quality-guardian
 *   Authorization: Bearer <service-role-key>
 *   Body: { "triggered_by": "manual", "tenant_id": "<uuid>" }
 *
 * ── Auth ──────────────────────────────────────────────────────────────────
 * Expects the service-role key. The function sets tenant scope per-tenant
 * by querying app_data.tenants and running checks with that tenant's JWT context.
 * When triggered manually with a tenant_id, only that tenant is processed.
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

interface TenantRow {
  tenant_id: string;
}

interface RunSummary {
  licence_alerts:  { total: number; critical: number; warning: number; info: number };
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
  const summary = { total: 0, critical: 0, warning: 0, info: 0 };

  const { data: rawData, error } = await supabase.rpc('eq_tidy_read_entity', {
    p_table: 'licences',
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

    const { error: alertErr } = await supabase.rpc('eq_quality_upsert_alert', {
      p_tenant_id:   tenantId,
      p_alert_type:  'licence_expiry',
      p_entity_type: 'licence',
      p_entity_id:   row.licence_id,
      p_message:     message,
      p_severity:    severity,
    });

    if (alertErr) {
      console.warn(`alert upsert failed for ${row.licence_id}: ${alertErr.message}`);
      continue;
    }

    summary.total++;
    (summary as Record<string, number>)[severity]++;
  }

  return summary;
}

async function computeHealthScores(
  supabase: ReturnType<typeof createClient>,
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
    const { data: rawData, error } = await supabase.rpc('eq_tidy_read_entity', {
      p_table: entity,
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
): Promise<RunSummary['orphan_totals']> {
  const { data, error } = await supabase.rpc('eq_tidy_orphan_check', {});
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

  let body: RequestBody = {};
  try {
    body = await req.json() as RequestBody;
  } catch {
    // Body is optional — schedule triggers may send empty body
  }

  const triggeredBy = body.triggered_by ?? 'schedule';
  const admin = createClient(supabaseUrl, serviceKey);

  // Resolve tenant list
  let tenants: TenantRow[] = [];

  if (body.tenant_id) {
    tenants = [{ tenant_id: body.tenant_id }];
  } else {
    // Service-role query — fetch all active tenants
    const { data, error } = await admin
      .from('app_data.tenants')
      .select('tenant_id');

    if (error) {
      // Try shell_control schema
      const { data: d2, error: e2 } = await admin
        .schema('shell_control')
        .from('tenants')
        .select('tenant_id');

      if (e2) {
        return new Response(
          JSON.stringify({ error: `Could not load tenants: ${error.message}` }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      tenants = (d2 ?? []) as TenantRow[];
    } else {
      tenants = (data ?? []) as TenantRow[];
    }
  }

  const results: Array<{ tenant_id: string; run_id: string; summary: RunSummary }> = [];

  for (const { tenant_id } of tenants) {
    // Create a run record
    const startedAt = new Date().toISOString();

    const { data: runData, error: runErr } = await admin
      .from('app_data.eq_quality_runs')
      .insert({
        tenant_id,
        run_type:     triggeredBy === 'schedule' ? 'scheduled' : 'manual',
        triggered_by: triggeredBy,
        started_at:   startedAt,
      })
      .select('id')
      .single();

    const runId: string = (runData as { id: string } | null)?.id ?? crypto.randomUUID();

    // Build a per-tenant Supabase client with the tenant JWT baked in via
    // service-role. We inject tenant_id into the global setting so RPCs can
    // read it from app_metadata.
    // NOTE: For service-role, RLS is bypassed; the RPCs themselves gate on
    // the tenant_id parameter passed explicitly.
    const tenantSupabase = createClient(supabaseUrl, serviceKey, {
      global: {
        headers: {
          'x-tenant-id': tenant_id,
        },
      },
    });

    const summary: RunSummary = {
      licence_alerts: { total: 0, critical: 0, warning: 0, info: 0 },
      health_scores:  [],
      orphan_totals:  { assets_no_site: 0, contacts_no_parent: 0, licences_no_staff: 0, sites_no_customer: 0, total: 0 },
      errors:         [],
    };

    try {
      summary.licence_alerts = await runLicenceExpiry(tenantSupabase, tenant_id);
    } catch (e) {
      summary.errors.push(`licence_expiry: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      summary.health_scores = await computeHealthScores(tenantSupabase);
    } catch (e) {
      summary.errors.push(`health_scores: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      summary.orphan_totals = await runOrphanCheck(tenantSupabase);
    } catch (e) {
      summary.errors.push(`orphan_check: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Update run record with completed_at + summary
    if (!runErr && runId) {
      await admin
        .from('app_data.eq_quality_runs')
        .update({
          completed_at: new Date().toISOString(),
          summary:      summary,
        })
        .eq('id', runId);
    }

    results.push({ tenant_id, run_id: runId, summary });
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
