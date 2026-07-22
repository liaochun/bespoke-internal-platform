// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Production calendar (Phase K).
 *
 * Mon-Sun grid with one cell per day showing every production_run
 * scheduled for that date. Read-only week navigator.
 *
 * Per-cell card: SKU short, target qty, status pill, staff x hrs.
 * Click a run -> shows the run detail inline below the calendar.
 * No navigation away. Detail shows item, date, status, staff stats,
 * BOM, and completion fields only (fix #f88249c8).
 *
 * "+ Plan a run" opens the same CreateRunForm used on production-schedule
 * (shared component) so creating a run behaves identically on both pages.
 * The run detail panel is for logging real production-team inputs
 * against an existing run (qty, QC, packaging, bag/seal, notes) --
 * it does not re-derive staff x hours estimates; that estimation belongs
 * to production-schedule.
 */

import { useEffect, useMemo, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { CreateRunForm } from "@/components/CreateRunForm";
import { Header } from "@/components/Header";
import { ProductionNav } from "@/components/ProductionNav";
import {
  adjustProductionRunQty,
  completeProductionRun,
  fetchProductionRun,
  fetchRecipeByFinished,
  listInventoryItems,
  listProductionRuns,
  listScheduledOn,
  markProductionRunBagged,
  markProductionRunSealed,
  pushProductionRunsToAirtable,
  syncAirtableProductionRuns,
  updateProductionRun,
  type MasterItemWithStock,
  type ProductionRun,
  type ProductionRunStatus,
  type Recipe,
} from "@/lib/api";
import { CAP, has } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function Inner() {
  useDocumentTitle("Production calendar");
  const me = useCurrentUser();
  const canEdit = has(me, CAP.manage_inventory);

  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()));
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [items, setItems] = useState<MasterItemWithStock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composeDate, setComposeDate] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [weekStaffCounts, setWeekStaffCounts] = useState<Map<string, number>>(new Map());

  // Detail panel
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<ProductionRun | null>(null);
  const [detailRecipe, setDetailRecipe] = useState<Recipe | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editQcErrors, setEditQcErrors] = useState("");
  const [editCompletedQty, setEditCompletedQty] = useState("");
  const [editPackagingHours, setEditPackagingHours] = useState("");
  const [editIncludePackagingHours, setEditIncludePackagingHours] = useState(false);
  const [editPackagingStaffCount, setEditPackagingStaffCount] = useState("");
  const [editBagSealStaffCount, setEditBagSealStaffCount] = useState("");
  const [editIncludeBagSealHours, setEditIncludeBagSealHours] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [markingBagSeal, setMarkingBagSeal] = useState(false);
  const [bagSealMinutes, setBagSealMinutes] = useState("");
  const [bagSealQty, setBagSealQty] = useState("");

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 3500);
    return () => clearTimeout(t);
  }, [success]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetailRun(null);
      setDetailRecipe(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetailRecipe(null);
    fetchProductionRun(selectedRunId)
      .then(async (run) => {
        if (cancelled) return;
        setDetailRun(run);
        setEditNotes(run.notes ?? "");
        setEditQcErrors(run.qc_errors ?? "");
        setEditCompletedQty(String(run.completed_qty ?? run.target_qty ?? ""));
        setEditPackagingHours(run.packaging_minutes != null ? String(run.packaging_minutes / 60) : "");
        setEditIncludePackagingHours(run.include_packaging_hours);
        const defaultStaffCount =
          run.staff.length > 0 ? run.staff.length : (run.staff_count_planned ?? 0);
        setEditPackagingStaffCount(
          run.packaging_staff_count != null
            ? String(run.packaging_staff_count)
            : String(defaultStaffCount),
        );
        setEditBagSealStaffCount(
          run.bag_seal_staff_count != null
            ? String(run.bag_seal_staff_count)
            : String(defaultStaffCount),
        );
        setEditIncludeBagSealHours(run.include_bag_seal_hours);
        // Bag & seal qty always matches the day's production target.
        setBagSealQty(String(run.target_qty ?? ""));
        setBagSealMinutes("");
        try {
          const recipe = await fetchRecipeByFinished(run.finished_item_id);
          if (!cancelled) setDetailRecipe(recipe);
        } catch {
          // no recipe — leave null
        }
      })
      .catch((e: Error) => { if (!cancelled) setDetailError(e.message); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRunId]);

  const saveDetail = async () => {
    if (!detailRun) return;
    setSaving(true);
    setDetailError(null);
    try {
      const updated = await updateProductionRun(detailRun.id, {
        notes: editNotes || null,
        qc_errors: editQcErrors !== "" ? editQcErrors : null,
        packaging_minutes:
          editPackagingHours.trim() === "" ? null : Math.round(Number(editPackagingHours) * 60),
        include_packaging_hours: editIncludePackagingHours,
        packaging_staff_count:
          editPackagingStaffCount.trim() === "" ? null : Number(editPackagingStaffCount),
        bag_seal_staff_count:
          editBagSealStaffCount.trim() === "" ? null : Number(editBagSealStaffCount),
        include_bag_seal_hours: editIncludeBagSealHours,
      });
      const newQty = Number(editCompletedQty);
      if (
        detailRun.status === "completed" &&
        !isNaN(newQty) &&
        newQty !== detailRun.completed_qty
      ) {
        const adjusted = await adjustProductionRunQty(detailRun.id, { new_completed_qty: newQty });
        setDetailRun(adjusted);
        setRuns((prev) => prev.map((r) => (r.id === adjusted.id ? adjusted : r)));
      } else {
        setDetailRun(updated);
        setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
      setSuccess("Saved.");
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const markComplete = async () => {
    if (!detailRun) return;
    const qty = Number(editCompletedQty);
    if (isNaN(qty) || qty <= 0) {
      setDetailError("Enter a valid final qty before marking complete.");
      return;
    }
    if (!confirm(`Mark this run complete with ${qty} units produced?`)) return;
    setCompleting(true);
    setDetailError(null);
    try {
      const updated = await completeProductionRun(detailRun.id, { completed_qty: qty });
      setDetailRun(updated);
      setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setSuccess("Run marked complete.");
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setCompleting(false);
    }
  };

  // Bagging and sealing always happen together for every run, so they're
  // recorded as one action. The qty bagged & sealed always equals the
  // day's production target -- once marked, that qty becomes the final
  // production qty and is no longer separately editable.
  const markBaggedSealed = async () => {
    if (!detailRun) return;
    const qty = Number(bagSealQty);
    if (isNaN(qty) || qty <= 0) {
      setDetailError("Enter a valid qty bagged & sealed.");
      return;
    }
    setMarkingBagSeal(true);
    setDetailError(null);
    try {
      const mins = bagSealMinutes ? Number(bagSealMinutes) : undefined;
      await markProductionRunBagged(detailRun.id, mins);
      const updated = await markProductionRunSealed(detailRun.id, mins);
      setDetailRun(updated);
      setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEditCompletedQty(String(qty));
      setSuccess("Marked as bagged & sealed.");
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setMarkingBagSeal(false);
    }
  };

  const startCompose = (date: string) => {
    setComposeDate(date);
  };

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const itemNameById = useMemo(() => {
    const m = new Map<string, { name: string; sku: string | null }>();
    for (const i of items) m.set(i.id, { name: i.name, sku: i.sku });
    return m;
  }, [items]);

  useEffect(() => {
    void (async () => {
      try {
        const its = await listInventoryItems({ item_type: "product" });
        setItems(its);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listProductionRuns({
        from_date: isoDate(weekStart),
        to_date: isoDate(weekEnd),
      });
      setRuns(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    // Fetch scheduled staff for every day of the week so the badge shows
    // even on days with no production run yet.
    const weekDays = Array.from({ length: 7 }, (_, i) => isoDate(addDays(weekStart, i)));
    void Promise.all(weekDays.map((d) => listScheduledOn(d).then((rows) => ({ d, count: rows.filter((r) => !r.is_production).length })).catch(() => ({ d, count: 0 })))).then((results) => {
      setWeekStaffCounts(new Map(results.map(({ d, count }) => [d, count])));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const runsByDate = useMemo(() => {
    const m = new Map<string, ProductionRun[]>();
    for (const r of runs) {
      const key = r.scheduled_date;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return m;
  }, [runs]);

  const today = isoDate(new Date());

  return (
    <>
      <Header />
      <ProductionNav />
      <main className="mx-auto max-w-7xl px-md py-lg space-y-md">
        <header className="flex flex-wrap items-baseline justify-between gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">
              Phase K · Schedule grid
            </p>
            <h1 className="mt-xs font-serif text-h1 text-stone">Production calendar</h1>
          </div>
          <div className="flex flex-wrap items-center gap-sm text-small">
            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              className="rounded-sm border border-sand bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(mondayOf(new Date()))}
              className="rounded-sm border border-sand bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
            >
              This week
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              className="rounded-sm border border-sand bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
            >
              Next →
            </button>
            <span className="font-mono text-tiny text-stone/60">
              {isoDate(weekStart)} → {isoDate(weekEnd)}
              {loading && " · loading…"}
            </span>
            {canEdit && (
              <>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={async () => {
                    setSyncing(true);
                    setError(null);
                    try {
                      const r = await syncAirtableProductionRuns();
                      setSuccess(`Pulled from Airtable legacy table — ${r.created} created, ${r.updated} updated.`);
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setSyncing(false);
                    }
                  }}
                  className="rounded-sm border border-clay/50 bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-clay/10 disabled:opacity-50"
                  title="Pull Airtable legacy Production Runs → local mirror"
                >
                  {syncing ? "Syncing…" : "↓ Pull Airtable"}
                </button>
                <button
                  type="button"
                  disabled={syncing}
                  onClick={async () => {
                    setSyncing(true);
                    setError(null);
                    try {
                      const r = await pushProductionRunsToAirtable();
                      setSuccess(`Pushed to Airtable — ${r.pushed} pushed, ${r.skipped} skipped, ${r.errors} errors.`);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setSyncing(false);
                    }
                  }}
                  className="rounded-sm border border-terracotta/50 bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                  title="Push platform production runs → Airtable (requires AIRTABLE_PUSH_ENABLED=true)"
                >
                  {syncing ? "Syncing…" : "↑ Push to Airtable"}
                </button>
              </>
            )}
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md border border-success/40 bg-success/10 p-md text-small text-stone">
            ✓ {success}
          </div>
        )}

        <section className="grid grid-cols-1 gap-xs md:grid-cols-7">
          {days.map((d, i) => {
            const key = isoDate(d);
            const dayRuns = runsByDate.get(key) ?? [];
            const isToday = key === today;
            // Staff badge: prefer the work-schedule count (shows even with no runs),
            // fall back to summing across production runs if schedule fetch missed.
            const runStaff = dayRuns.reduce((acc, r) => {
              return acc + (r.staff.length > 0 ? r.staff.length : (r.staff_count_planned ?? 0));
            }, 0);
            const totalStaff = Math.max(weekStaffCounts.get(key) ?? 0, runStaff);
            return (
              <div
                key={key}
                className={`rounded-md border bg-softCream p-sm ${
                  isToday ? "border-terracotta" : "border-sand/30"
                }`}
              >
                <header className="flex items-baseline justify-between">
                  <p className="text-tiny uppercase tracking-widest text-clay">
                    {DAY_LABELS[i]}
                  </p>
                  <div className="flex items-center gap-xs">
                    {totalStaff > 0 && (
                      <span
                        className="inline-flex items-center gap-[2px] rounded-sm bg-clay/10 px-[5px] py-[1px] font-mono text-[10px] text-clay"
                        title={`${totalStaff} staff scheduled`}
                      >
                        <span aria-hidden="true">👤</span>
                        {totalStaff}
                      </span>
                    )}
                    <p className="font-mono text-tiny text-stone/60">
                      {key.slice(5)}
                    </p>
                  </div>
                </header>
                <div className="mt-xs space-y-xs">
                  {dayRuns.length === 0 ? (
                    canEdit ? (
                      <button
                        type="button"
                        onClick={() => startCompose(key)}
                        className="block w-full rounded-sm border border-dashed border-sand bg-warmWhite/50 py-xs text-tiny text-stone/40 hover:border-terracotta hover:text-terracotta"
                      >
                        + Plan a run
                      </button>
                    ) : (
                      <p className="text-tiny text-stone/40">—</p>
                    )
                  ) : (
                    dayRuns.map((r) => {
                      const item = itemNameById.get(r.finished_item_id);
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedRunId(r.id)}
                          className="block w-full rounded-sm border border-sand/40 bg-warmWhite p-xs text-left hover:bg-sand/10"
                        >
                          <p className="text-tiny font-medium text-stone line-clamp-1">
                            {item?.name ?? r.finished_item_id}
                          </p>
                          <p className="font-mono text-tiny text-stone/50">
                            target {r.target_qty ?? "—"}
                            {r.status === "completed" && r.completed_qty !== null && (
                              <> · done {r.completed_qty}</>
                            )}
                          </p>
                          <div className="mt-xs flex flex-wrap items-center gap-xs">
                            <StatusPill status={r.status} />
                            {r.bagged_at && (
                              <span className="rounded-sm bg-success/10 px-xs py-[1px] font-mono text-tiny text-success">
                                bagged
                              </span>
                            )}
                            {r.sealed_at && (
                              <span className="rounded-sm bg-success/15 px-xs py-[1px] font-mono text-tiny text-success">
                                sealed
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                  {canEdit && dayRuns.length > 0 && (
                    <button
                      type="button"
                      onClick={() => startCompose(key)}
                      className="block w-full rounded-sm border border-dashed border-sand bg-warmWhite/40 py-xs text-tiny text-stone/40 hover:border-terracotta hover:text-terracotta"
                    >
                      + Add another
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {composeDate && canEdit && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-stone/40 px-md"
            onClick={() => setComposeDate(null)}
          >
            <div
              className="w-full max-w-lg rounded-lg border border-sand/30 bg-softCream p-lg shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline justify-between gap-md">
                <h2 className="font-serif text-h2 text-stone">Plan a run</h2>
                <button
                  type="button"
                  onClick={() => setComposeDate(null)}
                  className="text-tiny uppercase tracking-widest text-stone/50 hover:text-stone"
                >
                  Cancel
                </button>
              </div>
              <div className="mt-md">
                <CreateRunForm
                  finished={items}
                  initialDate={composeDate}
                  onCreated={async () => {
                    setSuccess(`Planned run created for ${composeDate}.`);
                    setComposeDate(null);
                    await refresh();
                  }}
                  onError={(m) => setError(m)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Run detail panel — inline below calendar */}
        <section className="rounded-lg border border-sand/30 bg-softCream p-lg">
          {!selectedRunId && (
            <p className="text-small text-stone/40 text-center py-md">
              Select a run above to view details
            </p>
          )}
          {selectedRunId && detailLoading && (
            <p className="text-small text-stone/50">Loading…</p>
          )}
          {selectedRunId && detailError && (
            <p className="text-small text-critical">{detailError}</p>
          )}
          {detailRun && (
            <div className="flex flex-col gap-md">
              <div className="flex items-start justify-between gap-md">
                <div>
                  <p className="font-mono text-tiny uppercase tracking-widest text-clay">
                    {detailRun.scheduled_date}
                  </p>
                  <h2 className="mt-xs font-serif text-h2 text-stone">
                    {itemNameById.get(detailRun.finished_item_id)?.name ?? detailRun.finished_item_id}
                  </h2>
                  <div className="mt-xs flex items-center gap-sm">
                    <StatusPill status={detailRun.status} />
                    <span className="font-mono text-tiny text-stone/50">
                      target {detailRun.target_qty ?? "—"}
                      {detailRun.completed_qty !== null && ` · done ${detailRun.completed_qty}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(null)}
                  className="text-stone/40 hover:text-stone"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>

              {/* Key stats */}
              <dl className="grid grid-cols-2 gap-sm text-small md:grid-cols-4">
                <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm">
                  <p className="text-tiny uppercase tracking-widest text-clay">Staff</p>
                  <p className="mt-xs font-mono text-stone">
                    {detailRun.staff.length > 0
                      ? detailRun.staff.length
                      : (detailRun.staff_count_planned ?? "—")}
                    {" "}× {detailRun.hours_planned}h
                  </p>
                </div>
                <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm">
                  <p className="text-tiny uppercase tracking-widest text-clay">Hours total</p>
                  <p className="mt-xs font-mono text-stone">{detailRun.hours_total.toFixed(2)}</p>
                </div>
                <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm">
                  <p className="text-tiny uppercase tracking-widest text-clay">Rate (b/h/p)</p>
                  <p className="mt-xs font-mono text-stone">{detailRun.rate.toFixed(2)}</p>
                </div>
                <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm">
                  <p className="text-tiny uppercase tracking-widest text-clay">Target qty</p>
                  <p className="mt-xs font-mono text-stone">{detailRun.target_qty ?? "—"}</p>
                </div>
                <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm col-span-2 md:col-span-2">
                  <p className="text-tiny uppercase tracking-widest text-clay">Bag &amp; seal time</p>
                  <p className="mt-xs font-mono text-stone">
                    {detailRun.bag_minutes != null || detailRun.seal_minutes != null ? (
                      <>
                        {detailRun.bag_minutes != null && (
                          <span>Bag {detailRun.bag_minutes} min</span>
                        )}
                        {detailRun.bag_minutes != null && detailRun.seal_minutes != null && (
                          <span className="text-stone/40"> · </span>
                        )}
                        {detailRun.seal_minutes != null && (
                          <span>Seal {detailRun.seal_minutes} min</span>
                        )}
                        {(detailRun.bag_minutes != null || detailRun.seal_minutes != null) && (
                          <span className="ml-xs text-stone/50 text-tiny">
                            = {(((detailRun.bag_minutes ?? 0) + (detailRun.seal_minutes ?? 0)) / 60).toFixed(2)}h
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-stone/40">—</span>
                    )}
                  </p>
                  <div className="mt-sm flex flex-wrap items-end gap-sm border-t border-sand/20 pt-sm">
                    <label className="block">
                      <span className="text-tiny uppercase tracking-widest text-clay">
                        Bag &amp; seal staff count
                      </span>
                      <input
                        type="number"
                        min="0"
                        value={editBagSealStaffCount}
                        onChange={(e) => setEditBagSealStaffCount(e.target.value)}
                        className="mt-xs w-20 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:border-terracotta focus:outline-none"
                      />
                    </label>
                    <label className="flex items-center gap-xs pb-xs">
                      <input
                        type="checkbox"
                        checked={editIncludeBagSealHours}
                        onChange={(e) => setEditIncludeBagSealHours(e.target.checked)}
                      />
                      <span className="text-small text-stone">
                        Count bag &amp; seal time toward this run&apos;s total production hours
                      </span>
                    </label>
                  </div>
                  <p className="mt-xs text-tiny text-stone/40">
                    Leave unchecked if bagging/sealing happened on a different day/crew than production.
                  </p>
                </div>
              </dl>

              {/* BOM table */}
              {detailRecipe ? (
                <div>
                  <p className="mb-xs font-mono text-tiny uppercase tracking-widest text-clay">
                    Recipe · {detailRecipe.lines.length} ingredients
                  </p>
                  <div className="overflow-x-auto rounded-sm border border-sand/40">
                    <table className="w-full text-small">
                      <thead>
                        <tr className="border-b border-sand/40 bg-warmWhite/60">
                          <th className="py-xs pl-sm pr-md text-left font-mono text-tiny uppercase tracking-widest text-clay">Ingredient</th>
                          <th className="py-xs pr-sm text-right font-mono text-tiny uppercase tracking-widest text-clay">Per unit</th>
                          <th className="py-xs pr-sm text-right font-mono text-tiny uppercase tracking-widest text-clay">Total needed</th>
                          <th className="py-xs pr-sm text-right font-mono text-tiny uppercase tracking-widest text-clay">Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...detailRecipe.lines]
                          .sort((a, b) =>
                            (a.component_item_type === "packaging" ? 1 : 0) -
                            (b.component_item_type === "packaging" ? 1 : 0),
                          )
                          .map((line) => {
                          const targetQty = detailRun.target_qty ?? 0;
                          return (
                            <tr key={line.id} className="border-t border-sand/20">
                              <td className="py-xs pl-sm pr-md text-stone">
                                {!line.component_sku.startsWith("airtable:") &&
                                  !/^rec[A-Za-z0-9]{10,}$/.test(line.component_sku) && (
                                    <span className="font-mono text-tiny text-stone/50 mr-xs">
                                      {line.component_sku}
                                    </span>
                                  )}
                                {line.component_name}
                              </td>
                              <td className="py-xs pr-sm text-right font-mono tabular-nums text-stone/70">{line.qty_per_unit}</td>
                              <td className="py-xs pr-sm text-right font-mono tabular-nums text-stone font-medium">
                                {(line.qty_per_unit * targetQty).toFixed(1)}
                              </td>
                              <td className="py-xs pr-sm text-right font-mono text-tiny text-stone/50">{line.measurement_unit ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : !detailLoading ? (
                <p className="rounded-sm border border-warning/40 bg-warning/10 px-sm py-xs text-small text-stone">
                  No recipe linked — ingredient quantities unavailable.
                </p>
              ) : null}

              {/* Logging fields */}
              <div className="grid grid-cols-1 gap-sm md:grid-cols-3">
                <label className="block">
                  <span className="font-mono text-tiny uppercase tracking-widest text-clay">Final production qty</span>
                  <input
                    type="number"
                    min="0"
                    value={editCompletedQty}
                    onChange={(e) => setEditCompletedQty(e.target.value)}
                    disabled={!!(detailRun.bagged_at && detailRun.sealed_at)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:border-terracotta focus:outline-none disabled:opacity-60"
                    placeholder={String(detailRun.target_qty ?? "")}
                    title={
                      detailRun.bagged_at && detailRun.sealed_at
                        ? "Locked to the qty bagged & sealed"
                        : undefined
                    }
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-tiny uppercase tracking-widest text-clay">QC issues</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={editQcErrors}
                    onChange={(e) => setEditQcErrors(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:border-terracotta focus:outline-none"
                    placeholder="0"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-tiny uppercase tracking-widest text-clay">Notes</span>
                  <textarea
                    rows={2}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm text-small focus:border-terracotta focus:outline-none"
                    placeholder="General run notes…"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-tiny uppercase tracking-widest text-clay">Packaging hours</span>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={editPackagingHours}
                    onChange={(e) => setEditPackagingHours(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:border-terracotta focus:outline-none"
                    placeholder="hrs"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-tiny uppercase tracking-widest text-clay">Packaging staff count</span>
                  <input
                    type="number"
                    min="0"
                    value={editPackagingStaffCount}
                    onChange={(e) => setEditPackagingStaffCount(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:border-terracotta focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-xs pt-lg">
                  <input
                    type="checkbox"
                    checked={editIncludePackagingHours}
                    onChange={(e) => setEditIncludePackagingHours(e.target.checked)}
                  />
                  <span className="text-small text-stone">Include packaging hours</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-sm border-t border-sand/30 pt-md">
                {(detailRun.status === "planned" || detailRun.status === "in_progress") && (
                  <button
                    type="button"
                    onClick={markComplete}
                    disabled={completing || saving}
                    className="rounded-sm bg-success px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
                  >
                    {completing ? "Completing…" : "Mark complete"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={saveDetail}
                  disabled={saving || completing}
                  className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>

              {/* Bagging & sealing — always done together for every run */}
              <div className="border-t border-sand/30 pt-md">
                <p className="font-mono text-tiny uppercase tracking-widest text-clay">Bagging &amp; sealing</p>
                {detailRun.bagged_at && detailRun.sealed_at ? (
                  <p className="mt-xs text-small text-stone/70">
                    Bagged &amp; sealed {new Date(detailRun.sealed_at).toLocaleString()}
                    {detailRun.bag_minutes !== null && (
                      <span className="ml-xs text-stone/50">· {detailRun.bag_minutes} min</span>
                    )}
                  </p>
                ) : canEdit ? (
                  <div className="mt-xs flex flex-wrap items-end gap-sm">
                    <label className="block">
                      <span className="text-tiny uppercase tracking-widest text-clay">Qty bagged &amp; sealed</span>
                      <input
                        type="number"
                        min="0"
                        value={bagSealQty}
                        onChange={(e) => setBagSealQty(e.target.value)}
                        className="mt-xs w-28 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:border-terracotta focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-tiny uppercase tracking-widest text-clay">Minutes</span>
                      <input
                        type="number"
                        min="0"
                        value={bagSealMinutes}
                        onChange={(e) => setBagSealMinutes(e.target.value)}
                        placeholder="min"
                        className="mt-xs w-20 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:border-terracotta focus:outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={markBaggedSealed}
                      disabled={markingBagSeal}
                      className="rounded-sm bg-terracotta px-md py-xs text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
                    >
                      {markingBagSeal ? "…" : "Mark bagged & sealed"}
                    </button>
                  </div>
                ) : (
                  <p className="mt-xs text-small text-stone/40">Not bagged &amp; sealed</p>
                )}
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function StatusPill({ status }: { status: ProductionRunStatus }) {
  const cls =
    status === "completed"
      ? "bg-success/15 text-success"
      : status === "cancelled"
        ? "bg-stone/15 text-stone/60"
        : status === "in_progress"
          ? "bg-warning/15 text-warning"
          : "bg-terracotta/15 text-terracotta";
  return (
    <span
      className={`mt-xs inline-block rounded-sm px-xs py-[1px] text-[10px] uppercase tracking-widest ${cls}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default function ProductionCalendarPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_inventory]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
