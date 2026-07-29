/**
 * useFieldImportanceOverrides — the one fetch for a tenant's saved
 * field-importance corrections (app_data.tenant_field_importance_overrides
 * on eq-shell, via eq_get_field_importance_overrides /
 * eq_set_field_importance_override / eq_reset_field_importance_override).
 *
 * IntakeModule owns this hook and passes `overrides` down to every consumer
 * that needs to know which fields count as a gap (Overview, EntityDrillDown)
 * plus the setter/reset pair to the settings screen. One fetch, one source
 * of truth — nothing else in eq-intake-demo calls these RPCs directly.
 */
import { useCallback, useEffect, useState } from "react";
import type { FieldImportanceOverride, FieldTier } from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

/** A saved override plus the timestamp the settings screen shows next to it. */
export type TenantFieldOverride = FieldImportanceOverride & { updatedAt?: string };

export interface FieldImportanceOverridesState {
  overrides: TenantFieldOverride[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  setOverride: (entity: string, field: string, tier: FieldTier) => Promise<void>;
  resetOverride: (entity: string, field: string) => Promise<void>;
  /** entity+field pairs currently mid-save — lets the UI disable a row's controls. */
  saving: Record<string, boolean>;
  /** True when no Supabase client was supplied — saves are a no-op, UI should say so. */
  disabled: boolean;
}

function overrideKey(entity: string, field: string): string {
  return `${entity}.${field}`;
}

export function useFieldImportanceOverrides(
  supabase: SupabaseLikeClient | null | undefined,
): FieldImportanceOverridesState {
  const [overrides, setOverrides] = useState<TenantFieldOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [refreshCounter, setRefreshCounter] = useState(0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    sb.rpc("eq_get_field_importance_overrides")
      .then(({ data, error: rpcError }: { data: unknown; error: { message: string } | null }) => {
        if (cancelled) return;
        if (rpcError) { setError(rpcError.message); return; }
        const rows = (data as { entity: string; field: string; tier: FieldTier; updated_at: string }[] | null) ?? [];
        setOverrides(rows.map((r) => ({ entity: r.entity, field: r.field, tier: r.tier, updatedAt: r.updated_at })));
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, refreshCounter]);

  const refresh = useCallback(() => setRefreshCounter((n) => n + 1), []);

  const setOverride = useCallback(
    async (entity: string, field: string, tier: FieldTier) => {
      if (!supabase) return;
      const key = overrideKey(entity, field);
      setSaving((s) => ({ ...s, [key]: true }));
      try {
        const { error: rpcError } = await sb.rpc("eq_set_field_importance_override", {
          p_entity: entity,
          p_field: field,
          p_tier: tier,
        });
        if (rpcError) throw new Error(rpcError.message);
        setOverrides((prev) => [
          ...prev.filter((o) => !(o.entity === entity && o.field === field)),
          { entity, field, tier, updatedAt: new Date().toISOString() },
        ]);
      } finally {
        setSaving((s) => { const next = { ...s }; delete next[key]; return next; });
      }
    },
    [supabase, sb],
  );

  const resetOverride = useCallback(
    async (entity: string, field: string) => {
      if (!supabase) return;
      const key = overrideKey(entity, field);
      setSaving((s) => ({ ...s, [key]: true }));
      try {
        const { error: rpcError } = await sb.rpc("eq_reset_field_importance_override", {
          p_entity: entity,
          p_field: field,
        });
        if (rpcError) throw new Error(rpcError.message);
        setOverrides((prev) => prev.filter((o) => !(o.entity === entity && o.field === field)));
      } finally {
        setSaving((s) => { const next = { ...s }; delete next[key]; return next; });
      }
    },
    [supabase, sb],
  );

  return { overrides, loading, error, refresh, setOverride, resetOverride, saving, disabled: !supabase };
}
