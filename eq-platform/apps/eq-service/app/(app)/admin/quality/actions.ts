'use server'

/**
 * Server actions for the quality hub (/admin/quality).
 *
 * getOpenAlertsAction   — returns open alerts for the current tenant
 * resolveAlertAction    — marks a single alert resolved
 * getHealthScoresAction — computes current health scores
 */

import { requireUser } from '@/lib/actions/auth'
import { isAdmin } from '@/lib/utils/roles'
import { computeHealthScores } from '@eq/intake'
import type { HealthScore } from '@eq/intake'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityAlert {
  id:          string
  alert_type:  string
  entity_type: string | null
  entity_id:   string | null
  message:     string
  severity:    'info' | 'warning' | 'critical'
  created_at:  string
}

export interface GetAlertsResult {
  ok:     true
  alerts: QualityAlert[]
}
export interface GetAlertsError {
  ok:    false
  error: string
}

export interface ResolveResult {
  ok:       true
  resolved: boolean
}
export interface ResolveError {
  ok:    false
  error: string
}

export interface HealthScoresResult {
  ok:     true
  scores: HealthScore[]
}
export interface HealthScoresError {
  ok:    false
  error: string
}

// ---------------------------------------------------------------------------
// getOpenAlertsAction
// ---------------------------------------------------------------------------

export async function getOpenAlertsAction(): Promise<GetAlertsResult | GetAlertsError> {
  const { supabase, role } = await requireUser()

  if (!isAdmin(role)) {
    return { ok: false, error: 'Admin access required.' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('eq_quality_open_alerts')

  if (error) {
    return { ok: false, error: `Failed to load alerts: ${error.message}` }
  }

  return { ok: true, alerts: (data as unknown as QualityAlert[] | null) ?? [] }
}

// ---------------------------------------------------------------------------
// resolveAlertAction
// ---------------------------------------------------------------------------

export async function resolveAlertAction(alertId: string): Promise<ResolveResult | ResolveError> {
  const { supabase, role } = await requireUser()

  if (!isAdmin(role)) {
    return { ok: false, error: 'Admin access required.' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('eq_quality_resolve_alert', {
    p_alert_id: alertId,
  })

  if (error) {
    return { ok: false, error: `Failed to resolve alert: ${error.message}` }
  }

  const result = data as unknown as { resolved: boolean } | null
  return { ok: true, resolved: result?.resolved ?? false }
}

// ---------------------------------------------------------------------------
// getHealthScoresAction
// ---------------------------------------------------------------------------

export async function getHealthScoresAction(): Promise<HealthScoresResult | HealthScoresError> {
  const { supabase, role } = await requireUser()

  if (!isAdmin(role)) {
    return { ok: false, error: 'Admin access required.' }
  }

  try {
    const scores = await computeHealthScores(
      supabase as unknown as Parameters<typeof computeHealthScores>[0],
    )
    return { ok: true, scores }
  } catch (e) {
    return {
      ok:    false,
      error: `Health score computation failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
