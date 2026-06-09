/**
 * EQ Solves Service
 * © 2026 EQ, a registered business name of CDC Solutions Pty Ltd
 * Proprietary and confidential.
 *
 * /admin/quality — "Data Health"
 *
 * Shows open quality alerts (licence expiry, orphaned records, data gaps)
 * and per-entity completeness scores. Admins can resolve alerts individually.
 *
 * Alerts are raised automatically by the quality-guardian edge function
 * (nightly) or can be triggered manually. Health scores are computed live
 * on page load.
 */

import { Breadcrumb } from '@/components/ui/Breadcrumb'
import { requireUser } from '@/lib/actions/auth'
import { isAdmin } from '@/lib/utils/roles'
import { redirect } from 'next/navigation'
import { QualityClient } from './QualityClient'
import { ShieldCheck } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function QualityPage() {
  const { role } = await requireUser()

  if (!isAdmin(role)) {
    redirect('/admin')
  }

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumb items={[
          { label: 'Home',  href: '/dashboard' },
          { label: 'Admin', href: '/admin' },
          { label: 'Data Health' },
        ]} />
        <div className="flex items-center gap-3 mt-2">
          <div className="w-9 h-9 rounded-md bg-eq-ice flex items-center justify-center text-eq-deep">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-eq-ink">Data Health</h1>
            <p className="text-sm text-eq-grey mt-0.5">
              Open alerts, licence expiry warnings, and completeness scores across your canonical data.
            </p>
          </div>
        </div>
      </div>

      {/* What this covers */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        {[
          {
            title:  'Licence expiry',
            colour: 'border-red-200 bg-red-50/60',
            body:   'Licences expiring within 60 days — critical at 14 days, warning at 30.',
          },
          {
            title:  'Data completeness',
            colour: 'border-eq-sky/30 bg-eq-ice/60',
            body:   'Required fields missing across staff, sites, assets, customers, and contacts.',
          },
          {
            title:  'Orphaned records',
            colour: 'border-amber-200 bg-amber-50/60',
            body:   'Assets without sites, contacts without parents, licences without staff.',
          },
        ].map(({ title, colour, body }) => (
          <div
            key={title}
            className={`rounded-xl border px-4 py-3 ${colour}`}
          >
            <p className="text-xs font-semibold text-eq-ink mb-1">{title}</p>
            <p className="text-xs text-eq-grey leading-relaxed">{body}</p>
          </div>
        ))}
      </div>

      {/* Interactive hub */}
      <QualityClient />
    </div>
  )
}
