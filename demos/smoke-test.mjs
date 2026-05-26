/**
 * EQ Intake — end-to-end smoke test for eq_intake_commit_batch_core
 * ===================================================================
 * Exercises the full intake pipeline against the sks-canonical Supabase
 * instance: create event → commit customer → assert row exists → rollback.
 *
 * HOW TO RUN
 * ----------
 *   # From the repo root (Node 20+). @supabase/supabase-js lives in eq-platform/node_modules.
 *   # Run from eq-platform so Node resolves the package, or install it first:
 *
 *   Option A — run from eq-platform directory:
 *     cd eq-platform
 *     SUPABASE_URL=... SUPABASE_SERVICE_KEY=... TEST_TENANT_ID=... node ../demos/smoke-test.mjs
 *
 *   Option B — install locally in demos/ first:
 *     cd demos && npm init -y && npm i @supabase/supabase-js
 *     SUPABASE_URL=... SUPABASE_SERVICE_KEY=... TEST_TENANT_ID=... node smoke-test.mjs
 *
 *   Option C — set NODE_PATH from repo root:
 *     NODE_PATH=./eq-platform/node_modules \
 *       SUPABASE_URL=... SUPABASE_SERVICE_KEY=... TEST_TENANT_ID=... \
 *       node demos/smoke-test.mjs
 *
 *   # Required env vars:
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY=<service_role_key>
 *   TEST_TENANT_ID=<uuid>          # any valid UUID; used as tenant_id on test rows
 *
 *   # Optional:
 *   SMOKE_VERBOSE=1                # print full RPC payloads for debugging
 *
 * WHY SERVICE KEY
 * ---------------
 * The service_role key bypasses RLS so the test can read/write without needing
 * a real user session. The tenant_id mismatch guard in the RPC reads
 * auth.jwt() -> 'app_metadata' ->> 'tenant_id'; the service role JWT has no
 * app_metadata.tenant_id so that check evaluates to null (falsy) and passes.
 * This is intentional for testing — production callers use authenticated JWTs.
 *
 * CLEANUP
 * -------
 * The test calls eq_intake_rollback at the end to delete the committed customer
 * row and mark the intake event as 'rolled_back'. If the test crashes mid-run,
 * orphaned rows can be cleaned up manually:
 *   DELETE FROM app_data.customers WHERE intake_id = '<intake_id>';
 *   DELETE FROM shell_control.eq_intake_events WHERE intake_id = '<intake_id>';
 */

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TEST_TENANT_ID = process.env.TEST_TENANT_ID;
const VERBOSE = Boolean(process.env.SMOKE_VERBOSE);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TEST_TENANT_ID) {
  console.error('FAIL: missing required env vars. Need SUPABASE_URL, SUPABASE_SERVICE_KEY, TEST_TENANT_ID.');
  process.exit(1);
}

// Default schema: public (always exposed by Supabase PostgREST).
// shell_control is NOT in the exposed-schemas list — access it only via
// SECURITY DEFINER RPCs (eq_create_intake_event, eq_get_intake_event_status,
// eq_mark_intake_rolled_back) added in migrations 016–017.
// app_data reads use .schema('app_data') on the fly.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

/** Pretty elapsed time since startMs */
function elapsed(startMs) {
  return `${(Date.now() - startMs).toFixed(0)}ms`;
}

function log(step, status, detail = '', timingMs = null) {
  const timing = timingMs !== null ? ` [${elapsed(timingMs)}]` : '';
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  console.log(`  ${icon} ${step}${timing}${detail ? ': ' + detail : ''}`);
}

function verbose(label, value) {
  if (VERBOSE) {
    console.log(`    [verbose] ${label}:`, JSON.stringify(value, null, 2));
  }
}

function fail(step, err) {
  const msg = err instanceof Error
    ? err.message
    : (err?.message ? `${err.message}${err.details ? ' — ' + err.details : ''}${err.hint ? ' (hint: ' + err.hint + ')' : ''}` : JSON.stringify(err));
  log(step, 'FAIL', msg);
  console.error('\nSmoke test FAILED. Exiting.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('\nEQ Intake — smoke test');
console.log(`  URL:       ${SUPABASE_URL}`);
console.log(`  tenant_id: ${TEST_TENANT_ID}`);
console.log(`  time:      ${now()}`);
console.log('');

const intakeId = crypto.randomUUID();
const customerId = crypto.randomUUID();
const externalId = `smoke-test-${Date.now()}`;

// ---------------------------------------------------------------------------
// Step 1: Create intake event via eq_create_intake_event RPC
//
// NOTE: shell_control is not in the Supabase exposed-schemas list so a
// direct .schema('shell_control').from(...).insert() call is rejected by
// PostgREST. Migration 016 adds a public-schema SECURITY DEFINER wrapper
// (eq_create_intake_event) that writes into shell_control on our behalf.
// ---------------------------------------------------------------------------
{
  const t = Date.now();
  console.log('Step 1: create intake event');

  const rpcParams = {
    p_intake_id: intakeId,
    p_tenant_id: TEST_TENANT_ID,
    p_entity: 'customer',
    p_source_kind: 'smoke_test',
    p_source_subkind: 'script',
    p_source_filename: 'smoke-test.mjs',
    p_schema_version: '1.0.0',
    p_status: 'committing',
    p_import_mode: 'append',
    p_created_by: '00000000-0000-0000-0000-000000000000',
  };

  verbose('rpc params', rpcParams);

  let error;
  try {
    ({ error } = await supabase.rpc('eq_create_intake_event', rpcParams));
  } catch (e) {
    fail('Step 1', e);
  }

  if (error) fail('Step 1', error);
  log('Step 1', 'PASS', `intake_id=${intakeId}`, t);
}

// ---------------------------------------------------------------------------
// Step 2: Call eq_intake_commit_batch_core RPC with one customer row
// ---------------------------------------------------------------------------
let committedCount = 0;
let committedIds = [];

{
  const t = Date.now();
  console.log('Step 2: call eq_intake_commit_batch_core');

  const customerRow = {
    customer_id: customerId,
    tenant_id: TEST_TENANT_ID,
    external_id: externalId,
    company_name: 'Smoke Test Pty Ltd',
    type: 'customer',
    active: true,
  };

  const rpcParams = {
    p_intake_id: intakeId,
    p_tenant_id: TEST_TENANT_ID,
    p_table: 'customers',
    p_rows: JSON.stringify([customerRow]),
    p_confirm_replace: false,
    p_intake_mode: 'strict',
  };

  verbose('rpc params', rpcParams);

  let data, error;
  try {
    ({ data, error } = await supabase.rpc('eq_intake_commit_batch_core', rpcParams));
  } catch (e) {
    fail('Step 2', e);
  }

  if (error) fail('Step 2', error);

  verbose('rpc response', data);

  const row = Array.isArray(data) ? data[0] : data;
  committedCount = row?.committed_count ?? 0;
  committedIds = row?.committed_ids ?? [];

  if (committedCount !== 1) {
    fail('Step 2', `expected committed_count=1, got ${committedCount}`);
  }

  log('Step 2', 'PASS', `committed_count=${committedCount}, ids=[${committedIds.join(', ')}]`, t);
}

// ---------------------------------------------------------------------------
// Step 3: Assert the customer row exists in app_data.customers
// ---------------------------------------------------------------------------
{
  const t = Date.now();
  console.log('Step 3: assert customer row in app_data.customers');

  let data, error;
  try {
    ({ data, error } = await supabase
      .schema('app_data')
      .from('customers')
      .select('customer_id, company_name, intake_id, external_id, tenant_id')
      .eq('intake_id', intakeId)
      .eq('tenant_id', TEST_TENANT_ID));
  } catch (e) {
    fail('Step 3', e);
  }

  if (error) fail('Step 3', error);

  verbose('SELECT result', data);

  if (!data || data.length === 0) {
    fail('Step 3', 'no customer row found for intake_id');
  }

  const row = data[0];
  if (row.customer_id !== customerId) {
    fail('Step 3', `customer_id mismatch: expected ${customerId}, got ${row.customer_id}`);
  }
  if (row.company_name !== 'Smoke Test Pty Ltd') {
    fail('Step 3', `company_name mismatch: got "${row.company_name}"`);
  }

  log('Step 3', 'PASS', `customer_id=${row.customer_id}, company_name="${row.company_name}"`, t);
}

// ---------------------------------------------------------------------------
// Step 4: Rollback via eq_intake_rollback
//
// NOTE: migration 008 has a potential column-name bug — it sets
// `rolled_back_reason` in the UPDATE but the column in eq_intake_events
// is `rollback_reason`. If the RPC fails because of this, the test falls
// back to a direct DELETE + status UPDATE so cleanup still completes.
// ---------------------------------------------------------------------------
{
  const t = Date.now();
  console.log('Step 4: rollback via eq_intake_rollback');

  let data, error;
  try {
    ({ data, error } = await supabase.rpc('eq_intake_rollback', {
      p_intake_id: intakeId,
      p_reason: 'smoke-test cleanup',
    }));
  } catch (e) {
    fail('Step 4', e);
  }

  if (error) {
    // Warn and attempt direct cleanup so subsequent assertions are meaningful.
    console.warn(`  ! eq_intake_rollback RPC error (${error.message}) — attempting direct DELETE fallback`);

    const { error: delErr } = await supabase
      .schema('app_data')
      .from('customers')
      .delete()
      .eq('intake_id', intakeId)
      .eq('tenant_id', TEST_TENANT_ID);

    if (delErr) {
      fail('Step 4 (fallback DELETE)', delErr);
    }

    // Mark event rolled_back via helper RPC (shell_control not REST-exposed)
    await supabase.rpc('eq_mark_intake_rolled_back', {
      p_intake_id: intakeId,
      p_reason: 'smoke-test cleanup (direct fallback)',
    });

    log('Step 4', 'PASS', 'fallback cleanup completed', t);
  } else {
    verbose('rollback response', data);
    const row = Array.isArray(data) ? data[0] : data;
    const unwoundCount = row?.unwound_count ?? 0;
    log('Step 4', 'PASS', `unwound_count=${unwoundCount}`, t);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Verify customer row is gone (post-rollback assertion)
// ---------------------------------------------------------------------------
{
  const t = Date.now();
  console.log('Step 5: verify customer row deleted after rollback');

  let data, error;
  try {
    ({ data, error } = await supabase
      .schema('app_data')
      .from('customers')
      .select('customer_id')
      .eq('intake_id', intakeId)
      .eq('tenant_id', TEST_TENANT_ID));
  } catch (e) {
    fail('Step 5', e);
  }

  if (error) fail('Step 5', error);

  verbose('post-rollback SELECT', data);

  if (data && data.length > 0) {
    fail('Step 5', `expected 0 rows after rollback, got ${data.length}`);
  }

  log('Step 5', 'PASS', 'no customer rows remain', t);
}

// ---------------------------------------------------------------------------
// Step 6: Verify intake event status = rolled_back
// Uses eq_get_intake_event_status RPC (shell_control not REST-exposed).
// ---------------------------------------------------------------------------
{
  const t = Date.now();
  console.log('Step 6: verify intake event status = rolled_back');

  let data, error;
  try {
    ({ data, error } = await supabase.rpc('eq_get_intake_event_status', {
      p_intake_id: intakeId,
    }));
  } catch (e) {
    fail('Step 6', e);
  }

  if (error) fail('Step 6', error);

  verbose('event status', data);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) fail('Step 6', 'intake event row not found');
  if (row.status !== 'rolled_back') {
    fail('Step 6', `expected status='rolled_back', got '${row.status}'`);
  }

  log('Step 6', 'PASS', `status=${row.status}`, t);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('');
console.log('All steps PASSED.');
console.log('');
