// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Tiny status dot for the global Header. One-glance Airtable mirror
 * health from any page:
 *   green   = configured + last sync within 2h, no unresolved errors
 *   warning = configured + last sync 2–24h ago OR auto-sync disabled
 *   critical = configured + last sync >24h ago OR ≥1 unresolved error
 *   muted   = not configured
 *
 * Fetches once on mount + every 2 minutes while the tab is visible. In the
 * real app this links to /admin/integrations; that page isn't part of this
 * curated excerpt, so here it's a status indicator only (not clickable).
 *
 * Gated to capabilities that care about the mirror — inventory viewers
 * and managers. Other users see nothing (no fetch, no dot).
 */

import { useEffect, useState } from "react";

import { useCurrentUser } from "@/components/AuthGate";
import {
  AirtableStatus,
  fetchAirtableStatus,
  listAirtableSyncErrors,
} from "@/lib/api";
import { CAP, has } from "@/lib/capabilities";
import { useVisibleInterval } from "@/lib/useVisibleInterval";

type Tone = "fresh" | "warning" | "critical" | "muted";

const STYLES: Record<Tone, { dot: string; ring: string; label: string }> = {
  fresh: {
    dot: "bg-success",
    ring: "ring-success/30",
    label: "Mirror healthy",
  },
  warning: {
    dot: "bg-warning",
    ring: "ring-warning/30",
    label: "Mirror stale",
  },
  critical: {
    dot: "bg-critical",
    ring: "ring-critical/30",
    label: "Mirror has errors",
  },
  muted: {
    dot: "bg-stone/40",
    ring: "ring-stone/20",
    label: "Mirror not configured",
  },
};

const RELEVANT_KEYS = [
  "master_items",
  "variants",
  "transactions",
  "transfers",
  "production_runs",
  "suppliers_ingredients",
  "bom_lines",
  "orders",
];

function classify(status: AirtableStatus | null, unresolvedErrors: number): Tone {
  if (!status?.configured) return "muted";
  if (unresolvedErrors > 0) return "critical";

  const ages: number[] = [];
  for (const k of RELEVANT_KEYS) {
    const iso = status.last_sync_by_table?.[k];
    if (!iso) continue;
    ages.push(Date.now() - new Date(iso).getTime());
  }
  if (ages.length === 0) return "muted";

  const oldestH = Math.max(...ages) / 3_600_000;
  if (oldestH >= 24) return "critical";
  if (oldestH >= 2 || !status.auto_sync_enabled) return "warning";
  return "fresh";
}

export function HeaderSyncDot() {
  const me = useCurrentUser();
  const eligible = has(me, CAP.view_inventory) || has(me, CAP.manage_inventory);

  const [status, setStatus] = useState<AirtableStatus | null>(null);
  const [errors, setErrors] = useState<number>(0);

  const load = async () => {
    try {
      const [st, se] = await Promise.allSettled([
        fetchAirtableStatus(),
        listAirtableSyncErrors({ only_unresolved: true, limit: 1 }),
      ]);
      setStatus(st.status === "fulfilled" ? st.value : null);
      setErrors(se.status === "fulfilled" ? se.value.length : 0);
    } catch {
      // swallow — header dot is best-effort, no UI for failures
    }
  };

  useEffect(() => {
    if (!eligible) return;
    void load();
  }, [eligible]);

  useVisibleInterval(() => {
    if (!eligible) return;
    void load();
  }, 120_000);

  if (!eligible) return null;

  const tone = classify(status, errors);
  const style = STYLES[tone];
  const detail =
    tone === "critical" && errors > 0
      ? `${errors} unresolved error${errors === 1 ? "" : "s"}`
      : style.label;

  return (
    <span
      title={`Airtable: ${detail}`}
      aria-label={`Airtable mirror status: ${detail}`}
      className={`inline-flex h-3 w-3 items-center justify-center rounded-full ring-2 ${style.ring}`}
    >
      <span className={`block h-full w-full rounded-full ${style.dot}`} />
    </span>
  );
}
