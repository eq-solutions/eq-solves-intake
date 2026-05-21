'use server'

/**
 * Server action that commits parsed Maximo PDF bundles to canonical
 * maintenance_check / check_asset / maintenance_check_item rows.
 *
 * Parallel sibling to `commitDeltaImportAction` (xlsx flow). We deliberately
 * did NOT force MaintenanceCheckBundle through the xlsx parser shape:
 *   - xlsx flow has alias/fuzzy plan resolution, row-level resolutions,
 *     and a workbook-parse front end that doesn't apply to PDFs.
 *   - Maximo PDFs come in already canonical-shaped (priority normalised,
 *     dates ISO, work_type enum'd) — the skill did that work.
 *   - Translating bundles → DeltaRow[] just to feed the same commit was
 *     more code than a focused commit action.
 *
 * The shape of operations matches the xlsx commit:
 *   1. requireUser → canWrite
 *   2. Zod-validate the bundles payload (client-trustable schema)
 *   3. Bulk resolve site_code → site_id, plan_code → job_plan_id
 *   4. For each bundle: resolve assets, insert check, check_assets, items
 *   5. Compensating-delete rollback if any sub-step fails
 *   6. Audit log + revalidatePath
 *
 * Idempotency: wrapped in `withIdempotency` so retries from the client
 * don't double-commit. The skill's `group_key` is the natural anchor for
 * the per-bundle mutation id; callers should supply one.
 */

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/actions/auth'
import { canWrite } from '@/lib/utils/roles'
import { logAuditEvent } from '@/lib/actions/audit'
import { withIdempotency, type ActionResult } from '@/lib/actions/idempotency'
import { trackServer } from '@/lib/analytics-server'
import type { Database } from '@/lib/supabase/database.types'

type CheckAssetInsert = Database['public']['Tables']['check_assets']['Insert']
type MaintenanceCheckInsert = Database['public']['Tables']['maintenance_checks']['Insert']

// ── Wire-format schemas (must match the skill's CheckAssetInsert /
//    MaintenanceCheckInsert / MaintenanceCheckBundle from @eq/intake) ───

const PriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']).nullable()
const WorkTypeEnum = z.enum(['PM', 'CM', 'EM', 'CAL', 'INSP']).nullable()
const IrScanEnum = z.enum(['pass', 'fail', 'na', 'not_done']).nullable()
const CheckAssetStatusEnum = z.enum(['pending', 'in_progress', 'complete', 'skipped', 'failed'])
const MaintenanceStatusEnum = z.enum([
  'scheduled',
  'in_progress',
  'complete',
  'overdue',
  'cancelled',
])
const FrequencyEnum = z
  .enum(['monthly', 'quarterly', 'semi_annual', 'annual', '2yr', '3yr', '5yr', '8yr', '10yr'])
  .nullable()

const SkillSourceTag = z.object({
  file_name: z.string().optional(),
  extracted_via: z.enum(['text', 'vision']),
  page_number: z.number().int().nonnegative().optional(),
})

const CheckAssetWire = z.object({
  asset_external_id: z.string().nullable(),
  asset_name: z.string().min(1),
  status: CheckAssetStatusEnum,
  work_order_number: z.string().min(1),
  priority: PriorityEnum,
  work_type: WorkTypeEnum,
  crew_id: z.string().nullable(),
  target_start: z.string().nullable(),
  target_finish: z.string().nullable(),
  completed_at: z.string().nullable(),
  failure_code: z.string().nullable(),
  problem: z.string().nullable(),
  cause: z.string().nullable(),
  remedy: z.string().nullable(),
  classification: z.string().nullable(),
  ir_scan_result: IrScanEnum,
  notes: z.string().nullable(),
  source: SkillSourceTag,
})

const MaintenanceCheckWire = z.object({
  site_code: z.string().min(1),
  site_code_raw: z.string().min(1),
  plan_code: z.string().min(1),
  plan_code_raw: z.string().min(1),
  plan_description: z.string().nullable(),
  status: MaintenanceStatusEnum,
  due_date: z.string().min(8),
  start_date: z.string().nullable(),
  frequency: FrequencyEnum,
  maximo_wo_number: z.string().nullable(),
  source: SkillSourceTag,
})

const BundleWire = z.object({
  group_key: z.string().min(1),
  maintenance_check: MaintenanceCheckWire,
  check_assets: z.array(CheckAssetWire).min(1),
})

const PayloadSchema = z.object({
  bundles: z.array(BundleWire).min(1),
  assigned_to: z.string().uuid().nullable().optional(),
})

// ── Return types ─────────────────────────────────────────────────────────

export interface CommittedBundleSummary {
  group_key: string
  check_id: string
  site_code: string
  plan_code: string
  assets_created: number
  items_created: number
}

export interface MaximoCommitSummary {
  checks_created: number
  check_assets_created: number
  check_items_created: number
  bundles: CommittedBundleSummary[]
}

export interface MaximoCommitFailure {
  group_key: string
  reason: string
}

export type MaximoCommitResult = ActionResult<
  MaximoCommitSummary & { failures: MaximoCommitFailure[] }
>

// ── Frequency → boolean column map (mirrors freqColumn in actions.ts) ──

function freqColumn(freq: string | null): string {
  const map: Record<string, string> = {
    monthly: 'freq_monthly',
    quarterly: 'freq_quarterly',
    semi_annual: 'freq_semi_annual',
    annual: 'freq_annual',
    '2yr': 'freq_2yr',
    '3yr': 'freq_3yr',
    '5yr': 'freq_5yr',
    '8yr': 'freq_8yr',
    '10yr': 'freq_10yr',
  }
  return (freq && map[freq]) ?? 'freq_monthly'
}

// ── Helpers ─────────────────────────────────────────────────────────────

function lowerOrNull(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().toLowerCase()
  return t.length === 0 ? null : t
}

// ── Evidence-attachment action ─────────────────────────────────────────

const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024 // matches the parse route's per-PDF cap

export interface EvidenceUploadResult {
  success: boolean
  storage_path?: string
  attachment_id?: string
  error?: string
}

/**
 * Upload a single source PDF as evidence on a created maintenance_check.
 *
 * Called by MaximoPdfWizard after `commitMaximoPdfBundlesAction` returns
 * with check_ids. One call per (check_id, source PDF) — the wizard loops.
 *
 * Storage layout matches `uploadAttachmentAction`: `{tenant_id}/maintenance_check/{check_id}/{timestamp}_{name}`.
 * On DB-insert failure we compensate by removing the storage object so we
 * never leak orphan files.
 */
export async function attachMaximoPdfEvidenceAction(
  checkId: string,
  formData: FormData,
): Promise<EvidenceUploadResult> {
  const { supabase, user, tenantId, role } = await requireUser()
  if (!canWrite(role)) return { success: false, error: 'Insufficient permissions.' }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: 'No file provided.' }
  }
  if (file.size > EVIDENCE_MAX_BYTES) {
    return {
      success: false,
      error: `File exceeds ${Math.round(EVIDENCE_MAX_BYTES / 1024 / 1024)} MB limit.`,
    }
  }
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    return { success: false, error: `File "${file.name}" is not a PDF.` }
  }

  // Verify the check exists under the caller's tenant. RLS would block
  // unauthorized inserts too, but an explicit check yields a clearer error.
  const { data: check } = await supabase
    .from('maintenance_checks')
    .select('id')
    .eq('id', checkId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!check) {
    return { success: false, error: 'Maintenance check not found under this tenant.' }
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `${tenantId}/maintenance_check/${checkId}/${Date.now()}_${safeName}`

  const { error: uploadErr } = await supabase.storage
    .from('attachments')
    .upload(storagePath, file, { contentType: file.type || 'application/pdf', upsert: false })
  if (uploadErr) return { success: false, error: uploadErr.message }

  const { data: row, error: dbErr } = await supabase
    .from('attachments')
    .insert({
      tenant_id: tenantId,
      entity_type: 'maintenance_check',
      entity_id: checkId,
      attachment_type: 'evidence',
      file_name: file.name,
      file_size: file.size,
      content_type: file.type || 'application/pdf',
      storage_path: storagePath,
      uploaded_by: user.id,
    })
    .select('id')
    .single()

  if (dbErr || !row) {
    await supabase.storage.from('attachments').remove([storagePath])
    return { success: false, error: dbErr?.message ?? 'Failed to record attachment.' }
  }

  return { success: true, storage_path: storagePath, attachment_id: row.id }
}

// ── Main action ─────────────────────────────────────────────────────────

export async function commitMaximoPdfBundlesAction(
  rawPayload: unknown,
  mutationId?: string,
): Promise<MaximoCommitResult> {
  return withIdempotency<
    MaximoCommitSummary & { failures: MaximoCommitFailure[] }
  >(mutationId, async () => {
    const { supabase, tenantId, role, user } = await requireUser()
    if (!canWrite(role)) {
      return { success: false, error: 'Insufficient permissions.' }
    }

    const parsed = PayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid payload: ${parsed.error.issues[0]?.message ?? 'bad shape'}`,
      }
    }
    const { bundles, assigned_to: assignedTo = null } = parsed.data

    // ── Pre-resolve sites + plans + assets ────────────────────────────

    const siteCodes = Array.from(new Set(bundles.map((b) => b.maintenance_check.site_code)))
    const planCodes = Array.from(new Set(bundles.map((b) => b.maintenance_check.plan_code)))
    const externalIds = Array.from(
      new Set(
        bundles
          .flatMap((b) => b.check_assets)
          .map((a) => a.asset_external_id)
          .filter((x): x is string => x !== null && x.length > 0),
      ),
    )

    const [{ data: siteRows }, { data: planRows }] = await Promise.all([
      supabase
        .from('sites')
        .select('id, code, name')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .in('code', siteCodes),
      supabase
        .from('job_plans')
        .select('id, code, name')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .not('code', 'is', null),
    ])

    const siteById = new Map<string, { id: string; name: string }>()
    for (const s of siteRows ?? []) {
      if (s.code) siteById.set(s.code, { id: s.id, name: s.name })
    }

    // Plans are case-insensitively matched — Maximo PDFs sometimes print
    // codes in mixed case ("E1.8" vs "e1.8") and EQ is case-insensitive.
    const planByLower = new Map<string, { id: string; code: string; name: string }>()
    for (const p of planRows ?? []) {
      if (p.code) planByLower.set(p.code.toLowerCase(), { id: p.id, code: p.code, name: p.name })
    }

    // Asset resolution: exact match on `assets.maximo_id` first; fuzzy
    // fallback on `assets.name` for rows without an external id printed.
    const assetByExternalId = new Map<string, { id: string; name: string; siteId: string }>()
    if (externalIds.length > 0) {
      const { data: assetRows } = await supabase
        .from('assets')
        .select('id, name, site_id, maximo_id')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .in('maximo_id', externalIds)
      for (const a of assetRows ?? []) {
        if (a.maximo_id)
          assetByExternalId.set(a.maximo_id, { id: a.id, name: a.name, siteId: a.site_id })
      }
    }

    // ── Walk bundles, create rows ─────────────────────────────────────

    const summary: MaximoCommitSummary = {
      checks_created: 0,
      check_assets_created: 0,
      check_items_created: 0,
      bundles: [],
    }
    const failures: MaximoCommitFailure[] = []

    for (const bundle of bundles) {
      const mc = bundle.maintenance_check
      const site = siteById.get(mc.site_code)
      if (!site) {
        failures.push({
          group_key: bundle.group_key,
          reason: `Site code "${mc.site_code}" not found under this tenant. Pre-seed the site before retrying.`,
        })
        continue
      }

      const planLower = lowerOrNull(mc.plan_code)
      const plan = planLower ? planByLower.get(planLower) : null
      if (!plan) {
        failures.push({
          group_key: bundle.group_key,
          reason: `Maintenance plan code "${mc.plan_code}" not found under this tenant. Pre-seed the plan before retrying.`,
        })
        continue
      }

      // Resolve every asset in this bundle. Hard-fail on any miss — for
      // demo correctness, surface unresolved assets rather than partially
      // commit. Cards / EQ admin handles asset seeding.
      const resolvedAssetByRow: { row: typeof bundle.check_assets[number]; assetId: string }[] = []
      let assetMiss: { wo: string; reason: string } | null = null
      for (const a of bundle.check_assets) {
        if (!a.asset_external_id) {
          assetMiss = {
            wo: a.work_order_number,
            reason: `WO ${a.work_order_number} ("${a.asset_name}") has no Maximo asset ID — fuzzy name match not enabled in demo cut.`,
          }
          break
        }
        const hit = assetByExternalId.get(a.asset_external_id)
        if (!hit) {
          assetMiss = {
            wo: a.work_order_number,
            reason: `Asset external id "${a.asset_external_id}" not found under this tenant.`,
          }
          break
        }
        if (hit.siteId !== site.id) {
          assetMiss = {
            wo: a.work_order_number,
            reason: `Asset "${a.asset_external_id}" lives on a different site than ${mc.site_code}.`,
          }
          break
        }
        resolvedAssetByRow.push({ row: a, assetId: hit.id })
      }
      if (assetMiss) {
        failures.push({ group_key: bundle.group_key, reason: assetMiss.reason })
        continue
      }

      // Pull job_plan_items matching this plan + frequency for derived
      // check items. Empty result is fine — many plans don't yet have items.
      let itemRows: { id: string; description: string; sort_order: number; is_required: boolean }[] = []
      if (mc.frequency) {
        const col = freqColumn(mc.frequency)
        const { data: jpi } = await supabase
          .from('job_plan_items')
          .select('id, description, sort_order, is_required, ' + col)
          .eq('job_plan_id', plan.id)
          .eq('is_active', true)
          .eq(col, true)
          .order('sort_order', { ascending: true })
        itemRows = (jpi ?? []).map((r: unknown) => {
          const rec = r as Record<string, unknown>
          return {
            id: rec.id as string,
            description: rec.description as string,
            sort_order: rec.sort_order as number,
            is_required: rec.is_required as boolean,
          }
        })
      }

      const monthName = new Date(mc.due_date).toLocaleString('en-AU', { month: 'long' })
      const year = mc.due_date.slice(0, 4)
      const customName = `${site.name} — ${plan.name} — ${monthName} ${year} (Maximo PDF)`

      // 1. maintenance_checks
      const checkInsert: MaintenanceCheckInsert = {
        tenant_id: tenantId,
        site_id: site.id,
        job_plan_id: plan.id,
        frequency: mc.frequency,
        start_date: mc.start_date ?? mc.due_date,
        due_date: mc.due_date,
        custom_name: customName,
        status: mc.status === 'scheduled' ? 'scheduled' : 'scheduled',
        assigned_to: assignedTo ?? null,
      }
      const { data: check, error: checkErr } = await supabase
        .from('maintenance_checks')
        .insert(checkInsert)
        .select('id')
        .single()

      if (checkErr || !check) {
        failures.push({
          group_key: bundle.group_key,
          reason: checkErr?.message ?? 'Failed to create maintenance_check.',
        })
        continue
      }

      const rollback = async (reason: string): Promise<string> => {
        await supabase.from('maintenance_checks').delete().eq('id', check.id)
        return reason
      }

      // 2. check_assets
      const caRows: CheckAssetInsert[] = resolvedAssetByRow.map(({ row, assetId }) => ({
        tenant_id: tenantId,
        check_id: check.id,
        asset_id: assetId,
        status: 'pending',
        work_order_number: row.work_order_number,
        priority: row.priority,
        work_type: row.work_type,
        crew_id: row.crew_id,
        target_start: row.target_start,
        target_finish: row.target_finish,
        failure_code: row.failure_code,
        problem: row.problem,
        cause: row.cause,
        remedy: row.remedy,
        classification: row.classification,
        ir_scan_result: row.ir_scan_result,
      }))

      const { data: insertedCA, error: caErr } = await supabase
        .from('check_assets')
        .insert(caRows)
        .select('id, asset_id')
      if (caErr || !insertedCA) {
        const reason = await rollback(caErr?.message ?? 'Failed to insert check_assets.')
        failures.push({ group_key: bundle.group_key, reason })
        continue
      }

      // 3. maintenance_check_items (one per (check_asset × job_plan_item))
      let itemsInsertedCount = 0
      let itemsAborted = false
      if (itemRows.length > 0) {
        const itemInserts = insertedCA.flatMap((ca) =>
          itemRows.map((it) => ({
            tenant_id: tenantId,
            check_id: check.id,
            check_asset_id: ca.id,
            job_plan_item_id: it.id,
            asset_id: ca.asset_id,
            description: it.description,
            sort_order: it.sort_order,
            is_required: it.is_required,
          })),
        )
        for (let i = 0; i < itemInserts.length; i += 500) {
          const batch = itemInserts.slice(i, i + 500)
          const { error: itErr } = await supabase.from('maintenance_check_items').insert(batch)
          if (itErr) {
            const reason = await rollback(itErr.message)
            failures.push({ group_key: bundle.group_key, reason })
            itemsAborted = true
            break
          }
          itemsInsertedCount += batch.length
        }
      }
      if (itemsAborted) continue

      summary.checks_created += 1
      summary.check_assets_created += insertedCA.length
      summary.check_items_created += itemsInsertedCount
      summary.bundles.push({
        group_key: bundle.group_key,
        check_id: check.id,
        site_code: mc.site_code,
        plan_code: mc.plan_code,
        assets_created: insertedCA.length,
        items_created: itemsInsertedCount,
      })
    }

    // Audit + revalidate only when something landed; pure-failure runs
    // don't touch DB, so no need to write an audit row for them.
    if (summary.checks_created > 0) {
      await logAuditEvent({
        action: 'create',
        entityType: 'maintenance_check',
        entityId: summary.bundles[0]?.check_id ?? 'maximo-pdf-import',
        summary: `Imported ${summary.checks_created} maintenance check(s) from Maximo PDFs (${summary.check_assets_created} WOs, ${summary.check_items_created} items)`,
        mutationId,
      })
      revalidatePath('/maintenance')
      revalidatePath('/maintenance/import')
      revalidatePath('/calendar')
    }

    await trackServer(user.id, 'maximo_pdf_committed', {
      tenant_id: tenantId,
      checks_created: summary.checks_created,
      check_assets_created: summary.check_assets_created,
      check_items_created: summary.check_items_created,
      bundles_attempted: bundles.length,
      failure_count: failures.length,
    })

    return {
      success: true,
      data: { ...summary, failures },
    }
  })
}
