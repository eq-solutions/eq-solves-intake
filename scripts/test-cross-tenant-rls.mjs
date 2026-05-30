/**
 * Cross-tenant RLS smoke test — sks-canonical
 *
 * Verifies that a row inserted as tenant A is invisible to a query made as
 * tenant B. Run this before onboarding a second tenant to confirm RLS
 * isolation is solid end-to-end.
 *
 * Usage:
 *   SUPABASE_URL=https://... SUPABASE_SERVICE_KEY=... node scripts/test-cross-tenant-rls.mjs
 *
 * Requirements:
 *   - Two real JWT tokens (or anon key + JWT pairs) with different
 *     app_metadata.tenant_id values. The easiest way in the Supabase
 *     dashboard: create two test users and set their app_metadata.tenant_id
 *     via the Supabase Dashboard → Auth → Users → Edit User.
 *   - TENANT_A_JWT and TENANT_B_JWT env vars.
 *
 * What it checks:
 *   1. Insert a row into app_data.customers using tenant A's JWT.
 *   2. Query app_data.customers using tenant B's JWT — expect 0 rows matching
 *      the inserted external_id.
 *   3. Query using tenant A's JWT — expect 1 row (the row we just inserted).
 *   4. Clean up: delete the test row as tenant A.
 *
 * The test exits 0 on success, 1 on failure.
 */

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  TENANT_A_JWT,
  TENANT_B_JWT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TENANT_A_JWT || !TENANT_B_JWT) {
  console.error(
    'Missing env vars. Need: SUPABASE_URL, SUPABASE_SERVICE_KEY, TENANT_A_JWT, TENANT_B_JWT'
  );
  process.exit(1);
}

const TEST_EXTERNAL_ID = `rls-smoke-${Date.now()}`;

/** PostgREST request helper. */
async function pgRest({ method = 'GET', path, jwt, body, serviceKey } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Prefer: 'return=representation',
    apikey: serviceKey ?? SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${jwt ?? SUPABASE_SERVICE_KEY}`,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

let insertedId = null;

async function run() {
  let passed = 0;
  let failed = 0;

  function pass(label) { console.log(`  ✓ ${label}`); passed++; }
  function fail(label, detail) { console.error(`  ✗ ${label}\n    ${detail}`); failed++; }

  // ── 1. Insert as tenant A ──────────────────────────────────────────────────
  console.log('\n[1] Inserting test customer as tenant A…');
  const insert = await pgRest({
    method: 'POST',
    path: '/app_data.customers',
    jwt: TENANT_A_JWT,
    body: {
      external_id:  TEST_EXTERNAL_ID,
      company_name: 'RLS Smoke Test — DELETE ME',
      active:       true,
    },
  });

  if (insert.status === 201 && Array.isArray(insert.data) && insert.data[0]) {
    insertedId = insert.data[0].customer_id;
    pass(`Inserted customer_id ${insertedId}`);
  } else {
    fail('Insert failed', JSON.stringify(insert));
    process.exit(1);
  }

  // ── 2. Query as tenant B — must return 0 rows ──────────────────────────────
  console.log('\n[2] Querying as tenant B — should see 0 rows…');
  const queryB = await pgRest({
    method: 'GET',
    path: `/app_data.customers?external_id=eq.${encodeURIComponent(TEST_EXTERNAL_ID)}`,
    jwt: TENANT_B_JWT,
  });

  if (queryB.status === 200 && Array.isArray(queryB.data) && queryB.data.length === 0) {
    pass('Tenant B sees 0 rows — RLS isolation confirmed');
  } else {
    fail(
      'Tenant B can see tenant A\'s row — RLS LEAK',
      `status=${queryB.status} rows=${JSON.stringify(queryB.data)}`
    );
  }

  // ── 3. Query as tenant A — must return 1 row ───────────────────────────────
  console.log('\n[3] Querying as tenant A — should see 1 row…');
  const queryA = await pgRest({
    method: 'GET',
    path: `/app_data.customers?external_id=eq.${encodeURIComponent(TEST_EXTERNAL_ID)}`,
    jwt: TENANT_A_JWT,
  });

  if (queryA.status === 200 && Array.isArray(queryA.data) && queryA.data.length === 1) {
    pass('Tenant A sees their own row');
  } else {
    fail(
      'Tenant A cannot see their own row — RLS misconfigured',
      `status=${queryA.status} rows=${JSON.stringify(queryA.data)}`
    );
  }

  // ── 4. Cleanup — delete as tenant A ───────────────────────────────────────
  if (insertedId) {
    console.log('\n[4] Cleaning up test row…');
    const del = await pgRest({
      method: 'DELETE',
      path: `/app_data.customers?customer_id=eq.${insertedId}`,
      jwt: TENANT_A_JWT,
    });
    if (del.status === 200 || del.status === 204) {
      pass('Test row deleted');
    } else {
      console.warn(`  ⚠ Cleanup failed (status ${del.status}) — delete manually: external_id = '${TEST_EXTERNAL_ID}'`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFAIL — RLS cross-tenant isolation is broken. Do not onboard second tenant.');
    process.exit(1);
  }
  console.log('\nPASS — RLS isolation is solid.');
}

run().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
