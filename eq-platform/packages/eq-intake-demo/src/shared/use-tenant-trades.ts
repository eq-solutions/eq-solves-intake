/**
 * useTenantTrades — a tenant's saved trade additions (app_data.tenant_trades
 * on eq-shell, via eq_list_tenant_trades / eq_add_tenant_trade /
 * eq_remove_tenant_trade). Purely additive over EQ's code-level default list
 * (see @eq/intake's getFieldSuggestedValues('staff', 'trade')) — there is no
 * way to suppress a default here, only add to and remove from the tenant's
 * own additions.
 *
 * IntakeModule owns this hook and passes `trades` down to the settings
 * screen and to RemediationQueue's trade dropdown — one fetch, one source.
 */
import { useCallback, useEffect, useState } from "react";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

export interface TenantTradesState {
  /** Tenant-added trades only — combine with the code defaults for display. */
  trades: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  addTrade: (trade: string) => Promise<void>;
  removeTrade: (trade: string) => Promise<void>;
  /** trade name currently mid-save — lets the UI disable that row's controls. */
  saving: Record<string, boolean>;
  /** True when no Supabase client was supplied — saves are a no-op, UI should say so. */
  disabled: boolean;
}

export function useTenantTrades(
  supabase: SupabaseLikeClient | null | undefined,
): TenantTradesState {
  const [trades, setTrades] = useState<string[]>([]);
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

    sb.rpc("eq_list_tenant_trades")
      .then(({ data, error: rpcError }: { data: unknown; error: { message: string } | null }) => {
        if (cancelled) return;
        if (rpcError) { setError(rpcError.message); return; }
        const rows = (data as { trade: string }[] | null) ?? [];
        setTrades(rows.map((r) => r.trade));
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, refreshCounter]);

  const refresh = useCallback(() => setRefreshCounter((n) => n + 1), []);

  const addTrade = useCallback(
    async (trade: string) => {
      if (!supabase) return;
      const value = trade.trim();
      if (!value) return;
      setSaving((s) => ({ ...s, [value]: true }));
      try {
        const { error: rpcError } = await sb.rpc("eq_add_tenant_trade", { p_trade: value });
        if (rpcError) throw new Error(rpcError.message);
        setTrades((prev) => (prev.includes(value) ? prev : [...prev, value].sort()));
      } finally {
        setSaving((s) => { const next = { ...s }; delete next[value]; return next; });
      }
    },
    [supabase, sb],
  );

  const removeTrade = useCallback(
    async (trade: string) => {
      if (!supabase) return;
      setSaving((s) => ({ ...s, [trade]: true }));
      try {
        const { error: rpcError } = await sb.rpc("eq_remove_tenant_trade", { p_trade: trade });
        if (rpcError) throw new Error(rpcError.message);
        setTrades((prev) => prev.filter((t) => t !== trade));
      } finally {
        setSaving((s) => { const next = { ...s }; delete next[trade]; return next; });
      }
    },
    [supabase, sb],
  );

  return { trades, loading, error, refresh, addTrade, removeTrade, saving, disabled: !supabase };
}
