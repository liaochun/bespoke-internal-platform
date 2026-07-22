// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createProductionRun,
  getBomPreflight,
  listScheduledOn,
  setProductionRunStaff,
  type BomPreflightReport,
  type MasterItemWithStock,
  type ProductionRun,
  type ScheduledStaffOnDate,
} from "@/lib/api";

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Default baths-per-hour-per-person used when no override is set.
export const DEFAULT_RATE = 55;

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-md py-sm font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`px-md py-sm align-middle ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

export function BomPreflightPanel({ report }: { report: BomPreflightReport }) {
  const shortCount = report.components.filter((c) => c.shortfall > 0).length;

  const banner = report.missing_recipe ? (
    <div className="flex items-center gap-sm rounded-sm border border-critical/40 bg-critical/10 px-sm py-sm text-small text-stone">
      <span className="font-medium text-critical">No active recipe for this item.</span>
      <span className="text-stone/70">Create one first.</span>
    </div>
  ) : !report.can_produce ? (
    <div className="flex items-center gap-sm rounded-sm border border-critical/40 bg-critical/10 px-sm py-sm text-small text-stone">
      <span className="font-medium text-critical">Insufficient stock</span>
      <span className="text-stone/70">
        — {shortCount} of {report.components.length} component
        {report.components.length === 1 ? "" : "s"} short.
      </span>
    </div>
  ) : (
    <div className="flex items-center gap-sm rounded-sm border border-success/40 bg-success/10 px-sm py-sm text-small text-stone">
      <span className="font-medium text-success">Ingredients available</span>
      <span className="text-stone/70">
        — {report.components.length} component
        {report.components.length === 1 ? "" : "s"} ready.
      </span>
    </div>
  );

  return (
    <div className="space-y-sm">
      {banner}
      {!report.missing_recipe && report.components.length > 0 && (
        <div className="overflow-x-auto rounded-sm border border-sand/30">
          <table className="w-full min-w-[560px] text-small">
            <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
              <tr>
                <Th>SKU</Th>
                <Th>Component</Th>
                <Th align="right">Required</Th>
                <Th align="right">On hand</Th>
                <Th align="right">Shortfall</Th>
              </tr>
            </thead>
            <tbody>
              {report.components.map((c) => {
                const pct = c.qty_required > 0 ? c.shortfall / c.qty_required : 0;
                const rowCls =
                  c.shortfall === 0
                    ? "bg-success/5"
                    : pct <= 0.1
                      ? "bg-warning/10"
                      : "bg-critical/10";
                const shortCls =
                  c.shortfall === 0
                    ? "text-success font-mono"
                    : pct <= 0.1
                      ? "text-warning font-mono font-medium"
                      : "text-critical font-mono font-medium";
                const unit = c.measurement_unit ? ` ${c.measurement_unit}` : "";
                return (
                  <tr key={c.item_id} className={`border-t border-sand/30 ${rowCls}`}>
                    <Td>
                      <span className="font-mono text-tiny text-stone/60">
                        {c.sku?.startsWith("airtable:") || /^rec[A-Za-z0-9]{10,}$/.test(c.sku ?? "") ? "—" : (c.sku || "—")}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-stone">{c.name}</span>
                      <span className="ml-xs text-tiny uppercase tracking-widest text-clay">
                        {c.item_type}
                      </span>
                    </Td>
                    <Td align="right" className="font-mono text-stone/80">
                      {c.qty_required.toFixed(2)}{unit}
                    </Td>
                    <Td align="right" className="font-mono text-stone/80">
                      {c.on_hand.toFixed(2)}{unit}
                    </Td>
                    <Td align="right" className={shortCls}>
                      {c.shortfall === 0 ? "OK" : `+${c.shortfall.toFixed(2)}${unit}`}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export type SkuCategory = "Core Baths" | "Kits" | "Limited Baths" | "Other";
export const SKU_CATEGORIES: SkuCategory[] = ["Core Baths", "Kits", "Limited Baths", "Other"];

const LIMITED_BATH_SKUS = new Set(["GE1", "LC1", "RO1", "WT1"]);

export function categorizeSku(item: MasterItemWithStock): SkuCategory {
  if (LIMITED_BATH_SKUS.has(item.sku ?? "")) return "Limited Baths";
  const sub = (item.subcategory_at ?? "").toLowerCase();
  const name = item.name.toLowerCase();
  if (sub.includes("kit") || name.includes("kit")) return "Kits";
  if (sub.includes("limited") || name.includes("limited")) return "Limited Baths";
  if (
    sub.includes("core") ||
    sub.includes("full") ||
    sub.includes("mini") ||
    sub.includes("bath") ||
    name.includes("bath")
  )
    return "Core Baths";
  return "Other";
}

export function SkuGroupPicker({
  items,
  value,
  onChange,
}: {
  items: MasterItemWithStock[];
  value: string;
  onChange: (id: string) => void;
}) {
  const grouped = (() => {
    const map = Object.fromEntries(
      SKU_CATEGORIES.map((c) => [c, [] as MasterItemWithStock[]]),
    ) as Record<SkuCategory, MasterItemWithStock[]>;
    for (const item of items) map[categorizeSku(item)].push(item);
    return map;
  })();

  const availableCats = SKU_CATEGORIES.filter((c) => grouped[c].length > 0);
  const [activeCat, setActiveCat] = useState<SkuCategory>(
    () => availableCats[0] ?? "Core Baths",
  );

  const selectedItem = items.find((i) => i.id === value);

  return (
    <div className="space-y-xs">
      <div className="flex flex-wrap gap-xs">
        {availableCats.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCat(cat)}
            className={`rounded-sm border px-sm py-xs text-tiny uppercase tracking-widest ${
              activeCat === cat
                ? "border-terracotta bg-terracotta/10 text-terracotta"
                : "border-sand text-stone/60 hover:border-clay/50 hover:text-stone"
            }`}
          >
            {cat}
            <span className="ml-xs text-stone/40">{grouped[cat].length}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-xs">
        {grouped[activeCat].map((item) => {
          const sel = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              title={item.name}
              className={`rounded-sm border px-sm py-xs font-mono text-tiny ${
                sel
                  ? "border-terracotta bg-terracotta text-warmWhite"
                  : "border-sand bg-warmWhite text-stone hover:border-terracotta/50 hover:bg-terracotta/5"
              }`}
            >
              {item.sku}
            </button>
          );
        })}
      </div>
      {selectedItem ? (
        <p className="text-tiny text-stone/60">
          <span className="text-stone">{selectedItem.name}</span>
          <button
            type="button"
            onClick={() => onChange("")}
            className="ml-sm text-stone/40 hover:text-critical"
          >
            ×
          </button>
        </p>
      ) : (
        <p className="text-tiny text-stone/40">Select a SKU above</p>
      )}
    </div>
  );
}

export function CreateRunForm({
  finished,
  initialDate,
  onCreated,
  onError,
}: {
  finished: MasterItemWithStock[];
  initialDate?: string;
  onCreated: (run: ProductionRun) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [itemId, setItemId] = useState("");
  const [date, setDate] = useState(initialDate ?? todayIso());
  const [staff, setStaff] = useState("2");
  const [hours, setHours] = useState("8");
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState<ScheduledStaffOnDate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingScheduled, setLoadingScheduled] = useState(false);

  // Ingredients preflight state
  const [preflight, setPreflight] = useState<BomPreflightReport | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute a local target_qty estimate from staff * hours * default rate
  // so we can run preflight before the run is created.
  const estimatedQty = (() => {
    const s = Math.max(1, Number(staff) || 1);
    const h = Math.max(0, Number(hours) || 0);
    return Math.floor(s * h * DEFAULT_RATE);
  })();

  const runPreflight = useCallback(
    (id: string, qty: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!id || qty <= 0) {
        setPreflight(null);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setPreflightLoading(true);
        try {
          const report = await getBomPreflight(id, qty);
          setPreflight(report);
        } catch (e) {
          // Surface preflight errors inline rather than blowing up the whole form
          setPreflight(null);
          onError(`Ingredients preflight: ${(e as Error).message}`);
        } finally {
          setPreflightLoading(false);
        }
      }, 300);
    },
    [onError],
  );

  // Re-run preflight whenever item or estimated qty changes
  useEffect(() => {
    runPreflight(itemId, estimatedQty);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, estimatedQty, runPreflight]);

  // Clear preflight when item is cleared
  useEffect(() => {
    if (!itemId) setPreflight(null);
  }, [itemId]);

  // Pull who's on schedule for the chosen day. Auto-runs on every
  // date change. Production-run-linked shifts are excluded so we
  // don't double-count people who are already attached to another
  // run that same day.
  useEffect(() => {
    let cancelled = false;
    setLoadingScheduled(true);
    void listScheduledOn(date)
      .then((rows) => {
        if (cancelled) return;
        const onlyManual = rows.filter((r) => !r.is_production);
        setScheduled(onlyManual);
        const auto = new Set(onlyManual.map((r) => r.user_id));
        setPicked(auto);
        if (onlyManual.length > 0) {
          setStaff(String(onlyManual.length));
          // Do NOT auto-set hours from shift duration — shift time ≠ production time.
          // The operator sets hours-per-person explicitly; hours_total = staff × that value.
        }
      })
      .catch((e) => {
        if (cancelled) return;
        onError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingScheduled(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const togglePicked = (uid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const stockShort =
    !!preflight && !preflight.missing_recipe && !preflight.can_produce;
  const submitBlocked = !!preflight?.missing_recipe;
  const submitTitle = submitBlocked
    ? "No active recipe — create one before scheduling a run."
    : stockShort
      ? `Stock short for ${preflight?.components.filter((c) => c.shortfall > 0).length} component(s) — run will be created anyway. Resolve shortfalls before completing.`
      : undefined;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemId) {
      onError("Pick a finished SKU.");
      return;
    }
    if (submitBlocked) {
      onError(submitTitle ?? "Ingredients check failed — cannot create run.");
      return;
    }
    setBusy(true);
    try {
      const run = await createProductionRun({
        finished_item_id: itemId,
        scheduled_date: date,
        staff_count_planned: Math.max(1, Number(staff) || 1),
        hours_planned: Math.max(0, Number(hours) || 0),
      });
      // Auto-attach the picked staff. Production hours come from the
      // operator-entered hours field (not the full shift hours), so
      // 4 staff × 2h = 8h total, not 4 × shift_hours. The shift
      // duration is preserved separately for the calendar.
      const prodHours = Math.max(0, Number(hours) || 0);
      for (const s of scheduled) {
        if (!picked.has(s.user_id)) continue;
        try {
          await setProductionRunStaff(run.id, {
            user_id: s.user_id,
            hours: prodHours,
            shift_hours: s.hours !== prodHours ? s.hours : undefined,
          });
        } catch (err) {
          onError(`${s.full_name}: ${(err as Error).message}`);
        }
      }
      await onCreated(run);
      setItemId("");
      setPreflight(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-sm rounded-md border border-sand/30 bg-warmWhite p-md"
    >
      <div>
        <p className="text-tiny uppercase tracking-widest text-clay">Finished SKU</p>
        <div className="mt-xs">
          <SkuGroupPicker items={finished} value={itemId} onChange={setItemId} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-sm md:grid-cols-[140px_140px_100px_100px_auto] md:items-end">
        <label className="text-small">
          <span className="text-tiny uppercase tracking-widest text-clay">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:outline-none focus:border-terracotta"
          />
        </label>
        <label className="text-small">
          <span className="text-tiny uppercase tracking-widest text-clay">Staff</span>
          <input
            type="number"
            min="1"
            value={staff}
            onChange={(e) => setStaff(e.target.value)}
            className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:outline-none focus:border-terracotta"
          />
        </label>
        <label className="text-small">
          <span className="text-tiny uppercase tracking-widest text-clay">Hours</span>
          <input
            type="number"
            step="0.25"
            min="0"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:outline-none focus:border-terracotta"
          />
        </label>
        <div className="flex flex-col items-start gap-xs">
          <button
            type="submit"
            disabled={busy || submitBlocked}
            title={submitTitle}
            className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "…" : "New run"}
          </button>
          {submitBlocked && (
            <span className="text-tiny text-critical">No recipe</span>
          )}
          {!submitBlocked && stockShort && (
            <span className="text-tiny text-warning">Stock short · will create anyway</span>
          )}
        </div>
      </div>

      <div>
        <div className="rounded-sm border border-sand/40 bg-softCream/60 p-sm">
          <p className="text-tiny uppercase tracking-widest text-clay">
            On schedule {date}
            {loadingScheduled && " · loading…"}
          </p>
          {scheduled.length === 0 ? (
            <p className="mt-xs text-tiny text-stone/50">
              No staff scheduled (outside of any existing production runs).
            </p>
          ) : (
            <ul className="mt-xs flex flex-wrap gap-xs">
              {scheduled.map((s) => {
                const checked = picked.has(s.user_id);
                return (
                  <li key={s.user_id}>
                    <label
                      className={`flex cursor-pointer items-center gap-xs rounded-sm border px-sm py-xs text-tiny ${
                        checked
                          ? "border-terracotta bg-terracotta/10 text-stone"
                          : "border-sand bg-warmWhite text-stone/70"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePicked(s.user_id)}
                      />
                      <span>{s.full_name}</span>
                      <span className="font-mono text-stone/50">{s.hours.toFixed(1)}h</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {scheduled.length > 0 && (
            <p className="mt-xs text-tiny text-stone/50">
              {picked.size} of {scheduled.length} will be attached on create. Headcount + hours
              above were pre-filled from the day's roster -- edit as needed.
            </p>
          )}
        </div>
      </div>

      {/* Ingredients preflight panel — only shown when item + qty are set */}
      {itemId && estimatedQty > 0 && (
        <div>
          <div className="rounded-sm border border-sand/40 bg-softCream/60 p-sm">
            <div className="mb-sm flex items-center justify-between">
              <p className="text-tiny uppercase tracking-widest text-clay">
                Ingredients preflight · {estimatedQty} units estimated
              </p>
              {preflightLoading && (
                <span className="text-tiny text-stone/40">checking…</span>
              )}
            </div>
            {preflight && !preflightLoading ? (
              <BomPreflightPanel report={preflight} />
            ) : !preflightLoading ? (
              <p className="text-tiny text-stone/40">—</p>
            ) : null}
          </div>
        </div>
      )}
    </form>
  );
}
