'use client'

/**
 * Client-side tab switcher for the maintenance import page.
 *
 * Two parallel intake flows live side by side:
 *   - Spreadsheet (xlsx) — the existing Equinix Delta monthly export path.
 *   - Maximo PDF — ad-hoc / mid-cycle WO additions emailed as PDFs.
 *
 * Default tab is xlsx so existing muscle memory is preserved. State is
 * client-only; no URL param yet because the two flows share no params and
 * jumping mid-flow would lose staged files.
 */

import { useState } from 'react'
import { FileSpreadsheet, FileText } from 'lucide-react'
import { ImportWizard } from './ImportWizard'
import { MaximoPdfWizard } from './MaximoPdfWizard'

type TabId = 'xlsx' | 'maximo-pdf'

export function ImportTabs() {
  const [tab, setTab] = useState<TabId>('xlsx')

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-2 border-b border-eq-ice">
        <TabButton
          active={tab === 'xlsx'}
          onClick={() => setTab('xlsx')}
          icon={<FileSpreadsheet className="h-4 w-4" aria-hidden="true" />}
          label="Spreadsheet"
          sub="Equinix monthly Delta xlsx"
        />
        <TabButton
          active={tab === 'maximo-pdf'}
          onClick={() => setTab('maximo-pdf')}
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
          label="Maximo PDF"
          sub="Ad-hoc WO PDFs (vision)"
        />
      </div>

      <div role="tabpanel">
        {tab === 'xlsx' ? <ImportWizard /> : <MaximoPdfWizard />}
      </div>
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  sub: string
}

function TabButton({ active, onClick, icon, label, sub }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'group flex flex-col items-start gap-0.5 border-b-2 px-3 py-2 text-left',
        active
          ? 'border-eq-sky text-eq-deep'
          : 'border-transparent text-eq-grey hover:border-eq-ice hover:text-eq-deep',
      ].join(' ')}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {label}
      </span>
      <span className="text-[11px] font-normal text-eq-grey">{sub}</span>
    </button>
  )
}
