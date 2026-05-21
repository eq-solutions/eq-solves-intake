'use client'

/**
 * Maximo PDF intake wizard.
 *
 * Sibling to the xlsx `ImportWizard`. Accepts up to 4 IBM Maximo work-order
 * PDFs (the shape Equinix emails — sometimes text-extractable, often
 * scanned), runs the `maximo-pdf-wo` skill server-side via Claude vision,
 * and surfaces the resulting `MaintenanceCheckBundle[]` for a human
 * confirmation step before commit.
 *
 * Phase 1 here = drop + parse + show bundle summary + per-asset table.
 * Phase 2 will layer inline edits onto the same component.
 * Phase 3 will wire the Commit-all button to the canonical commit path.
 *
 * Live AI is mandatory in production. The provider is constructed
 * server-side in `app/api/parse-maximo-pdf/route.ts`; the browser never
 * sees the Anthropic key.
 */

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, FileText, Loader2, AlertTriangle, X, CheckCircle2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type {
  MaximoPdfWoResult,
  MaintenanceCheckBundle,
  SkillWarning,
} from '@eq/intake'
import {
  commitMaximoPdfBundlesAction,
  attachMaximoPdfEvidenceAction,
  type MaximoCommitSummary,
  type MaximoCommitFailure,
} from './commit-maximo'

interface EvidenceUploadOutcome {
  check_id: string
  group_key: string
  attempted: number
  succeeded: number
  failures: { file_name: string; error: string }[]
}

const MAX_FILES = 4
const MAX_FILE_MB = 25

interface StagedFile {
  id: string
  file: File
  sizeMb: number
}

type ParseStatus = 'idle' | 'parsing' | 'done' | 'error'

interface ParseError {
  message: string
  detail?: string
}

export function MaximoPdfWizard() {
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [files, setFiles] = useState<StagedFile[]>([])
  const [status, setStatus] = useState<ParseStatus>('idle')
  const [result, setResult] = useState<MaximoPdfWoResult | null>(null)
  const [error, setError] = useState<ParseError | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [discarded, setDiscarded] = useState<Set<string>>(new Set())
  const [commitState, setCommitState] = useState<
    | { phase: 'idle' }
    | { phase: 'committing' }
    | { phase: 'attaching'; summary: MaximoCommitSummary & { failures: MaximoCommitFailure[] } }
    | {
        phase: 'success'
        summary: MaximoCommitSummary & { failures: MaximoCommitFailure[] }
        evidence: EvidenceUploadOutcome[]
      }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' })
  const [, startCommit] = useTransition()

  function addFiles(picked: FileList | File[] | null) {
    if (!picked) return
    setError(null)
    setResult(null)
    setStatus('idle')
    const incoming: StagedFile[] = []
    for (const f of Array.from(picked)) {
      if (!f.name.toLowerCase().endsWith('.pdf') && !f.type.includes('pdf')) continue
      incoming.push({
        id: crypto.randomUUID(),
        file: f,
        sizeMb: f.size / 1024 / 1024,
      })
    }
    setFiles((prev) => {
      const merged = [...prev, ...incoming]
      return merged.slice(0, MAX_FILES)
    })
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
    setError(null)
    setResult(null)
    setStatus('idle')
  }

  function clearAll() {
    setFiles([])
    setResult(null)
    setError(null)
    setStatus('idle')
    setElapsedMs(null)
    setDiscarded(new Set())
    setCommitState({ phase: 'idle' })
    if (inputRef.current) inputRef.current.value = ''
  }

  function toggleDiscard(groupKey: string) {
    setDiscarded((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  function commitAll() {
    if (!result) return
    const keep = result.bundles.filter((b) => !discarded.has(b.group_key))
    if (keep.length === 0) {
      setCommitState({ phase: 'error', message: 'No bundles to commit — all were discarded.' })
      return
    }
    setCommitState({ phase: 'committing' })
    startCommit(async () => {
      try {
        const res = await commitMaximoPdfBundlesAction(
          { bundles: keep },
          crypto.randomUUID(),
        )
        if (!res.success) {
          setCommitState({ phase: 'error', message: res.error })
          return
        }

        // Phase 3.1 — attach source PDFs as evidence on each created check.
        // Best-effort: failures are surfaced in the summary view but don't
        // undo the commit. Audit story is the goal; perfect uploads aren't.
        setCommitState({ phase: 'attaching', summary: res.data })
        const fileByName = new Map<string, File>()
        for (const f of files) fileByName.set(f.file.name, f.file)

        const sourceFilesByGroup = new Map<string, Set<string>>()
        for (const b of result.bundles) {
          const names = new Set<string>()
          for (const a of b.check_assets) {
            if (a.source.file_name) names.add(a.source.file_name)
          }
          sourceFilesByGroup.set(b.group_key, names)
        }

        const evidence: EvidenceUploadOutcome[] = []
        for (const cb of res.data.bundles) {
          const sourceNames = sourceFilesByGroup.get(cb.group_key) ?? new Set<string>()
          const outcome: EvidenceUploadOutcome = {
            check_id: cb.check_id,
            group_key: cb.group_key,
            attempted: sourceNames.size,
            succeeded: 0,
            failures: [],
          }
          for (const name of sourceNames) {
            const blob = fileByName.get(name)
            if (!blob) {
              outcome.failures.push({ file_name: name, error: 'Source file not in local state.' })
              continue
            }
            const fd = new FormData()
            fd.append('file', blob, name)
            try {
              const up = await attachMaximoPdfEvidenceAction(cb.check_id, fd)
              if (up.success) outcome.succeeded += 1
              else outcome.failures.push({ file_name: name, error: up.error ?? 'unknown' })
            } catch (e: unknown) {
              outcome.failures.push({ file_name: name, error: (e as Error).message })
            }
          }
          evidence.push(outcome)
        }

        setCommitState({ phase: 'success', summary: res.data, evidence })
        router.refresh()
      } catch (e: unknown) {
        setCommitState({
          phase: 'error',
          message: (e as Error).message || 'Commit failed.',
        })
      }
    })
  }

  async function parseAll() {
    if (files.length === 0) return
    setStatus('parsing')
    setError(null)
    setResult(null)
    const startedAt = Date.now()

    const formData = new FormData()
    for (const f of files) formData.append('files', f.file)

    try {
      const res = await fetch('/api/parse-maximo-pdf', {
        method: 'POST',
        body: formData,
      })
      const elapsed = Date.now() - startedAt
      setElapsedMs(elapsed)

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
        setError({
          message: body.error ?? `Parse failed with HTTP ${res.status}.`,
          detail: body.detail,
        })
        setStatus('error')
        return
      }
      const data = (await res.json()) as MaximoPdfWoResult
      setResult(data)
      setStatus('done')
    } catch (e: unknown) {
      setElapsedMs(Date.now() - startedAt)
      setError({ message: (e as Error).message || 'Network error.' })
      setStatus('error')
    }
  }

  const oversizeFile = files.find((f) => f.sizeMb > MAX_FILE_MB)
  const tooMany = files.length > MAX_FILES
  const canParse = files.length > 0 && !oversizeFile && !tooMany && status !== 'parsing'

  return (
    <div className="space-y-6">
      {/* ── Drop / pick zone ──────────────────────────────────── */}
      <div
        className="rounded-md border-2 border-dashed border-eq-deep/30 bg-eq-ice/40 px-6 py-10 text-center"
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          e.preventDefault()
          addFiles(e.dataTransfer.files)
        }}
      >
        <Upload className="mx-auto h-10 w-10 text-eq-deep/60" aria-hidden="true" />
        <p className="mt-2 text-sm text-eq-ink">
          Drop up to <strong>{MAX_FILES}</strong> Equinix Maximo WO PDFs here, or
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={status === 'parsing'}
          >
            Choose PDFs
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            onChange={(e) => {
              addFiles(e.target.files)
              if (inputRef.current) inputRef.current.value = ''
            }}
          />
        </div>
        <p className="mt-3 text-xs text-eq-grey">
          Each PDF up to {MAX_FILE_MB} MB. Scanned PDFs are read by Claude vision —
          allow ~20-80 seconds per page.
        </p>
      </div>

      {/* ── Staged files ──────────────────────────────────── */}
      {files.length > 0 && (
        <ul className="divide-y divide-eq-ice rounded-md border border-eq-ice">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2 truncate">
                <FileText className="h-4 w-4 shrink-0 text-eq-deep" aria-hidden="true" />
                <span className="truncate font-medium text-eq-ink">{f.file.name}</span>
                <span className="shrink-0 text-xs text-eq-grey">
                  {f.sizeMb.toFixed(1)} MB
                </span>
                {f.sizeMb > MAX_FILE_MB && (
                  <span className="shrink-0 text-xs font-semibold text-red-600">
                    Too large
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                className="rounded p-1 text-eq-grey hover:bg-eq-ice hover:text-red-600"
                disabled={status === 'parsing'}
                aria-label={`Remove ${f.file.name}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Action bar ──────────────────────────────────── */}
      {files.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <Button variant="secondary" type="button" onClick={clearAll} disabled={status === 'parsing'}>
            Clear
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={parseAll}
            disabled={!canParse}
            loading={status === 'parsing'}
          >
            {status === 'parsing' ? 'Parsing…' : `Parse ${files.length} PDF${files.length > 1 ? 's' : ''}`}
          </Button>
        </div>
      )}

      {/* ── Progress hint ──────────────────────────────────── */}
      {status === 'parsing' && (
        <div className="flex items-start gap-3 rounded-md border border-eq-sky/30 bg-eq-ice/50 p-4 text-sm text-eq-ink">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-eq-deep" aria-hidden="true" />
          <div>
            <p className="font-medium">Reading {files.length} PDF{files.length > 1 ? 's' : ''} with Claude vision…</p>
            <p className="mt-1 text-xs text-eq-grey">
              ~20-80 seconds per PDF page. We process all PDFs in one pass; the request stays open
              until the server returns. Don't refresh.
            </p>
          </div>
        </div>
      )}

      {/* ── Error ──────────────────────────────────── */}
      {status === 'error' && error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {error.message}
          </p>
          {error.detail && <p className="mt-1 text-xs">{error.detail}</p>}
          {elapsedMs !== null && (
            <p className="mt-2 text-xs text-red-600/80">
              Failed after {(elapsedMs / 1000).toFixed(1)}s.
            </p>
          )}
        </div>
      )}

      {/* ── Result summary ──────────────────────────────────── */}
      {status === 'done' && result && commitState.phase !== 'success' && (
        <ParseResults
          result={result}
          elapsedMs={elapsedMs ?? 0}
          discarded={discarded}
          onToggleDiscard={toggleDiscard}
          onCommit={commitAll}
          commitPhase={commitState.phase === 'attaching' ? 'committing' : commitState.phase}
          commitError={commitState.phase === 'error' ? commitState.message : null}
        />
      )}

      {/* ── Attaching evidence ──────────────────────────────────── */}
      {commitState.phase === 'attaching' && (
        <div className="flex items-start gap-3 rounded-md border border-eq-sky/30 bg-eq-ice/50 p-4 text-sm text-eq-ink">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-eq-deep" aria-hidden="true" />
          <p>Attaching source PDFs to each created check as evidence…</p>
        </div>
      )}

      {/* ── Commit success ──────────────────────────────────── */}
      {commitState.phase === 'success' && (
        <CommitSummaryView
          summary={commitState.summary}
          evidence={commitState.evidence}
          onReset={clearAll}
        />
      )}
    </div>
  )
}

// ── Result display ─────────────────────────────────────────────────────

interface ParseResultsProps {
  result: MaximoPdfWoResult
  elapsedMs: number
  discarded: Set<string>
  onToggleDiscard: (groupKey: string) => void
  onCommit: () => void
  commitPhase: 'idle' | 'committing' | 'success' | 'error'
  commitError: string | null
}

function ParseResults({
  result,
  elapsedMs,
  discarded,
  onToggleDiscard,
  onCommit,
  commitPhase,
  commitError,
}: ParseResultsProps) {
  const totalAssets = useMemo(
    () => result.bundles.reduce((sum, b) => sum + b.check_assets.length, 0),
    [result.bundles],
  )
  const liveBundles = result.bundles.filter((b) => !discarded.has(b.group_key))
  const liveAssets = liveBundles.reduce((sum, b) => sum + b.check_assets.length, 0)
  const isCommitting = commitPhase === 'committing'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        <span>
          Parsed <strong>{result.sources.length}</strong> PDF
          {result.sources.length > 1 ? 's' : ''} into{' '}
          <strong>{result.bundles.length}</strong> maintenance bundle
          {result.bundles.length !== 1 ? 's' : ''} ({totalAssets} work order
          {totalAssets !== 1 ? 's' : ''}) in {(elapsedMs / 1000).toFixed(1)}s.
          {discarded.size > 0 && (
            <>
              {' '}— <strong>{discarded.size}</strong> bundle
              {discarded.size === 1 ? '' : 's'} discarded; {liveBundles.length} ready to commit (
              {liveAssets} WO{liveAssets === 1 ? '' : 's'}).
            </>
          )}
        </span>
      </div>

      {result.warnings.length > 0 && <WarningsList warnings={result.warnings} />}

      <ul className="space-y-3">
        {result.bundles.map((b) => (
          <BundleCard
            key={b.group_key}
            bundle={b}
            discarded={discarded.has(b.group_key)}
            onToggleDiscard={() => onToggleDiscard(b.group_key)}
            disabled={isCommitting}
          />
        ))}
      </ul>

      {commitError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Commit failed
          </p>
          <p className="mt-1 text-xs">{commitError}</p>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          type="button"
          onClick={onCommit}
          loading={isCommitting}
          disabled={liveBundles.length === 0 || isCommitting}
        >
          {isCommitting
            ? 'Creating maintenance checks…'
            : `Commit ${liveBundles.length} bundle${liveBundles.length === 1 ? '' : 's'} (${liveAssets} WO${liveAssets === 1 ? '' : 's'})`}
        </Button>
      </div>
    </div>
  )
}

function CommitSummaryView({
  summary,
  evidence,
  onReset,
}: {
  summary: MaximoCommitSummary & { failures: MaximoCommitFailure[] }
  evidence: EvidenceUploadOutcome[]
  onReset: () => void
}) {
  const allLanded = summary.failures.length === 0
  const totalEvidenceAttempted = evidence.reduce((s, o) => s + o.attempted, 0)
  const totalEvidenceSucceeded = evidence.reduce((s, o) => s + o.succeeded, 0)
  const evidenceFailures = evidence.flatMap((o) =>
    o.failures.map((f) => ({ check_id: o.check_id, ...f })),
  )
  return (
    <div className="space-y-4">
      <div
        className={[
          'rounded-md border p-4 text-sm',
          allLanded
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800',
        ].join(' ')}
      >
        <p className="flex items-center gap-2 font-semibold">
          {allLanded ? (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          )}
          {allLanded ? 'All bundles committed.' : 'Partial commit.'}
        </p>
        <p className="mt-1 text-xs">
          Created <strong>{summary.checks_created}</strong> maintenance check
          {summary.checks_created === 1 ? '' : 's'},{' '}
          <strong>{summary.check_assets_created}</strong> WO
          {summary.check_assets_created === 1 ? '' : 's'},{' '}
          <strong>{summary.check_items_created}</strong> per-asset task
          {summary.check_items_created === 1 ? '' : 's'}.
        </p>
      </div>

      {summary.bundles.length > 0 && (
        <ul className="rounded-md border border-eq-ice bg-white text-sm">
          {summary.bundles.map((b) => (
            <li
              key={b.group_key}
              className="flex items-center justify-between border-b border-eq-ice px-3 py-2 last:border-b-0"
            >
              <span className="text-eq-ink">
                {b.site_code} · {b.plan_code} — {b.assets_created} WO
                {b.assets_created === 1 ? '' : 's'}, {b.items_created} task
                {b.items_created === 1 ? '' : 's'}
              </span>
              <a
                href={`/maintenance/${b.check_id}`}
                className="text-xs font-medium text-eq-deep hover:underline"
              >
                Open check →
              </a>
            </li>
          ))}
        </ul>
      )}

      {summary.failures.length > 0 && (
        <details className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <summary className="cursor-pointer font-medium">
            {summary.failures.length} bundle{summary.failures.length === 1 ? '' : 's'} did not commit
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {summary.failures.map((f) => (
              <li key={f.group_key}>
                <span className="font-mono">{f.group_key}</span>: {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {totalEvidenceAttempted > 0 && (
        <div
          className={[
            'rounded-md border p-3 text-sm',
            evidenceFailures.length === 0
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800',
          ].join(' ')}
        >
          <p className="font-medium">
            Attached {totalEvidenceSucceeded} of {totalEvidenceAttempted} source PDF
            {totalEvidenceAttempted === 1 ? '' : 's'} as evidence on the created check
            {summary.checks_created === 1 ? '' : 's'}.
          </p>
          {evidenceFailures.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">{evidenceFailures.length} upload failure{evidenceFailures.length === 1 ? '' : 's'}</summary>
              <ul className="mt-1 space-y-1">
                {evidenceFailures.map((f, i) => (
                  <li key={i}>
                    <span className="font-mono">{f.file_name}</span> → {f.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="secondary" type="button" onClick={onReset}>
          Start another import
        </Button>
      </div>
    </div>
  )
}

function WarningsList({ warnings }: { warnings: SkillWarning[] }) {
  return (
    <details className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {warnings.length} parse warning{warnings.length > 1 ? 's' : ''}
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {warnings.map((w, i) => (
          <li key={i}>
            <span className="font-mono text-amber-900">[{w.code}]</span> {w.message}
          </li>
        ))}
      </ul>
    </details>
  )
}

interface BundleCardProps {
  bundle: MaintenanceCheckBundle
  discarded: boolean
  onToggleDiscard: () => void
  disabled: boolean
}

function BundleCard({ bundle, discarded, onToggleDiscard, disabled }: BundleCardProps) {
  const mc = bundle.maintenance_check
  return (
    <li
      className={[
        'rounded-md border bg-white p-4 transition-opacity',
        discarded ? 'border-red-200 opacity-60' : 'border-eq-ice',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-eq-ice pb-2">
        <div>
          <h3 className="text-base font-semibold text-eq-ink">
            {mc.site_code} · {mc.plan_code}{' '}
            {mc.plan_description && (
              <span className="text-sm font-normal text-eq-grey">— {mc.plan_description}</span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-eq-grey">
            Due {mc.due_date}
            {mc.frequency && <> · {mc.frequency}</>}
            {mc.maximo_wo_number && <> · WO {mc.maximo_wo_number}</>}
            <> · {bundle.check_assets.length} asset{bundle.check_assets.length !== 1 ? 's' : ''}</>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-eq-ice px-2 py-0.5 text-xs text-eq-deep">{mc.status}</span>
          <button
            type="button"
            onClick={onToggleDiscard}
            disabled={disabled}
            className={[
              'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
              discarded
                ? 'bg-eq-ice text-eq-deep hover:bg-eq-sky/20'
                : 'bg-red-50 text-red-600 hover:bg-red-100',
              disabled && 'cursor-not-allowed opacity-50',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {discarded ? 'Restore' : 'Discard'}
          </button>
        </div>
      </header>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-eq-grey">
            <tr>
              <th className="py-1 pr-3 font-medium">WO#</th>
              <th className="py-1 pr-3 font-medium">Asset</th>
              <th className="py-1 pr-3 font-medium">Type</th>
              <th className="py-1 pr-3 font-medium">Priority</th>
              <th className="py-1 pr-3 font-medium">Target start</th>
              <th className="py-1 pr-3 font-medium">Target finish</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eq-ice">
            {bundle.check_assets.map((a) => (
              <tr key={a.work_order_number} className="text-eq-ink">
                <td className="py-1 pr-3 font-mono">{a.work_order_number}</td>
                <td className="py-1 pr-3">
                  <span className="font-medium">{a.asset_external_id ?? '—'}</span>
                  <span className="ml-2 text-eq-grey">{a.asset_name}</span>
                </td>
                <td className="py-1 pr-3">{a.work_type ?? '—'}</td>
                <td className="py-1 pr-3">{a.priority ?? '—'}</td>
                <td className="py-1 pr-3">{a.target_start ?? '—'}</td>
                <td className="py-1 pr-3">{a.target_finish ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </li>
  )
}
