/**
 * IntakeModule — the production-mount entry-point for EQ Intake.
 *
 * Host app (the EQ Shell) imports this and mounts it at /intake.
 * Renders the bundle flow: drop SimPRO customer/contact/site files →
 * auto-classify → pick a destination template → preview → download.
 *
 * The single-file-to-canonical flow that the demo's App.tsx also
 * exposes is intentionally NOT included here — that path only earns
 * its keep once the canonical Supabase is wired up. Until then, the
 * bundle-to-destination flow is what real users actually use.
 *
 * Routes log to `eq-intake:routes` in localStorage by default (same as
 * the demo's onDestinationChange handler). Host can override via the
 * onDestinationChange prop.
 */

import { useMemo } from "react";
import { RollupDropZone } from "../rollup/RollupDropZone.js";

export interface IntakeModuleProps {
  /**
   * Optional callback fired when the user picks a destination in the
   * "Where is this going?" prompt. Defaults to a localStorage logger
   * keyed `eq-intake:routes`.
   */
  onDestinationChange?: (
    value: string | undefined,
    source: "suggested" | "free_text",
  ) => void;
}

const ROUTE_LOG_KEY = "eq-intake:routes";

function defaultRouteLogger(
  value: string | undefined,
  source: "suggested" | "free_text",
): void {
  if (!value) return;
  try {
    const existing = localStorage.getItem(ROUTE_LOG_KEY);
    const log: Array<{ at: string; destination: string; source: string }> = existing
      ? JSON.parse(existing)
      : [];
    log.push({ at: new Date().toISOString(), destination: value, source });
    const trimmed = log.slice(-200);
    localStorage.setItem(ROUTE_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage full / disabled — silently skip
  }
}

export function IntakeModule(props: IntakeModuleProps): JSX.Element {
  const onDestinationChange = useMemo(
    () => props.onDestinationChange ?? defaultRouteLogger,
    [props.onDestinationChange],
  );

  // RollupDropZone today doesn't take onDestinationChange (the destination
  // prompt is built into the per-file confirm flow, not the bundle flow).
  // Leaving the prop here for forward compatibility — when the bundle flow
  // gains its own destination prompt, this will plug in.
  void onDestinationChange;

  return (
    <div className="eq-intake-module">
      <RollupDropZone />
    </div>
  );
}
