/**
 * EQ Solves Service
 * © 2026 EQ, a registered business name of CDC Solutions Pty Ltd
 * Proprietary and confidential.
 *
 * Admin hub. Lands at /admin and surfaces the six admin tools as a card
 * grid: Users · Tenant Settings · Media Library · Report Settings ·
 * Archive · Audit Log. Replaces the flat 9-link Admin block that used
 * to live in the sidebar (the commercial tools — renewal pack, scope
 * import, scope derive — moved out to /commercials in the same PR).
 *
 * No hard role gate at the page level — matches existing /admin/*
 * behaviour where the sidebar entry is admin-only but the URLs are
 * reachable by anyone signed in. Mutating actions on each sub-page
 * still gate role server-side.
 */
import Link from 'next/link'
import { Breadcrumb } from '@/components/ui/Breadcrumb'
import { Users, Settings, Image, FileText, Archive, ScrollText, Upload, Download, ShieldCheck, Sparkles } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type AdminCard = {
  label: string
  href: string
  description: string
  icon: typeof Users
}

const ADMIN_CARDS: AdminCard[] = [
  {
    label: 'Users',
    href: '/admin/users',
    description: 'Invite users, manage roles, deactivate accounts.',
    icon: Users,
  },
  {
    label: 'Workspace Settings',
    href: '/admin/settings',
    description: 'Branding, colours, logos, and how the app behaves.',
    icon: Settings,
  },
  {
    label: 'Media Library',
    href: '/admin/media',
    description: 'Workspace logos, site photos, and brand assets.',
    icon: Image,
  },
  {
    label: 'Report Settings',
    href: '/admin/reports',
    description: 'Customer report templates, sections, sign-off fields.',
    icon: FileText,
  },
  {
    label: 'Archive',
    href: '/admin/archive',
    description: 'Removed records — restore them or remove for good.',
    icon: Archive,
  },
  {
    label: 'Audit Log',
    href: '/audit-log',
    description: 'Every change — who, what, when. Filter by record type.',
    icon: ScrollText,
  },
  {
    label: 'Imports',
    href: '/admin/imports',
    description: 'All import flows in one place — work orders, ACB, RCD, scope.',
    icon: Upload,
  },
  {
    label: 'Backup',
    href: '/admin/backup',
    description: 'Download a workspace snapshot, or preview a backup file.',
    icon: Download,
  },
]

// ---------------------------------------------------------------------------
// Alert badge colours per severity
// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-50 text-red-700 border-red-200',
  warning:  'bg-amber-50 text-amber-700 border-amber-200',
  info:     'bg-sky-50 text-sky-700 border-sky-200',
}

// ---------------------------------------------------------------------------
// Quality hub data shape returned by eq_quality_open_alerts RPC
// ---------------------------------------------------------------------------

interface AlertRow {
  id:          string
  alert_type:  string
  entity_type: string | null
  entity_id:   string | null
  message:     string
  severity:    'info' | 'warning' | 'critical'
  created_at:  string
}

interface AlertCounts {
  critical: number
  warning:  number
  info:     number
  total:    number
}

async function getOpenAlertCounts(): Promise<AlertCounts | null> {
  try {
    const supabase = await createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('eq_quality_open_alerts')
    if (error || !data) return null

    const alerts = data as unknown as AlertRow[]
    return alerts.reduce<AlertCounts>(
      (acc, a) => {
        acc.total++
        acc[a.severity]++
        return acc
      },
      { critical: 0, warning: 0, info: 0, total: 0 },
    )
  } catch {
    return null
  }
}

export default async function AdminHubPage() {
  const alertCounts = await getOpenAlertCounts()

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumb items={[{ label: 'Home', href: '/dashboard' }, { label: 'Admin' }]} />
        <h1 className="text-2xl font-bold text-eq-ink mt-2">Admin</h1>
        <p className="text-sm text-eq-grey mt-1">
          Manage users, branding, archive, and audit history.
        </p>
      </div>

      {/* Quality tools section */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-eq-grey mb-3">
          Data quality
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

          {/* Data Health card — shows live alert counts */}
          <Link
            href="/admin/quality"
            className="group flex flex-col gap-2 p-5 bg-white border border-eq-line rounded-xl hover:border-eq-sky transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-eq-ice flex items-center justify-center text-eq-deep group-hover:bg-eq-sky group-hover:text-white transition-colors">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-eq-ink">Data Health</span>
              {alertCounts && alertCounts.total > 0 && (
                <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full border ${
                  alertCounts.critical > 0
                    ? SEVERITY_STYLES.critical
                    : alertCounts.warning > 0
                    ? SEVERITY_STYLES.warning
                    : SEVERITY_STYLES.info
                }`}>
                  {alertCounts.total} open
                </span>
              )}
            </div>
            <p className="text-xs text-eq-grey">
              Open alerts by severity, completeness scores, and licence expiry warnings.
            </p>
            {alertCounts && alertCounts.total > 0 && (
              <div className="flex gap-2 mt-1">
                {alertCounts.critical > 0 && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLES.critical}`}>
                    {alertCounts.critical} critical
                  </span>
                )}
                {alertCounts.warning > 0 && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLES.warning}`}>
                    {alertCounts.warning} warning
                  </span>
                )}
                {alertCounts.info > 0 && (
                  <span className={`text-[11px] px-1.5 py-0.5 rounded border ${SEVERITY_STYLES.info}`}>
                    {alertCounts.info} info
                  </span>
                )}
              </div>
            )}
          </Link>

          {/* Tidy Our Data card */}
          <Link
            href="/admin/tidy"
            className="group flex flex-col gap-2 p-5 bg-white border border-eq-line rounded-xl hover:border-eq-sky transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-eq-ice flex items-center justify-center text-eq-deep group-hover:bg-eq-sky group-hover:text-white transition-colors">
                <Sparkles className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-eq-ink">Tidy Our Data</span>
            </div>
            <p className="text-xs text-eq-grey">
              Auto-fix normalisation issues, surface gaps, and check for orphaned records.
            </p>
          </Link>

        </div>
      </div>

      {/* General admin tools section */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-eq-grey mb-3">
          Workspace
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {ADMIN_CARDS.map(({ label, href, description, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex flex-col gap-2 p-5 bg-white border border-eq-line rounded-xl hover:border-eq-sky transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-md bg-eq-ice flex items-center justify-center text-eq-deep group-hover:bg-eq-sky group-hover:text-white transition-colors">
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-sm font-semibold text-eq-ink">{label}</span>
              </div>
              <p className="text-xs text-eq-grey">{description}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
