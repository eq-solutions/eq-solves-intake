/**
 * TradesSettings — the tenant-editable half of the trade vocabulary. EQ
 * ships a default list (@eq/intake's getFieldSuggestedValues('staff',
 * 'trade')); this lets a tenant add their own on top, stored in
 * app_data.tenant_trades via eq_add_tenant_trade / eq_remove_tenant_trade.
 * Defaults can't be removed here — only a tenant's own additions can.
 * RemediationQueue's trade dropdown reads the same combined list.
 *
 * Reached via a settings icon on Overview, next to Field importance —
 * deliberately not a fifth tab, same reasoning as FieldImportanceSettings.
 */
import { useMemo, useState, type JSX } from "react";
import { getFieldSuggestedValues } from "@eq/intake";
import type { TenantTradesState } from "../shared/use-tenant-trades.js";

export interface TradesSettingsProps {
  tradesState: TenantTradesState;
  onBack: () => void;
}

const DEFAULT_TRADES = getFieldSuggestedValues("staff", "trade") ?? [];

export function TradesSettings({ tradesState, onBack }: TradesSettingsProps): JSX.Element {
  const { trades, loading, error, addTrade, removeTrade, saving, disabled } = tradesState;
  const [draft, setDraft] = useState("");

  const tenantTradeSet = useMemo(() => new Set(trades.map((t) => t.toLowerCase())), [trades]);

  const allTrades = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const t of [...DEFAULT_TRADES, ...trades]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(t);
    }
    return list.sort((a, b) => a.localeCompare(b));
  }, [trades]);

  const handleAdd = () => {
    const value = draft.trim();
    if (!value) return;
    void addTrade(value);
    setDraft("");
  };

  return (
    <section className="eq-fis">
      <div className="eq-fis__header">
        <button type="button" className="eq-intake-btn-ghost eq-fis__back" onClick={onBack}>
          ← Back to Overview
        </button>
        <div>
          <h2 className="eq-fis__title">Trades</h2>
          <p className="eq-fis__subtitle">
            EQ ships a default list of trades for the Review Queue's trade
            picker. Add your own below — it only affects your tenant. EQ's
            defaults can't be removed, but anything you add can be.
          </p>
        </div>
      </div>

      {disabled && (
        <div className="eq-intake-info-strip">
          EQ isn't connected yet — you can see the default trades, but adding
          one here won't save until a connection is set up.
        </div>
      )}

      {error && (
        <div role="alert" className="eq-intake-alert">{error}</div>
      )}

      {loading ? (
        <p className="eq-health-loading">Loading your saved trades…</p>
      ) : (
        <>
          <div className="eq-fis__field-list">
            {allTrades.map((trade) => {
              const isTenantAdded = tenantTradeSet.has(trade.toLowerCase());
              const isSaving = !!saving[trade];
              return (
                <div key={trade} className="eq-fis__field-row">
                  <div className="eq-fis__field-info">
                    <span className="eq-fis__field-name">{trade}</span>
                    {!isTenantAdded && <span className="eq-fis__field-why">EQ default</span>}
                  </div>
                  {isTenantAdded && (
                    <button
                      type="button"
                      className="eq-fis__reset-link"
                      disabled={isSaving || disabled}
                      onClick={() => removeTrade(trade)}
                    >
                      {isSaving ? "Removing…" : "Remove"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="eq-fis__add-row">
            <input
              className="eq-drill__inline-input"
              placeholder="Add a trade"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              disabled={disabled}
              aria-label="Add a trade"
            />
            <button
              type="button"
              className="eq-intake-btn-ghost"
              onClick={handleAdd}
              disabled={disabled || !draft.trim()}
            >
              Add
            </button>
          </div>
        </>
      )}
    </section>
  );
}
