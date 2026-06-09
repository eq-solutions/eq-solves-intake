'use client'

/**
 * QualityClient — interactive data health hub.
 *
 * States:
 *   loading   — fetching alerts + health scores
 *   ready     — data displayed; resolve buttons active
 *   error     — load failed
 */

import { useState, useEffect, useTransition } from 'react'
import { getOpenAlertsAction, resolveAlertAction, getHealthScoresAction } from './actions'
import type { QualityAlert } from './actions'
import type { HealthScore } from '@eq/intake'
import { ShieldCheck, ShieldAlert, CheckCircle2, RefreshCw, AlertCircle } from 'lucide-react'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning:  'Warning',
  info:     'Info',
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-50 text-red-700 border border-red-200',
  warning:  'bg-amber-50 text-amber-700 border border-amber-200',
  info:     'bg-sky-50 text-sky-700 border border-sky-200',
}

const SEVERITY_ROW_ACCENT: Record<string, string> = {
  critical: 'border-l-2 border-l-red-400',
  warning:  'border-l-2 border-l-amber-400',
  info:     'border-l-2 border-l-sky-400',
}

const ALERT_TYPE_LABEL: Record<string, string> = {
  licence_expiry: 'Licence expiry',
  orphan:         'Orphaned record',
  health_gap:     'Data gap',
}

const ENTITY_LABEL: Record<string, string> = {
  customers: 'Customers',
  sites:     'Sites',
  contacts:  'Contacts',
  staff:     'Staff',
  assets:    'Assets',
}

// ---------------------------------------------------------------------------
// Health score bar
// ---------------------------------------------------------------------------

function ScoreBar({ score, entity, total, complete, gaps }: HealthScore) {
  const pct  = Math.round(score * 100)
  const fill =
    pct >= 90 ? 'bg-emerald-400' :
    pct >= 70 ? 'bg-amber-400'   : 'bg-red-400'

  return (
    <div className="flex flex-col gap-1.5 py-3 border-b border-eq-line last:border-b-0">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-eq-ink">{ENTITY_LABEL[entity] ?? entity}</span>
        <span className="tabular-nums text-eq-grey text-xs">
          {complete} / {total} complete &mdash; <span className="font-semibold text-eq-ink">{pct}%</span>
        </span>
      </div>
      <div className="h-2 bg-eq-line rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      {gaps.length > 0 && (
        <p className="text-[11px] text-eq-grey">
          Most gaps in: {gaps.map((g: string) => <code key={g} className="font-mono bg-eq-ice/80 px-1 py-0.5 rounded text-[10px] mr-1">{g}</code>)}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function QualityClient() {
  const [alerts,      setAlerts]      = useState<QualityAlert[] | null>(null)
  const [scores,      setScores]      = useState<HealthScore[]  | null>(null)
  const [loadError,   setLoadError]   = useState<string | null>(null)
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set())
  const [isPending,   startTransition] = useTransition()

  // Load on mount
  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoadError(null)

    const [alertRes, scoreRes] = await Promise.all([
      getOpenAlertsAction(),
      getHealthScoresAction(),
    ])

    if (!alertRes.ok) {
      setLoadError(alertRes.error)
      return
    }
    if (!scoreRes.ok) {
      setLoadError(scoreRes.error)
      return
    }

    setAlerts(alertRes.alerts)
    setScores(scoreRes.scores)
  }

  function handleResolve(alertId: string) {
    startTransition(async () => {
      const res = await resolveAlertAction(alertId)
      if (res.ok && res.resolved) {
        setResolvedIds((prev) => new Set([...prev, alertId]))
      }
    })
  }

  const visibleAlerts = (alerts ?? []).filter((a) => !resolvedIds.has(a.id))

  // Group by severity for the summary row
  const counts = visibleAlerts.reduce(
    (acc, a) => { acc[a.severity] = (acc[a.severity] ?? 0) + 1; return acc },
    {} as Record<string, number>,
  )

  // ---------------------------------------------------------------------------
  // Render: loading
  // ---------------------------------------------------------------------------

  if (alerts === null && scores === null && !loadError) {
    return (
      <div className="py-16 text-center text-sm text-eq-grey">
        <RefreshCw className="w-6 h-6 mx-auto mb-3 animate-spin text-eq-deep" />
        Loading quality data…
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render: error
  // ---------------------------------------------------------------------------

  if (loadError) {
    return (
      <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Could not load quality data</p>
          <p className="mt-0.5 opacity-80">{loadError}</p>
          <button
            className="mt-2 underline underline-offset-2 text-xs"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render: ready
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">

      {/* Alert summary strip */}
      {visibleAlerts.length > 0 ? (
        <div className="grid grid-cols-3 gap-3">
          {(['critical', 'warning', 'info'] as const).map((sev) => (
            <div key={sev} className={`rounded-xl px-4 py-3 ${SEVERITY_BADGE[sev]}`}>
              <div className="text-2xl font-bold tabular-nums">{counts[sev] ?? 0}</div>
              <div className="text-xs mt-0.5 opacity-75">{SEVERITY_LABEL[sev]}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-emerald-700 text-sm">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>No open alerts — your data is clean.</span>
        </div>
      )}

      {/* Open alerts table */}
      {visibleAlerts.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-eq-ink mb-3">Open alerts</h2>
          <div className="border border-eq-line rounded-xl overflow-hidden">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-eq-grey border-b border-eq-line bg-eq-ice/40">
                  <th className="py-2.5 pl-4 pr-3">Severity</th>
                  <th className="py-2.5 pr-3">Type</th>
                  <th className="py-2.5 pr-3">Entity</th>
                  <th className="py-2.5 pr-3">Message</th>
                  <th className="py-2.5 pr-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleAlerts.map((alert) => (
                  <tr
                    key={alert.id}
                    className={`border-b border-eq-line/60 last:border-b-0 hover:bg-eq-ice/20 ${SEVERITY_ROW_ACCENT[alert.severity] ?? ''}`}
                  >
                    <td className="pl-4 py-2.5 pr-3">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${SEVERITY_BADGE[alert.severity]}`}>
                        {SEVERITY_LABEL[alert.severity]}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-eq-deep font-medium whitespace-nowrap">
                      {ALERT_TYPE_LABEL[alert.alert_type] ?? alert.alert_type}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-eq-grey">
                      {alert.entity_type ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-eq-ink max-w-xs truncate">
                      {alert.message}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <button
                        className="text-xs text-eq-deep underline underline-offset-2 hover:text-eq-sky disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={isPending}
                        onClick={() => handleResolve(alert.id)}
                      >
                        Resolve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Health scores */}
      {scores && scores.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-eq-ink mb-3">Data completeness</h2>
          <div className="bg-white border border-eq-line rounded-xl px-4">
            {scores.map((s) => (
              <ScoreBar key={s.entity} {...s} />
            ))}
          </div>
        </div>
      )}

      {/* Reload */}
      <div className="flex justify-end">
        <button
          className="flex items-center gap-2 text-xs text-eq-grey hover:text-eq-deep transition-colors"
          onClick={() => void load()}
          disabled={isPending}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>
    </div>
  )
}
