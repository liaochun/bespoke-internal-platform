// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Phase G hero strip on the inventory dashboard. Aggregates the Phase
 * B-F endpoints (recommendations, transfers, production runs) into a
 * single row of stat cards with click-through links. Each card fetches
 * its own data so a stalled endpoint can't sink the whole strip.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  fetchRecommendations,
  listProductionRuns,
  listTransfersV2,
} from "@/lib/api";

type Tone = "neutral" | "warning" | "critical" | "success";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-stone",
  warning: "text-warning",
  critical: "text-critical",
  success: "text-success",
};

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function OpsV2HeroStrip() {
  const [makeCount, setMakeCount] = useState<number | null>(null);
  const [orderCount, setOrderCount] = useState<number | null>(null);
  const [activeTransfers, setActiveTransfers] = useState<number | null>(null);
  const [scheduledToday, setScheduledToday] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const recs = await fetchRecommendations("toronto", false);
        if (cancelled) return;
        setMakeCount(recs.filter((r) => r.action === "make").length);
        setOrderCount(recs.filter((r) => r.action === "order").length);
      } catch {
        // Phase D might not be aggregated yet; leave nulls
      }
      try {
        const ts = await listTransfersV2();
        if (cancelled) return;
        setActiveTransfers(
          ts.filter((t) => t.status === "planned" || t.status === "in_transit").length,
        );
      } catch {
        // ignore
      }
      try {
        const today = todayIso();
        const runs = await listProductionRuns({ from_date: today, to_date: today });
        if (cancelled) return;
        setScheduledToday(runs.filter((r) => r.status !== "cancelled").length);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="grid grid-cols-2 gap-sm md:grid-cols-4">
      <Card
        href="/admin/inventory/replenishment"
        label="Need to make"
        value={makeCount}
        tone={makeCount && makeCount > 0 ? "critical" : "success"}
        hint="finished SKUs below min"
      />
      <Card
        href="/admin/inventory/replenishment"
        label="Need to order"
        value={orderCount}
        tone={orderCount && orderCount > 0 ? "warning" : "success"}
        hint="ingredients + packaging"
      />
      <Card
        href="/admin/inventory/transfers-v2"
        label="Active transfers"
        value={activeTransfers}
        tone={activeTransfers && activeTransfers > 0 ? "neutral" : "success"}
        hint="planned + in transit"
      />
      <Card
        href="/admin/inventory/production-schedule"
        label="Scheduled today"
        value={scheduledToday}
        tone="neutral"
        hint="production runs"
      />
    </section>
  );
}

function Card({
  href,
  label,
  value,
  tone,
  hint,
}: {
  href: string;
  label: string;
  value: number | null;
  tone: Tone;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-md border border-sand/30 bg-softCream p-md hover:bg-sand/10"
    >
      <p className="text-tiny uppercase tracking-widest text-clay">{label}</p>
      <p className={`mt-xs font-serif text-h1 ${TONE_CLASS[tone]}`}>
        {value === null ? "—" : value}
      </p>
      <p className="mt-xs text-tiny text-stone/50">{hint}</p>
    </Link>
  );
}
