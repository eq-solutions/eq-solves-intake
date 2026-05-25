import { createClient } from 'npm:@supabase/supabase-js@2'

// eq-canonical-internal — Cards worker pool
const CARDS_URL           = Deno.env.get('CARDS_SUPABASE_URL')!
const CARDS_SERVICE_ROLE  = Deno.env.get('CARDS_SERVICE_ROLE_KEY')!

// This employer's canonical Supabase (auto-provided by Supabase runtime)
const EMPLOYER_URL         = Deno.env.get('SUPABASE_URL')!
const EMPLOYER_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EMPLOYER_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')!

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Verify the caller is an authenticated employer user.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  const employerUserClient = createClient(EMPLOYER_URL, EMPLOYER_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await employerUserClient.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })

  const tenantId = user.user_metadata?.tenant_id as string | undefined
  if (!tenantId) return new Response('tenant_id missing from user metadata', { status: 400 })

  // Parse request body.
  let body: { assignment_id?: string }
  try { body = await req.json() } catch { return new Response('Invalid JSON', { status: 400 }) }

  const { assignment_id } = body
  if (!assignment_id) return new Response('assignment_id required', { status: 400 })

  // ── Step 1: approve the assignment in the Cards worker pool ──────────────
  const cardsAdmin = createClient(CARDS_URL, CARDS_SERVICE_ROLE)

  const { data: assignment, error: approveError } = await cardsAdmin
    .rpc('approve_worker_assignment', { p_assignment_id: assignment_id })

  if (approveError) {
    return Response.json({ error: approveError.message }, { status: 422 })
  }

  // Confirm the assignment actually belongs to this tenant.
  if (assignment.tenant_id !== tenantId) {
    return new Response('assignment does not belong to this tenant', { status: 403 })
  }

  // ── Step 2: fetch worker data from the Cards pool ────────────────────────
  const [workerRes, credentialsRes, inductionsRes] = await Promise.all([
    cardsAdmin.from('workers').select('*').eq('id', assignment.worker_id).single(),
    cardsAdmin.from('worker_credentials').select('*').eq('worker_id', assignment.worker_id).eq('status', 'active'),
    cardsAdmin.from('worker_inductions').select('*').eq('worker_id', assignment.worker_id).eq('tenant_id', tenantId),
  ])

  if (workerRes.error || !workerRes.data) {
    return Response.json({ error: 'worker not found' }, { status: 500 })
  }

  const worker      = workerRes.data
  const credentials = credentialsRes.data ?? []
  const inductions  = inductionsRes.data ?? []

  // ── Step 3: upsert into employer canonical ───────────────────────────────
  const employerAdmin = createClient(EMPLOYER_URL, EMPLOYER_SERVICE_ROLE)
  const now = new Date().toISOString()

  const { data: staff, error: staffError } = await employerAdmin
    .from('staff')
    .upsert(
      {
        cards_worker_id: worker.id,
        tenant_id:       tenantId,
        first_name:      worker.first_name,
        last_name:       worker.last_name,
        preferred_name:  worker.preferred_name ?? null,
        email:           worker.email,
        phone:           worker.phone,
        employment_type: 'labour_hire',
        active:          true,
        imported_from:   'eq-cards',
        imported_at:     now,
      },
      { onConflict: 'cards_worker_id' },
    )
    .select('staff_id')
    .single()

  if (staffError || !staff) {
    return Response.json({ error: staffError?.message ?? 'staff upsert failed' }, { status: 500 })
  }

  // ── Step 4: upsert licences (active credentials only) ───────────────────
  if (credentials.length > 0) {
    const licenceRows = credentials.map((c) => ({
      cards_credential_id: c.id,
      staff_id:            staff.staff_id,
      tenant_id:           tenantId,
      licence_type:        c.credential_type,
      licence_number:      c.licence_number ?? null,
      issuing_authority:   c.issuing_body,
      state:               c.state_territory ?? null,
      issue_date:          c.issue_date ?? null,
      expiry_date:         c.expiry_date ?? null,
      active:              true,
      imported_from:       'eq-cards',
      imported_at:         now,
      confirmed_by:        null,
      confirmed_at:        null,
    }))

    const { error: licenceError } = await employerAdmin
      .from('licences')
      .upsert(licenceRows, { onConflict: 'cards_credential_id' })

    if (licenceError) {
      return Response.json({ error: licenceError.message }, { status: 500 })
    }
  }

  // Inductions are stored in the worker pool (scoped by tenant_id) — no sync
  // to employer canonical needed. Employer reads them via the Cards read-link.
  // If a future requirement needs them in the canonical, add upsert here.

  return Response.json({
    success:    true,
    staff_id:   staff.staff_id,
    licences:   credentials.length,
    inductions: inductions.length,
  })
})
