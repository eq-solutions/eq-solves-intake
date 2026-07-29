/**
 * FieldImportanceSettings — the tenant-editable half of the field-importance
 * rulebook (@eq/intake's field-importance.ts). Lets a tenant re-tier one of
 * their own fields (e.g. "we don't use customer_id on internal sites") via
 * eq_set_field_importance_override / eq_reset_field_importance_override,
 * without touching the shared EQ-wide code defaults everyone else still gets.
 *
 * Reached via the gear icon on Overview (IntakeModule) — deliberately not a
 * fifth tab, per the earlier 5→4 tab collapse.
 */
import { useMemo, useState, type JSX } from "react";
import { FIELD_IMPORTANCE, type FieldTier } from "@eq/intake";
import type { FieldImportanceOverridesState } from "../shared/use-field-importance-overrides.js";
import { entityLabel, fieldLabel } from "../shared/entity-label.js";

export interface FieldImportanceSettingsProps {
  overridesState: FieldImportanceOverridesState;
  onBack: () => void;
}

const ENABLED_ENTITIES = ["staff", "licences", "assets", "sites", "customers", "contacts"] as const;

const TIER_ORDER: FieldTier[] = ["critical", "important", "optional"];
const TIER_LABEL: Record<FieldTier, string> = {
  critical: "Critical",
  important: "Important",
  optional: "Optional",
};

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export function FieldImportanceSettings({
  overridesState,
  onBack,
}: FieldImportanceSettingsProps): JSX.Element {
  const { overrides, loading, error, setOverride, resetOverride, saving, disabled } = overridesState;
  const [activeEntity, setActiveEntity] = useState<string>(ENABLED_ENTITIES[0]);

  const overrideMap = useMemo(() => {
    const m = new Map<string, { tier: FieldTier }>();
    for (const o of overrides) m.set(`${o.entity}.${o.field}`, { tier: o.tier });
    return m;
  }, [overrides]);

  const fields = FIELD_IMPORTANCE[activeEntity] ?? [];

  return (
    <section className="eq-fis">
      <div className="eq-fis__header">
        <button type="button" className="eq-intake-btn-ghost eq-fis__back" onClick={onBack}>
          ← Back to Overview
        </button>
        <div>
          <h2 className="eq-fis__title">Field importance</h2>
          <p className="eq-fis__subtitle">
            EQ ships a default opinion on which blank fields count as a data gap.
            Change a tier here if your business uses a field differently — it only
            affects your tenant.
          </p>
        </div>
      </div>

      {disabled && (
        <div className="eq-intake-info-strip">
          EQ isn't connected yet — you can see how each field is tiered, but
          changing a tier here won't save until a connection is set up.
        </div>
      )}

      {error && (
        <div role="alert" className="eq-intake-alert">{error}</div>
      )}

      <div className="eq-fis__entity-tabs" role="tablist">
        {ENABLED_ENTITIES.map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            aria-selected={activeEntity === e}
            className={"eq-fis__entity-tab" + (activeEntity === e ? " eq-fis__entity-tab--active" : "")}
            onClick={() => setActiveEntity(e)}
          >
            {entityLabel(e)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="eq-health-loading">Loading your saved tiers…</p>
      ) : (
        <div className="eq-fis__field-list">
          {fields.map((entry) => {
            const key = `${activeEntity}.${entry.field}`;
            const override = overrideMap.get(key);
            const effectiveTier = override?.tier ?? entry.tier;
            const isOverridden = !!override;
            const isSaving = !!saving[key];
            const overrideRow = overrides.find((o) => o.entity === activeEntity && o.field === entry.field);

            return (
              <div key={entry.field} className="eq-fis__field-row">
                <div className="eq-fis__field-info">
                  <span className="eq-fis__field-name">{fieldLabel(entry.field)}</span>
                  <span className="eq-fis__field-why">{entry.why}</span>
                </div>

                <div className="eq-fis__field-control">
                  <div className="eq-fis__segmented" role="radiogroup" aria-label={`Importance for ${fieldLabel(entry.field)}`}>
                    {TIER_ORDER.map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        role="radio"
                        aria-checked={effectiveTier === tier}
                        disabled={isSaving || disabled}
                        className={
                          "eq-fis__segment eq-fis__segment--" + tier +
                          (effectiveTier === tier ? " eq-fis__segment--active" : "")
                        }
                        onClick={() => {
                          if (tier === effectiveTier) return;
                          if (tier === entry.tier) resetOverride(activeEntity, entry.field);
                          else setOverride(activeEntity, entry.field, tier);
                        }}
                      >
                        {TIER_LABEL[tier]}
                      </button>
                    ))}
                  </div>

                  {isOverridden ? (
                    <span className="eq-fis__override-note">
                      EQ default: {TIER_LABEL[entry.tier]}
                      {overrideRow?.updatedAt ? ` · changed ${fmtDate(overrideRow.updatedAt)}` : ""}
                      {" · "}
                      <button
                        type="button"
                        className="eq-fis__reset-link"
                        disabled={isSaving || disabled}
                        onClick={() => resetOverride(activeEntity, entry.field)}
                      >
                        Reset to default
                      </button>
                    </span>
                  ) : (
                    <span className="eq-fis__override-note eq-fis__override-note--muted">Using EQ default</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
