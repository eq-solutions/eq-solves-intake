/**
 * DestinationPicker — "Where's it going?" pill row.
 *
 * Replaces the old <select>-based picker (three <optgroup>s) with the flat
 * pill row from INTAKE-REDESIGN-SPEC.md §5.3 / the 2026-08-17 build spec's
 * state B1. Per the build spec's "drop join templates for v1"
 * recommendation, the rollup engine's BUILTIN_TEMPLATES (Xero/MYOB/SimPRO
 * join exports) don't get pills here — they'd crowd the two hero flows
 * (Into EQ, quick exports) this screen exists to make fast. The capability
 * isn't gone: it still has a full home in RollupDropZone (the Rollup tab),
 * which also supports user-built templates that a flat pill row couldn't
 * represent anyway.
 *
 * "Other…" (upload a sample list, match by column) is in the spec's copy
 * deck but has no engine behind it yet, so it renders disabled rather than
 * pretending to work.
 */

import type { JSX } from "react";
import type { IntakeBundle } from "./intake-bundle.js";
import { roleLabel } from "./intake-bundle.js";
import { QUICK_DESTINATIONS, type QuickDestination } from "../quick-export/destinations.js";
import type { RoleName } from "../rollup/roles.js";

export const INTO_EQ_ID = "into-eq";
/** Namespaces QUICK_DESTINATIONS ids so the picker's value is unambiguous. */
export const QUICK_PREFIX = "quick:";
const OTHER_ID = "other";

export interface DestOption {
  id: string;
  label: string;
  description: string;
  /** Roles this destination needs present in the dropped bundle. Empty = Into EQ (accepts any recognised file). */
  needsRoles: RoleName[];
}

export const INTO_EQ_OPTION: DestOption = {
  id: INTO_EQ_ID,
  label: "Into EQ",
  description:
    "Save these records into EQ — customers, sites and contacts in one place, so you don't retype them anywhere else.",
  needsRoles: [],
};

const QUICK_OPTIONS: DestOption[] = QUICK_DESTINATIONS.map((d) => ({
  id: `${QUICK_PREFIX}${d.id}`,
  label: d.label,
  description: d.description,
  needsRoles: [d.needsRole],
}));

export const ALL_OPTIONS: DestOption[] = [INTO_EQ_OPTION, ...QUICK_OPTIONS];

export function findQuickDestination(id: string): QuickDestination | undefined {
  return QUICK_DESTINATIONS.find((d) => `${QUICK_PREFIX}${d.id}` === id);
}

function destAvailable(opt: DestOption, bundle: IntakeBundle): boolean {
  if (opt.needsRoles.length === 0) return bundle.availableRoles.size > 0;
  return opt.needsRoles.every((r) => bundle.availableRoles.has(r));
}

function missingRoles(opt: DestOption, bundle: IntakeBundle): RoleName[] {
  return opt.needsRoles.filter((r) => !bundle.availableRoles.has(r));
}

export interface DestinationPickerProps {
  destId: string;
  bundle: IntakeBundle;
  onChange: (id: string) => void;
}

export function DestinationPicker({ destId, bundle, onChange }: DestinationPickerProps): JSX.Element {
  return (
    <div className="eq-intake-dest">
      <div className="eq-intake-dest__label">Where's it going?</div>
      <div className="eq-intake-dest__row">
        {ALL_OPTIONS.map((opt) => {
          const available = destAvailable(opt, bundle);
          const missing = missingRoles(opt, bundle);
          const active = opt.id === destId;
          const suffix =
            !available && missing.length > 0 ? ` — needs ${missing.map(roleLabel).join(" + ")}` : "";
          return (
            <button
              key={opt.id}
              type="button"
              className={
                "eq-dest-pill" + (active ? " eq-dest-pill--active" : "") + (!available ? " eq-dest-pill--disabled" : "")
              }
              disabled={!available}
              title={opt.description}
              onClick={() => onChange(opt.id)}
            >
              {opt.label}
              {suffix}
            </button>
          );
        })}
        <button
          type="button"
          className="eq-dest-pill eq-dest-pill--disabled"
          disabled
          title="Upload a sample of your target list and we'll match it — coming soon."
        >
          Other…
        </button>
      </div>
    </div>
  );
}

export { OTHER_ID };
