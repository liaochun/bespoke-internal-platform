// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Production schedule v2 — Postgres canonical scheduler (Phase B4).
 *
 * Two-column layout:
 *   - left: planned/completed runs table with a "New run" form on top
 *   - right: detail panel for the selected run -- editable while
 *     planned/in_progress, lockable via "Mark complete" which deducts
 *     the Ingredients through the ledger.
 *
 * Per-staff hours editor lives in the detail panel. Edits trigger
 * server-side capacity recompute, so target_qty always reflects the
 * current numbers without a manual refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminListUsers, type AdminUser } from "@/lib/api";
import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { BomPreflightPanel, CreateRunForm, SkuGroupPicker } from "@/components/CreateRunForm";
import { Header } from "@/components/Header";
import { ProductionNav } from "@/components/ProductionNav";
import { SearchSelect } from "@/components/SearchSelect";
import {
  adjustProductionRunQty,
  completeProductionRun,
  correctProductionRunItem,
  deleteProductionRun,
  fetchProductionRun,
  getBomPreflight,
  getProductionNoHistoryReport,
  getRateHistoryWindow,
  hideProductionRate,
  listInventoryItems,
  listProductionRates,
  listProductionRuns,
  listScheduledOn,
  markProductionRunBagged,
  markProductionRunSealed,
  recomputeRate,
  removeProductionRunStaff,
  rescheduleProductionRun,
  resetRateToBaseline,
  setProductionRunStaff,
  setRateHistoryWindow,
  syncMirrorProductionRuns,
  updateProductionRun,
  listRecipes,
  type BomPreflightReport,
  type MasterItemWithStock,
  type NoHistoryReport,
  type ProductionRateRow,
  type ProductionRun,
  type ProductionRunType,
  type RecipeSummary,
  type ScheduledStaffOnDate,
} from "@/lib/api";
import { CAP, has } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A production run is considered overdue when its scheduled_date is before
 * today and its status is still planned or in_progress (i.e. not completed
 * or cancelled). These runs are highlighted in the table and a one-click
 * reschedule button is shown (#6c4f1243).
 */
function isOverdue(run: ProductionRun): boolean {
  if (run.status !== "planned" && run.status !== "in_progress") return false;
  return run.scheduled_date < todayIso();
}

function StatusPill({ status }: { status: ProductionRun["status"] }) {
  const cls =
    status === "completed"
      ? "bg-success/15 text-success"
      : status === "cancelled"
        ? "bg-stone/15 text-stone/60"
        : status === "in_progress"
          ? "bg-warning/15 text-warning"
          : "bg-terracotta/15 text-terracotta";
  return (
    <span className={`rounded-sm px-sm py-xs text-tiny uppercase tracking-widest ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function RunTypeBadge({ runType }: { runType: ProductionRunType }) {
  if (runType === "bagged_sealed_only") {
    return (
      <span className="rounded-sm px-sm py-xs text-tiny uppercase tracking-widest bg-warning/15 text-warning">
        Bagged &amp; sealed only
      </span>
    );
  }
  return null;
}

function ProductionRecommendationsPanel({ finished }: { finished: MasterItemWithStock[] }) {
  const recs = useMemo(() => {
    return finished
      .filter((item) => !item.name.toLowerCase().includes("limited"))
      .flatMap((item) => {
        const torontoQty =
          item.stock_by_location.find((s) => s.location === "toronto")?.quantity ?? 0;
        const wavecrestQty =
          item.stock_by_location.find((s) => s.location === "wavecrest_usa")?.quantity ?? 0;
        const vToronto = parseFloat(item.weekly_velocity_toronto ?? "0") || 0;
        const vWavecrest = parseFloat(item.weekly_velocity_wavecrest ?? "0") || 0;
        const velocity = vToronto + vWavecrest;
        if (velocity === 0) return [];
        const weeks = (torontoQty + wavecrestQty) / velocity;
        if (weeks >= 10) return [];
        return [{ item, weeks, torontoQty, wavecrestQty, velocity }];
      })
      .sort((a, b) => a.weeks - b.weeks);
  }, [finished]);

  if (recs.length === 0) return null;

  return (
    <section className="rounded-md border border-warning/40 bg-warning/5 p-md">
      <h2 className="font-serif text-h3 text-stone">Production recommended</h2>
      <p className="mt-xs text-tiny text-stone/60">
        SKUs with combined (Toronto + Wavecrest) inventory below 10 weeks of velocity.
      </p>
      <div className="mt-sm overflow-x-auto">
        <table className="w-full text-small">
          <thead className="text-tiny uppercase tracking-widest text-clay">
            <tr>
              <th className="py-xs pr-md text-left">SKU</th>
              <th className="py-xs pr-md text-left">Name</th>
              <th className="py-xs pr-md text-right tabular-nums">Toronto</th>
              <th className="py-xs pr-md text-right tabular-nums">Wavecrest</th>
              <th className="py-xs pr-md text-right tabular-nums">Vel/wk</th>
              <th className="py-xs text-right tabular-nums">Weeks left</th>
            </tr>
          </thead>
          <tbody>
            {recs.map(({ item, weeks, torontoQty, wavecrestQty, velocity }) => (
              <tr key={item.id} className="border-t border-sand/30">
                <td className="py-xs pr-md font-mono text-tiny">{item.sku}</td>
                <td className="py-xs pr-md">{item.name}</td>
                <td className="py-xs pr-md text-right font-mono tabular-nums">{torontoQty}</td>
                <td className="py-xs pr-md text-right font-mono tabular-nums">{wavecrestQty}</td>
                <td className="py-xs pr-md text-right font-mono tabular-nums">{velocity.toFixed(1)}</td>
                <td
                  className={`py-xs text-right font-mono tabular-nums font-medium ${
                    weeks < 3 ? "text-critical" : weeks < 6 ? "text-warning" : "text-stone"
                  }`}
                >
                  {weeks.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * No-history report (ticket #fb91d8d6).
 *
 * Finished-good SKUs with zero rows in the ops `production_runs` table
 * (the scheduler's own history), cross-referenced against the read-only
 * `mirror_production_runs` mirror. Rows flagged "mirror evidence"
 * are SKUs ops knows for a fact were produced in the past -- that history
 * just never made it into this scheduler's table, so they show up here
 * with no runs at all despite real production having happened.
 *
 * Collapsed by default (it's a diagnostic view, not a daily workflow) and
 * fetched lazily on first expand so it never slows down page load.
 */
function NoHistoryReportPanel() {
  const [expanded, setExpanded] = useState(false);
  const [report, setReport] = useState<NoHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlyWithEvidence, setOnlyWithEvidence] = useState(true);

  useEffect(() => {
    if (!expanded || report || loading) return;
    setLoading(true);
    setLoadError(null);
    void getProductionNoHistoryReport()
      .then(setReport)
      .catch((e) => setLoadError((e as Error).message ?? "Failed to load report."))
      .finally(() => setLoading(false));
  }, [expanded, report, loading]);

  const rows = useMemo(() => {
    if (!report) return [];
    return onlyWithEvidence ? report.rows.filter((r) => r.has_mirror_evidence) : report.rows;
  }, [report, onlyWithEvidence]);

  return (
    <section className="rounded-md border border-clay/40 bg-clay/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-md py-sm text-left"
      >
        <div>
          <h2 className="font-serif text-h3 text-stone">
            SKUs with no production history
          </h2>
          <p className="mt-xs text-tiny text-stone/60">
            Finished goods with zero rows in this scheduler, cross-referenced against
            production runs imported from the ops mirror.
          </p>
        </div>
        <span className="text-tiny uppercase tracking-widest text-clay">
          {expanded ? "Hide ▲" : "Show ▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-clay/20 px-md pb-md pt-sm">
          {loading && <p className="text-small text-stone/60">Loading…</p>}
          {loadError && (
            <p className="text-small text-critical">Could not load report: {loadError}</p>
          )}
          {report && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-sm">
                <div className="flex flex-wrap gap-md text-tiny text-stone/70">
                  <span>
                    <span className="font-medium text-stone">{report.total_finished_items}</span>{" "}
                    finished SKUs
                  </span>
                  <span>
                    <span className="font-medium text-stone">
                      {report.items_missing_native_history}
                    </span>{" "}
                    with zero scheduler runs
                  </span>
                  <span>
                    <span className="font-medium text-critical">
                      {report.items_missing_with_mirror_evidence}
                    </span>{" "}
                    of those have real mirror production history
                  </span>
                </div>
                <label className="flex items-center gap-xs text-tiny text-stone/70">
                  <input
                    type="checkbox"
                    checked={onlyWithEvidence}
                    onChange={(e) => setOnlyWithEvidence(e.target.checked)}
                  />
                  Only show SKUs with mirror evidence
                </label>
              </div>

              <div className="mt-sm overflow-x-auto">
                <table className="w-full text-small">
                  <thead className="text-tiny uppercase tracking-widest text-clay">
                    <tr>
                      <th className="py-xs pr-md text-left">SKU</th>
                      <th className="py-xs pr-md text-left">Name</th>
                      <th className="py-xs pr-md text-left">Status</th>
                      <th className="py-xs pr-md text-right tabular-nums">Mirror runs</th>
                      <th className="py-xs pr-md text-right tabular-nums">Completed</th>
                      <th className="py-xs pr-md text-right tabular-nums">Finished qty (mirror)</th>
                      <th className="py-xs pr-md text-left">First run</th>
                      <th className="py-xs text-left">Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-md text-stone/50">
                          {report.rows.length === 0
                            ? "No gaps found — every finished SKU has at least one scheduler run."
                            : "No rows match the current filter."}
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <tr key={r.item_id} className="border-t border-sand/30">
                          <td className="py-xs pr-md font-mono text-tiny">{r.sku ?? "—"}</td>
                          <td className="py-xs pr-md">{r.name}</td>
                          <td className="py-xs pr-md text-stone/60">{r.status}</td>
                          <td className="py-xs pr-md text-right font-mono tabular-nums">
                            {r.mirror_run_count}
                          </td>
                          <td className="py-xs pr-md text-right font-mono tabular-nums">
                            {r.mirror_completed_count}
                          </td>
                          <td className="py-xs pr-md text-right font-mono tabular-nums">
                            {r.mirror_total_finished_product}
                          </td>
                          <td className="py-xs pr-md">{r.first_mirror_run_date ?? "—"}</td>
                          <td className="py-xs">{r.last_mirror_run_date ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-sm text-tiny text-stone/50">
                The &ldquo;↓ Sync mirror&rdquo; button above only refreshes the read-only
                mirror — it does not create scheduler runs. Runs with mirror
                evidence can be backfilled via the{" "}
                <code className="font-mono">POST /integrations/mirror/import-ops-production-runs</code>{" "}
                endpoint (not yet wired to a button), or added manually below.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Inner() {
  useDocumentTitle("Production schedule");
  const me = useCurrentUser();
  const canEdit = has(me, CAP.manage_inventory);
  const isAdmin = me.role === "admin" || me.role === "super_admin";
  const isSuperAdmin = me.role === "super_admin";

  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [finished, setFinished] = useState<MasterItemWithStock[]>([]);
  // Unrestricted (no has_recipe filter) product list, used only for name
  // resolution + the SKU filter below. `finished` above stays recipe-only
  // since it feeds the "New run" SKU picker, which intentionally only lists
  // items a run can actually be scheduled against. Without this second list,
  // any run for a recipe-less finished item (e.g. add-on kits, GWP items)
  // fell back to displaying the raw finished_item_id UUID instead of a name.
  const [allProducts, setAllProducts] = useState<MasterItemWithStock[]>([]);
  const [skuFilter, setSkuFilter] = useState<string>("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductionRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);

  const finishedNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of allProducts) m.set(it.id, it.name);
    return m;
  }, [allProducts]);

  const filteredRuns = useMemo(
    () => (skuFilter ? runs.filter((r) => r.finished_item_id === skuFilter) : runs),
    [runs, skuFilter],
  );

  const userNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) m.set(u.id, u.full_name);
    return m;
  }, [users]);

  const refreshList = async () => {
    try {
      const rs = await listProductionRuns();
      setRuns(rs);
      if (!selectedId && rs.length > 0) setSelectedId(rs[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Guards against out-of-order responses: if the user clicks another run
  // before an in-flight fetch for the previous one resolves, a slower
  // earlier request could otherwise land after the newer one and overwrite
  // the correct detail with stale data -- silently breaking the panel until
  // a hard refresh. Only the response matching the *latest* request is ever
  // applied.
  const latestDetailRequestId = useRef<string | null>(null);
  const refreshDetail = async (id: string) => {
    latestDetailRequestId.current = id;
    try {
      const data = await fetchProductionRun(id);
      if (latestDetailRequestId.current === id) setDetail(data);
    } catch (e) {
      if (latestDetailRequestId.current === id) setError((e as Error).message);
    }
  };

  const handleReschedule = async (runId: string) => {
    setReschedulingId(runId);
    setError(null);
    try {
      const updated = await rescheduleProductionRun(runId);
      setSuccess(`Rescheduled to ${updated.scheduled_date}.`);
      await refreshList();
      if (selectedId === runId) await refreshDetail(runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReschedulingId(null);
    }
  };

  useEffect(() => {
    void refreshList();
    void (async () => {
      try {
        const items = await listInventoryItems({ item_type: "product", has_recipe: true });
        setFinished(items);
        const all = await listInventoryItems({ item_type: "product" });
        setAllProducts(all);
        const us = await adminListUsers();
        setUsers(us.filter((u) => u.is_active));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  return (
    <>
      <Header />
      <ProductionNav />
      <main className="mx-auto max-w-7xl px-md py-lg space-y-md">
        <header className="flex flex-wrap items-baseline justify-between gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">
              Phase B · Postgres scheduler
            </p>
            <h1 className="mt-xs font-serif text-h1 text-stone">Production schedule</h1>
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            <p className="text-small text-stone/60">
              {runs.length} run{runs.length === 1 ? "" : "s"} tracked
            </p>
            {canEdit && (
              <button
                type="button"
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true);
                  setError(null);
                  try {
                    const r = await syncMirrorProductionRuns();
                    setSuccess(`Synced from mirror — ${r.created} created, ${r.updated} updated.`);
                    await refreshList();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setSyncing(false);
                  }
                }}
                className="rounded-sm border border-clay/50 bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-clay/10 disabled:opacity-50"
              >
                {syncing ? "Syncing…" : "↓ Sync mirror"}
              </button>
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

        {isAdmin && (
          <DynamicRatesSection
            canEdit={canEdit}
            isAdmin={isAdmin}
            onError={(m) => setError(m)}
            onSuccess={(m) => setSuccess(m)}
          />
        )}

        <ProductionRecommendationsPanel finished={finished} />

        <NoHistoryReportPanel />

        <div className="grid grid-cols-1 gap-md lg:grid-cols-[1fr_1fr] lg:items-start">
          {/* Left: create + list */}
          <section className="min-w-0 overflow-x-hidden space-y-md">
            {canEdit && (
              <CreateRunForm
                finished={finished}
                onCreated={async (run) => {
                  setSuccess("Run created.");
                  setSelectedId(run.id);
                  await refreshList();
                }}
                onError={(m) => setError(m)}
              />
            )}

            {runs.some(isOverdue) && (
              <div className="rounded-md border border-critical/40 bg-critical/5 p-sm">
                <p className="text-small font-medium text-critical">
                  {runs.filter(isOverdue).length} overdue run
                  {runs.filter(isOverdue).length === 1 ? "" : "s"}
                </p>
                <p className="mt-xs text-tiny text-stone/60">
                  Past-dated runs still marked planned or in progress.{" "}
                  Use the &ldquo;→ Next business day&rdquo; button to shift each one forward.
                </p>
              </div>
            )}

            <div className="rounded-md border border-sand/30 bg-softCream">
              <AggregateHitRate runs={runs} />
              <header className="flex flex-wrap items-center justify-between gap-sm px-md py-sm">
                <span className="text-tiny uppercase tracking-widest text-clay">Runs</span>
                <label className="flex items-center gap-xs text-tiny">
                  <span className="uppercase tracking-widest text-clay">Filter by SKU</span>
                  <select
                    value={skuFilter}
                    onChange={(e) => setSkuFilter(e.target.value)}
                    className="rounded-sm border border-sand bg-warmWhite px-sm py-xs text-tiny focus:outline-none focus:border-terracotta"
                  >
                    <option value="">All SKUs</option>
                    {[...allProducts]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.sku ? ` (${item.sku})` : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-small">
                  <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
                    <tr>
                      <Th>Date</Th>
                      <Th>SKU</Th>
                      <Th align="right">Target</Th>
                      <Th align="right">Done</Th>
                      <Th>Status</Th>
                      <Th></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRuns.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-md py-md text-stone/50">
                          {skuFilter ? "No production runs for this SKU." : "No production runs yet."}
                        </td>
                      </tr>
                    ) : (
                      filteredRuns.map((r) => {
                        const active = r.id === selectedId;
                        const overdue = isOverdue(r);
                        return (
                          <tr
                            key={r.id}
                            className={`cursor-pointer border-t border-sand/30 hover:bg-sand/10 ${
                              active
                                ? "bg-terracotta/10"
                                : overdue
                                  ? "bg-critical/5"
                                  : ""
                            }`}
                            onClick={() => setSelectedId(r.id)}
                          >
                            <Td>
                              <span className={overdue ? "font-medium text-critical" : ""}>
                                {r.scheduled_date}
                              </span>
                              {overdue && (
                                <span className="ml-xs rounded-sm bg-critical/15 px-xs py-[2px] font-mono text-tiny text-critical">
                                  overdue
                                </span>
                              )}
                            </Td>
                            <Td>
                              <span className="text-stone">
                                {finishedNameById.get(r.finished_item_id) ?? r.finished_item_id}
                              </span>
                              {r.recipe_id === null && (
                                <span className="ml-xs rounded-sm bg-warning/15 px-xs py-[2px] font-mono text-tiny text-warning">
                                  no recipe
                                </span>
                              )}
                            </Td>
                            <Td align="right" className="font-mono text-stone/80">
                              {r.target_qty ?? "—"}
                            </Td>
                            <Td align="right" className="font-mono text-stone/80">
                              {r.completed_qty ?? "—"}
                            </Td>
                            <Td>
                              <StatusPill status={r.status} />
                            </Td>
                            <Td>
                              {overdue && canEdit && (
                                <button
                                  type="button"
                                  disabled={reschedulingId === r.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleReschedule(r.id);
                                  }}
                                  title="Move to the next business day (Mon–Fri)"
                                  className="max-w-[7rem] rounded-sm border border-critical/40 bg-critical/10 px-sm py-xs text-tiny font-medium leading-snug text-critical hover:bg-critical/20 disabled:opacity-50 whitespace-normal"
                                >
                                  {reschedulingId === r.id ? "…" : "→ Next business day"}
                                </button>
                              )}
                            </Td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Right: detail */}
          <section className="min-w-0 sticky top-[120px] max-h-[calc(100vh-140px)] overflow-y-auto rounded-md border border-sand/30 bg-softCream p-md md:p-lg">
            {!detail ? (
              <p className="text-small text-stone/60">Pick a run to see details.</p>
            ) : (
              <RunDetail
                run={detail}
                finishedName={finishedNameById.get(detail.finished_item_id) ?? "—"}
                finished={finished}
                users={users}
                userNameById={userNameById}
                canEdit={canEdit}
                isSuperAdmin={isSuperAdmin}
                onChanged={async () => {
                  await refreshDetail(detail.id);
                  await refreshList();
                }}
                onDeleted={async () => {
                  setSuccess("Run deleted.");
                  setSelectedId(null);
                  setDetail(null);
                  await refreshList();
                }}
                onError={(m) => setError(m)}
                onSuccess={(m) => setSuccess(m)}
              />
            )}
          </section>
        </div>
      </main>
    </>
  );
}


/**
 * Bagging and sealing milestone panel (ticket #d2d846af).
 *
 * Shows two toggle buttons: "Mark Bagged" and "Mark Sealed".
 * Once a milestone is stamped it shows a green checkmark + timestamp
 * and the button is hidden. Both milestones are independent — you can
 * seal before bagging if needed (no enforced order).
 */
function BagSealPanel({
  run,
  canEdit,
  onChanged,
  onError,
  onSuccess,
}: {
  run: ProductionRun;
  canEdit: boolean;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const [markingBag, setMarkingBag] = useState(false);
  const [markingSeal, setMarkingSeal] = useState(false);
  const [bagHoursInput, setBagHoursInput] = useState(
    run.bag_minutes != null ? String(run.bag_minutes / 60) : "",
  );
  const [sealHoursInput, setSealHoursInput] = useState(
    run.seal_minutes != null ? String(run.seal_minutes / 60) : "",
  );
  const [bagSealStaffCount, setBagSealStaffCount] = useState(
    run.bag_seal_staff_count !== null
      ? String(run.bag_seal_staff_count)
      : String(run.staff.length > 0 ? run.staff.length : run.staff_count_planned),
  );
  const [includeBagSealHours, setIncludeBagSealHours] = useState(
    run.include_bag_seal_hours,
  );
  const [savingBagSealSettings, setSavingBagSealSettings] = useState(false);

  const formatTs = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-CA", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleBag = async () => {
    setMarkingBag(true);
    try {
      const mins = bagHoursInput
        ? Math.round(Math.max(0, Number(bagHoursInput) || 0) * 60)
        : undefined;
      await markProductionRunBagged(run.id, mins);
      onSuccess("Marked as bagged.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setMarkingBag(false);
    }
  };

  const handleSeal = async () => {
    setMarkingSeal(true);
    try {
      const mins = sealHoursInput
        ? Math.round(Math.max(0, Number(sealHoursInput) || 0) * 60)
        : undefined;
      await markProductionRunSealed(run.id, mins);
      onSuccess("Marked as sealed.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setMarkingSeal(false);
    }
  };

  const saveBagSealSettings = async () => {
    setSavingBagSealSettings(true);
    try {
      await updateProductionRun(run.id, {
        bag_seal_staff_count:
          bagSealStaffCount === "" ? null : Math.max(1, Math.round(Number(bagSealStaffCount) || 0)),
        include_bag_seal_hours: includeBagSealHours,
      });
      onSuccess("Bagging & sealing settings saved.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingBagSealSettings(false);
    }
  };

  const combinedBagSealMinutes =
    run.bag_minutes != null || run.seal_minutes != null
      ? (run.bag_minutes ?? 0) + (run.seal_minutes ?? 0)
      : null;

  return (
    <section className="mt-lg rounded-md border border-sand/30 bg-warmWhite p-md">
      <h3 className="font-serif text-h3 text-stone">Bagging &amp; sealing</h3>
      <p className="mt-xs text-tiny text-stone/60">
        Record when this batch was bagged and heat-sealed. Timestamps are permanent once set.
      </p>
      <div className="mt-md flex flex-wrap gap-md">
        {/* Bagged milestone */}
        <div className="flex-1 min-w-[160px]">
          <p className="text-tiny uppercase tracking-widest text-clay">Bagged</p>
          {run.bagged_at ? (
            <div className="mt-xs space-y-xs">
              <div className="flex items-center gap-xs">
                <span className="text-success font-medium">&#10003;</span>
                <span className="text-small text-stone">{formatTs(run.bagged_at)}</span>
              </div>
            </div>
          ) : (
            <div className="mt-xs space-y-xs">
              {canEdit ? (
                <>
                  <div className="flex items-center gap-xs">
                    <input
                      type="number"
                      min={0}
                      step="0.25"
                      placeholder="0.5"
                      value={bagHoursInput}
                      onChange={(e) => setBagHoursInput(e.target.value)}
                      className="w-16 rounded-sm border border-sand bg-warmWhite px-xs py-xs text-small focus:outline-none focus:border-terracotta"
                    />
                    <span className="text-tiny text-stone/50">hrs</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleBag}
                    disabled={markingBag}
                    className="rounded-sm border border-clay/40 bg-warmWhite px-md py-xs text-small text-stone hover:bg-clay/10 disabled:opacity-50"
                  >
                    {markingBag ? "Saving…" : "Mark Bagged"}
                  </button>
                </>
              ) : (
                <span className="text-small text-stone/40">Not yet bagged</span>
              )}
            </div>
          )}
        </div>

        {/* Sealed milestone */}
        <div className="flex-1 min-w-[160px]">
          <p className="text-tiny uppercase tracking-widest text-clay">Sealed</p>
          {run.sealed_at ? (
            <div className="mt-xs space-y-xs">
              <div className="flex items-center gap-xs">
                <span className="text-success font-medium">&#10003;</span>
                <span className="text-small text-stone">{formatTs(run.sealed_at)}</span>
              </div>
            </div>
          ) : (
            <div className="mt-xs space-y-xs">
              {canEdit ? (
                <>
                  <div className="flex items-center gap-xs">
                    <input
                      type="number"
                      min={0}
                      step="0.25"
                      placeholder="0.5"
                      value={sealHoursInput}
                      onChange={(e) => setSealHoursInput(e.target.value)}
                      className="w-16 rounded-sm border border-sand bg-warmWhite px-xs py-xs text-small focus:outline-none focus:border-terracotta"
                    />
                    <span className="text-tiny text-stone/50">hrs</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleSeal}
                    disabled={markingSeal}
                    className="rounded-sm border border-clay/40 bg-warmWhite px-md py-xs text-small text-stone hover:bg-clay/10 disabled:opacity-50"
                  >
                    {markingSeal ? "Saving…" : "Mark Sealed"}
                  </button>
                </>
              ) : (
                <span className="text-small text-stone/40">Not yet sealed</span>
              )}
            </div>
          )}
        </div>
      </div>

      {combinedBagSealMinutes != null ? (
        <p className="mt-sm text-tiny text-stone/60">
          Combined bag &amp; seal time: {(combinedBagSealMinutes / 60).toFixed(2)}h
        </p>
      ) : null}

      {canEdit && (
        <div className="mt-md space-y-sm border-t border-sand/30 pt-md">
          <Field label="Bag & seal staff count">
            <input
              type="number"
              min="1"
              step="1"
              value={bagSealStaffCount}
              onChange={(e) => setBagSealStaffCount(e.target.value)}
              placeholder="e.g. 2"
              className="font-mono"
            />
          </Field>
          <label className="flex items-start gap-sm text-small">
            <input
              type="checkbox"
              checked={includeBagSealHours}
              onChange={(e) => setIncludeBagSealHours(e.target.checked)}
              className="mt-[3px]"
            />
            <span>
              Count bag &amp; seal time toward this run&rsquo;s total production hours
              <span className="block text-tiny text-stone/50">
                Leave unchecked if bagging/sealing happened on a different day/crew than
                production.
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={saveBagSealSettings}
            disabled={savingBagSealSettings}
            className="rounded-sm bg-stone px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
          >
            {savingBagSealSettings ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </section>
  );
}

function RunDetail({
  run,
  finishedName,
  finished,
  users,
  userNameById,
  canEdit,
  isSuperAdmin,
  onChanged,
  onDeleted,
  onError,
  onSuccess,
}: {
  run: ProductionRun;
  finishedName: string;
  finished: MasterItemWithStock[];
  users: AdminUser[];
  userNameById: Map<string, string>;
  canEdit: boolean;
  isSuperAdmin: boolean;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const onDelete = async () => {
    if (!confirm("Delete this production run? Only allowed before completion.")) return;
    try {
      await deleteProductionRun(run.id);
      await onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const onForceDelete = async () => {
    if (
      !confirm(
        `Force-delete this completed run (${finishedName} · ${run.scheduled_date})?\n\nThis bypasses the ledger guard. Inventory deductions already made will NOT be reversed.`,
      )
    )
      return;
    try {
      await deleteProductionRun(run.id, true);
      await onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Super-admin-only fix for a completed run that was linked to the wrong
  // item entirely -- distinct from "Change bath" above, which is hidden
  // once a run completes because the ledger has already posted against
  // the old item's recipe. This reverses those postings and reposts fresh
  // ones for the corrected item (see correct_run_finished_item in
  // production.py).
  const [showCorrectItemPicker, setShowCorrectItemPicker] = useState(false);
  const [correctingItem, setCorrectingItem] = useState(false);

  const onCorrectItem = async (newItemId: string) => {
    if (!newItemId || newItemId === run.finished_item_id) {
      setShowCorrectItemPicker(false);
      return;
    }
    const newName = finished.find((i) => i.id === newItemId)?.name ?? newItemId;
    if (
      !confirm(
        `Correct this COMPLETED run from "${finishedName}" to "${newName}"?\n\n` +
          `This reverses every inventory transaction this run originally posted ` +
          `(ingredient/packaging deductions + the finished-item credit) and reposts ` +
          `fresh ones for ${newName}'s own recipe at the same completed quantity. ` +
          `Use this only when the wrong item was linked entirely -- not for a display/name issue.`,
      )
    )
      return;
    setCorrectingItem(true);
    try {
      await correctProductionRunItem(run.id, newItemId);
      setShowCorrectItemPicker(false);
      onSuccess(`Corrected to ${newName} -- ledger reversed and reposted.`);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCorrectingItem(false);
    }
  };

  const locked = run.status === "completed" || !canEdit;
  const [runType, setRunType] = useState<ProductionRunType>(run.run_type);
  const [staff, setStaff] = useState(String(run.staff_count_planned));
  const [hours, setHours] = useState(String(run.hours_planned));
  const [rate, setRate] = useState(
    run.baths_per_hour_per_person !== null ? String(run.baths_per_hour_per_person) : "",
  );
  const [notes, setNotes] = useState(run.notes ?? "");
  const [qcErrors, setQcErrors] = useState(run.qc_errors ?? "");
  const [packagingHours, setPackagingHours] = useState(
    run.packaging_minutes !== null ? String(run.packaging_minutes / 60) : "",
  );
  const [includePackagingHours, setIncludePackagingHours] = useState(
    run.include_packaging_hours,
  );
  const [packagingStaffCount, setPackagingStaffCount] = useState(
    run.packaging_staff_count !== null
      ? String(run.packaging_staff_count)
      : String(run.staff.length > 0 ? run.staff.length : run.staff_count_planned),
  );
  const [savingQc, setSavingQc] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(run.scheduled_date);
  const [completedQty, setCompletedQty] = useState(String(run.target_qty ?? 0));
  const [completedQtyDirty, setCompletedQtyDirty] = useState(false);

  // Re-seed locals when the selected run changes.
  useEffect(() => {
    setRunType(run.run_type);
    setStaff(String(run.staff_count_planned));
    setHours(String(run.hours_planned));
    setRate(
      run.baths_per_hour_per_person !== null ? String(run.baths_per_hour_per_person) : "",
    );
    setNotes(run.notes ?? "");
    setQcErrors(run.qc_errors ?? "");
    setPackagingHours(run.packaging_minutes !== null ? String(run.packaging_minutes / 60) : "");
    setIncludePackagingHours(run.include_packaging_hours);
    setPackagingStaffCount(
      run.packaging_staff_count !== null
        ? String(run.packaging_staff_count)
        : String(run.staff.length > 0 ? run.staff.length : run.staff_count_planned),
    );
    setScheduledDate(run.scheduled_date);
    setCompletedQty(String(run.completed_qty ?? run.target_qty ?? 0));
    setCompletedQtyDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  // Re-sync the rate field after a save so clearing/setting the override
  // is reflected immediately (#e199bd75).
  useEffect(() => {
    setRate(
      run.baths_per_hour_per_person !== null ? String(run.baths_per_hour_per_person) : "",
    );
  }, [run.baths_per_hour_per_person]);

  // Follow target_qty when it updates (e.g. after saving staff/hours) unless the
  // user has already manually typed a custom value in this session.
  useEffect(() => {
    if (!completedQtyDirty) {
      setCompletedQty(String(run.completed_qty ?? run.target_qty ?? 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.target_qty]);

  const [savingFields, setSavingFields] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addHours, setAddHours] = useState("4");

  // Recipe linking state
  const [showRecipePicker, setShowRecipePicker] = useState(false);
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [recipesError, setRecipesError] = useState<string | null>(null);
  const [linkingRecipe, setLinkingRecipe] = useState(false);

  useEffect(() => {
    if (!showRecipePicker) return;
    setRecipesLoading(true);
    setRecipesError(null);
    void listRecipes(false)
      .then(setRecipes)
      .catch((e) => setRecipesError((e as Error).message ?? "Failed to load recipes."))
      .finally(() => setRecipesLoading(false));
  }, [showRecipePicker]);

  const onLinkRecipe = async (recipeId: string) => {
    setLinkingRecipe(true);
    try {
      await updateProductionRun(run.id, { recipe_id: recipeId });
      setShowRecipePicker(false);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLinkingRecipe(false);
    }
  };

  // Switching which bath this run produces (#northbound-ops-dashboard). Recipe
  // link and any per-run rate override follow the new item automatically
  // server-side -- see production.py update_run. Safe pre-completion only:
  // the ledger hasn't been touched yet, so there's nothing to reverse.
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [changingItem, setChangingItem] = useState(false);

  const onChangeItem = async (newItemId: string) => {
    if (!newItemId || newItemId === run.finished_item_id) {
      setShowItemPicker(false);
      return;
    }
    const newName = finished.find((i) => i.id === newItemId)?.name ?? newItemId;
    if (
      !confirm(
        `Switch this run from "${finishedName}" to "${newName}"?\n\n` +
          `The recipe and ingredient checks will follow the new item automatically. ` +
          `Any custom production-rate override on this run will be cleared so it uses ` +
          `${newName}'s own default rate.`,
      )
    )
      return;
    setChangingItem(true);
    try {
      await updateProductionRun(run.id, { finished_item_id: newItemId });
      setShowItemPicker(false);
      onSuccess(`Switched to ${newName}.`);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setChangingItem(false);
    }
  };

  // #cc20e675: staff already scheduled to work (a shift) on the run's date are
  // excluded from the add picker to avoid double-booking. Advisory fetch.
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listScheduledOn(scheduledDate);
        if (!cancelled) setScheduledIds(new Set(rows.map((r) => r.user_id)));
      } catch {
        /* advisory — never blocks adding staff */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduledDate]);

  // #47338733: per-ingredient qty required for this run, pulled from the recipe.
  const [bom, setBom] = useState<BomPreflightReport | null>(null);
  const [bomError, setBomError] = useState<string | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const qty = run.target_qty ?? 0;
    if (!run.finished_item_id || qty <= 0) {
      setBom(null);
      setBomError(null);
      setBomLoading(false);
      return;
    }
    setBomError(null);
    setBomLoading(true);
    void (async () => {
      try {
        const r = await getBomPreflight(run.finished_item_id, qty);
        if (!cancelled) {
          setBom(r);
          setBomLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setBom(null);
          setBomError((e as Error).message ?? "Failed to load ingredients from recipe.");
          setBomLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run.id, run.finished_item_id, run.target_qty]);

  const saveFields = async () => {
    setSavingFields(true);
    try {
      await updateProductionRun(run.id, {
        scheduled_date: scheduledDate,
        run_type: runType,
        staff_count_planned: Math.max(1, Number(staff) || 1),
        hours_planned: Math.max(0, Number(hours) || 0),
        baths_per_hour_per_person: rate === "" ? null : Number(rate),
        notes: notes || null,
      });
      onSuccess("Run updated.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingFields(false);
    }
  };

  const saveQc = async () => {
    const togglingPackagingHours = includePackagingHours !== run.include_packaging_hours;
    if (togglingPackagingHours && run.status === "completed") {
      if (
        !confirm(
          "This run is already completed. Changing this will override its production " +
            "rate and target quantity, recalculated from the actual units completed " +
            "divided by the total time (including packaging), instead of the original " +
            "planning-time rate. Continue?",
        )
      )
        return;
    }
    setSavingQc(true);
    try {
      await updateProductionRun(run.id, {
        qc_errors: qcErrors !== "" ? qcErrors : null,
        packaging_minutes:
          packagingHours === "" ? null : Math.round(Math.max(0, Number(packagingHours) || 0) * 60),
        include_packaging_hours: includePackagingHours,
        packaging_staff_count:
          packagingStaffCount === "" ? null : Math.max(1, Math.round(Number(packagingStaffCount) || 0)),
      });
      onSuccess("QC saved.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingQc(false);
    }
  };

  const addStaff = async () => {
    if (!addUserId) {
      onError("Pick a staff member.");
      return;
    }
    try {
      await setProductionRunStaff(run.id, {
        user_id: addUserId,
        hours: Math.max(0, Number(addHours) || 0),
      });
      onSuccess("Staff hours saved.");
      setAddUserId("");
      setAddHours("4");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const onComplete = async () => {
    // Bag & seal is a mid-production step — not a completed run. Boxing still required.
    if (runType === "bagged_sealed_only") {
      if (
        !confirm(
          "Mark this run as Bagged & Sealed? Status will stay in-progress — boxing is still needed to fully complete.",
        )
      )
        return;
      setCompleting(true);
      try {
        if (runType !== run.run_type) {
          await updateProductionRun(run.id, { run_type: runType });
        }
        await updateProductionRun(run.id, { status: "in_progress" });
        onSuccess("Marked as Bagged & Sealed — complete boxing to finish the run.");
        await onChanged();
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setCompleting(false);
      }
      return;
    }

    const qty = Number(completedQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      onError("Completed qty must be > 0.");
      return;
    }
    if (
      !confirm(
        `Mark this run completed and deduct ${qty} units from inventory via the Ingredients? This action is recorded in the ledger and not easily reversible.`,
      )
    )
      return;
    setCompleting(true);
    try {
      if (runType !== run.run_type) {
        await updateProductionRun(run.id, { run_type: runType });
      }
      await completeProductionRun(run.id, { completed_qty: qty });
      onSuccess("Run completed, Ingredients deducted.");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCompleting(false);
    }
  };

  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-sm">
        <div>
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">
            {run.id.slice(0, 8)}
          </p>
          <div className="flex items-baseline gap-sm">
            <h2 className="font-serif text-h2 text-stone">{finishedName}</h2>
            {!locked && (
              <button
                type="button"
                onClick={() => setShowItemPicker((v) => !v)}
                className="text-tiny uppercase tracking-widest text-stone/50 hover:text-terracotta hover:underline"
              >
                {showItemPicker ? "Cancel" : "Change bath"}
              </button>
            )}
          </div>
          {showItemPicker && (
            <div className="mt-sm max-w-sm">
              <SkuGroupPicker
                items={finished}
                value={run.finished_item_id}
                onChange={(id) => void onChangeItem(id)}
              />
              {changingItem && (
                <p className="mt-xs text-tiny text-stone/50">Switching…</p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-xs">
          <StatusPill status={run.status} />
          <RunTypeBadge runType={run.run_type} />
          {!locked && (
            <button
              type="button"
              onClick={onDelete}
              className="text-tiny uppercase tracking-widest text-stone/60 hover:text-critical hover:underline"
            >
              Delete run
            </button>
          )}
          {run.status === "completed" && isSuperAdmin && (
            <button
              type="button"
              onClick={() => setShowCorrectItemPicker((v) => !v)}
              className="text-tiny uppercase tracking-widest text-stone/50 hover:text-terracotta hover:underline"
              title="Super admin: fix a completed run linked to the wrong item (reverses + reposts the ledger)"
            >
              {showCorrectItemPicker ? "Cancel" : "Correct item"}
            </button>
          )}
          {run.status === "completed" && isSuperAdmin && (
            <button
              type="button"
              onClick={onForceDelete}
              className="text-tiny uppercase tracking-widest text-stone/40 hover:text-critical hover:underline"
              title="Super admin: force-delete a completed run (ledger deductions are NOT reversed)"
            >
              Force delete
            </button>
          )}
        </div>
      </header>

      {showCorrectItemPicker && (
        <div className="mt-sm max-w-sm">
          <p className="mb-xs text-tiny text-stone/60">
            Reverses this run&rsquo;s ledger postings and reposts fresh ones for the
            corrected item. Use only when the wrong item was linked entirely.
          </p>
          <SkuGroupPicker
            items={finished}
            value={run.finished_item_id}
            onChange={(id) => void onCorrectItem(id)}
          />
          {correctingItem && (
            <p className="mt-xs text-tiny text-stone/50">Correcting…</p>
          )}
        </div>
      )}

      {run.recipe_id === null && (
        <div className="mt-md rounded-md border border-warning/40 bg-warning/10 p-sm text-small text-stone">
          <p className="font-medium text-warning">No recipe linked — rates cannot be calculated.</p>
          {!showRecipePicker ? (
            <div className="mt-xs flex items-center gap-sm">
              <button
                type="button"
                onClick={() => setShowRecipePicker(true)}
                className="rounded-sm border border-warning/50 bg-warning/10 px-sm py-xs text-tiny font-medium text-warning hover:bg-warning/20"
              >
                Link recipe
              </button>
            </div>
          ) : (
            <div className="mt-sm space-y-xs">
              {recipesLoading ? (
                <p className="text-tiny text-stone/50">Loading recipes…</p>
              ) : recipesError ? (
                <p className="text-tiny text-critical">
                  Failed to load recipes: {recipesError}
                </p>
              ) : (
                <>
                  {recipes
                    .filter((r) => r.finished_item_id === run.finished_item_id)
                    .map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        disabled={linkingRecipe}
                        onClick={() => void onLinkRecipe(r.id)}
                        className="block w-full rounded-sm border border-sand/30 bg-warmWhite px-sm py-xs text-left text-small hover:bg-sand/20 disabled:opacity-50"
                      >
                        {r.finished_name} {r.name ? `— ${r.name}` : ""}
                      </button>
                    ))}
                  {recipes.filter((r) => r.finished_item_id === run.finished_item_id).length === 0 && (
                    <p className="text-tiny text-stone/50">
                      No existing recipes for this item.
                    </p>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => setShowRecipePicker(false)}
                className="text-tiny text-stone/40 hover:text-stone hover:underline"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <dl className="mt-md grid grid-cols-2 gap-sm text-small md:grid-cols-3">
        <Stat label="Hours total" value={run.hours_total.toFixed(2)} />
        <Stat label="Rate (b/h/p)" value={run.rate.toFixed(2)} />
        <Stat label="Target qty" value={run.target_qty ?? "—"} />
      </dl>

      <fieldset className="mt-md space-y-sm" disabled={locked}>
        <div className="grid grid-cols-2 gap-sm md:grid-cols-4">
          <Field label="Date">
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Staff">
            <input
              type="number"
              min="1"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Hours">
            <input
              type="number"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Rate (override)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder={String(run.rate.toFixed(2))}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        {!locked && (
          <button
            type="button"
            onClick={saveFields}
            disabled={savingFields}
            className="rounded-sm bg-stone px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
          >
            {savingFields ? "Saving…" : "Save"}
          </button>
        )}
      </fieldset>

      {/* Per-staff hours */}
      <section className="mt-lg rounded-md border border-sand/30 bg-warmWhite p-md">
        <header className="flex items-baseline justify-between">
          <h3 className="font-serif text-h3 text-stone">Per-staff hours</h3>
          <p className="text-tiny text-stone/50">
            Overrides the {run.staff_count_planned}-staff × {run.hours_planned}h estimate when any
            row exists.
          </p>
        </header>
        {run.staff.length === 0 ? (
          <p className="mt-sm text-small text-stone/50">
            No per-staff rows; falling back to the planned headcount estimate.
          </p>
        ) : (
          <ul className="mt-sm divide-y divide-sand/30">
            {run.staff.map((s) => (
              <StaffHoursRow
                key={s.user_id}
                runId={run.id}
                userId={s.user_id}
                userName={userNameById.get(s.user_id) ?? s.user_id}
                initialHours={s.hours}
                initialShiftHours={s.shift_hours}
                locked={locked}
                onChanged={onChanged}
                onError={onError}
                onSuccess={onSuccess}
              />
            ))}
          </ul>
        )}
        {!locked && (
          <div className="mt-sm flex flex-wrap items-end gap-sm">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Staff member</span>
              <span className="mt-xs block min-w-[180px]">
                <SearchSelect
                  value={addUserId}
                  onChange={setAddUserId}
                  placeholder="Search staff…"
                  options={users
                    .filter(
                      (u) =>
                        !run.staff.some((s) => s.user_id === u.id) &&
                        !scheduledIds.has(u.id),
                    )
                    .map((u) => ({ value: u.id, label: u.full_name }))}
                />
              </span>
            </label>
            <Field label="Hours">
              <input
                type="number"
                step="0.25"
                min="0"
                value={addHours}
                onChange={(e) => setAddHours(e.target.value)}
                className="font-mono"
              />
            </Field>
            <button
              type="button"
              onClick={addStaff}
              className="rounded-sm bg-stone px-md py-sm text-small font-medium text-warmWhite hover:opacity-90"
            >
              Set hours
            </button>
          </div>
        )}
      </section>

      {/* Ingredients required for this run, from the recipe (#47338733) */}
      <section className="mt-lg">
        <div className="flex items-baseline gap-sm">
          <h3 className="font-serif text-h3 text-stone">Ingredients required</h3>
          {bomLoading && (
            <span className="text-tiny text-stone/40">loading…</span>
          )}
        </div>
        {bomError ? (
          <div className="mt-xs rounded-sm border border-critical/30 bg-critical/5 px-sm py-sm text-small text-stone">
            <span className="font-medium text-critical">Could not load ingredients: </span>
            {bomError}
          </div>
        ) : bom ? (
          <>
            <p className="mt-xs text-small text-stone/60">
              Per the active recipe, for the {run.target_qty ?? 0}-unit target.
            </p>
            <div className="mt-sm">
              <BomPreflightPanel report={bom} />
            </div>
          </>
        ) : !bomLoading ? (
          <p className="mt-xs text-small text-stone/50">
            {(run.target_qty ?? 0) > 0
              ? "No recipe found — add one on the Recipes page before completing this run."
              : "Set staff and hours, then save to calculate ingredient requirements."}
          </p>
        ) : null}
      </section>

      {/* Bag & Seal milestones — ticket #d2d846af */}
      <BagSealPanel
        run={run}
        canEdit={canEdit}
        onChanged={onChanged}
        onError={onError}
        onSuccess={onSuccess}
      />

      {/* QC & Packaging — always editable, even on completed runs */}
      <section className="mt-lg rounded-md border border-sand/30 bg-warmWhite p-md">
        <h3 className="font-serif text-h3 text-stone">QC &amp; Packaging</h3>
        <div className="mt-md space-y-sm">
          <Field label="QC issues (count)">
            <input
              type="number"
              min="0"
              step="1"
              value={qcErrors}
              onChange={(e) => setQcErrors(e.target.value)}
              placeholder="0"
              className="font-mono"
            />
          </Field>
          <Field label="Packaging time (hours)">
            <input
              type="number"
              min="0"
              step="0.25"
              value={packagingHours}
              onChange={(e) => setPackagingHours(e.target.value)}
              placeholder="e.g. 0.75"
              className="font-mono"
            />
          </Field>
          <Field label="Packaging staff count">
            <input
              type="number"
              min="1"
              step="1"
              value={packagingStaffCount}
              onChange={(e) => setPackagingStaffCount(e.target.value)}
              placeholder="e.g. 2"
              className="font-mono"
            />
          </Field>
          <label className="flex items-start gap-sm text-small">
            <input
              type="checkbox"
              checked={includePackagingHours}
              onChange={(e) => setIncludePackagingHours(e.target.checked)}
              className="mt-[3px]"
            />
            <span>
              Count packaging time toward this run&rsquo;s total production hours
              <span className="block text-tiny text-stone/50">
                Leave unchecked if packaging spilled into another day (e.g. the
                day&rsquo;s target was already hit and bagging finished later) —
                packaging time still gets tracked, just not added to the total.
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={saveQc}
            disabled={savingQc}
            className="rounded-sm bg-stone px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
          >
            {savingQc ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* Complete */}
      {!locked && (() => {
        const defaultQty = String(run.target_qty ?? 0);
        const usingDefault = completedQty === defaultQty;
        return (
          <section className="mt-lg rounded-md border border-warning/40 bg-warning/5 p-md">
            <h3 className="font-serif text-h3 text-stone">Complete run</h3>
            <p className="mt-xs text-small text-stone/60">
              Writes one ledger row per Ingredients component (deduct) and one credit for the finished
              item. Irreversible from this UI; ledger reversal requires manual entries.
            </p>
            <div className="mt-sm flex flex-wrap items-end gap-sm">
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">
                  Completed qty
                </span>
                <span className="mt-xs block">
                  <input
                    type="number"
                    min="1"
                    value={completedQty}
                    onChange={(e) => { setCompletedQty(e.target.value); setCompletedQtyDirty(true); }}
                    className={`w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:outline-none focus:border-terracotta ${
                      usingDefault ? "text-stone/40" : "text-stone"
                    }`}
                  />
                </span>
                <span className="mt-xs block text-tiny text-stone/50">
                  Default = target ({defaultQty}). Override before committing if the actual
                  yield differs.
                </span>
              </label>
              {/* Run type selector — beside the complete button (#cd54e950 / #eb435daf) */}
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">Run type</span>
                <select
                  value={runType}
                  onChange={(e) => setRunType(e.target.value as ProductionRunType)}
                  className="mt-xs block rounded-sm border border-sand bg-warmWhite px-sm py-sm text-small focus:outline-none focus:border-terracotta"
                >
                  <option value="finished">Finished product</option>
                  <option value="bagged_sealed_only">Bagged &amp; sealed only</option>
                </select>
              </label>
              <button
                type="button"
                onClick={onComplete}
                disabled={completing}
                className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
              >
                {completing
                  ? "Saving…"
                  : runType === "bagged_sealed_only"
                    ? "Mark as Bagged & Sealed"
                    : "Mark complete + deduct Ingredients"}
              </button>
            </div>
          </section>
        );
      })()}

      {run.status === "completed" && (() => {
        const target = run.target_qty ?? 0;
        const done = run.completed_qty ?? 0;
        const hitRate = target > 0 ? (done / target) * 100 : null;
        const tone =
          hitRate === null
            ? "text-stone"
            : hitRate >= 95
              ? "text-success"
              : hitRate >= 80
                ? "text-warning"
                : "text-critical";
        const variance = done - target;
        return (
          <section className="mt-lg rounded-md border border-success/30 bg-success/5 p-md text-small">
            <div className="flex flex-wrap items-baseline justify-between gap-sm">
              <div>
                <p>
                  <span className="font-medium text-stone">Completed:</span>{" "}
                  <span className="font-mono">{done}</span> units on{" "}
                  {run.completed_at?.split("T")[0]}.
                </p>
                <p className="mt-xs text-tiny text-stone/60">
                  Target {target}. Variance{" "}
                  <span className="font-mono">
                    {variance > 0 ? "+" : ""}
                    {variance}
                  </span>
                  .
                </p>
              </div>
              {hitRate !== null && (
                <div className="text-right">
                  <p className="text-tiny uppercase tracking-widest text-clay">Hit rate</p>
                  <p className={`font-serif text-h2 ${tone}`}>{hitRate.toFixed(0)}%</p>
                </div>
              )}
            </div>
            {canEdit && (
              <AdjustQtyForm
                runId={run.id}
                currentQty={done}
                onSaved={async (msg) => {
                  onSuccess(msg);
                  await onChanged();
                }}
                onError={onError}
              />
            )}
            <p className="mt-sm text-tiny text-stone/60">
              Ingredients ledger entries committed. Locate them via reference_id = this run id in the
              inventory ledger.
            </p>
          </section>
        );
      })()}
    </>
  );
}

function AdjustQtyForm({
  runId,
  currentQty,
  onSaved,
  onError,
}: {
  runId: string;
  currentQty: number;
  onSaved: (msg: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(String(currentQty));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setVal(String(currentQty));
  }, [open, currentQty]);

  const submit = async () => {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) {
      onError("New qty must be a positive number.");
      return;
    }
    if (n === currentQty) {
      onError("New qty equals current; nothing to adjust.");
      return;
    }
    const delta = n - currentQty;
    if (
      !confirm(
        `Adjust completed qty from ${currentQty} to ${n} (${delta > 0 ? "+" : ""}${delta})? Ingredients ledger will be corrected.`,
      )
    )
      return;
    setBusy(true);
    try {
      await adjustProductionRunQty(runId, { new_completed_qty: n });
      await onSaved(`Adjusted from ${currentQty} to ${n}. Ledger updated.`);
      setOpen(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-sm text-tiny uppercase tracking-widest text-clay hover:underline"
      >
        Adjust completed qty
      </button>
    );
  }
  return (
    <div className="mt-sm flex flex-wrap items-end gap-sm rounded-sm border border-warning/40 bg-warning/5 p-sm">
      <label className="text-small">
        <span className="text-tiny uppercase tracking-widest text-clay">New completed qty</span>
        <input
          type="number"
          min="1"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="mt-xs w-32 rounded-sm border border-sand bg-warmWhite px-sm py-sm font-mono text-small focus:outline-none focus:border-terracotta"
        />
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Adjusting…" : "Save adjustment"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-sm border border-sand px-md py-sm text-small text-stone/60 hover:bg-sand/20"
      >
        Cancel
      </button>
      <p className="w-full text-tiny text-stone/60">
        Writes a delta to the ledger: Ingredients components and finished output are corrected by
        (new − current) × recipe line. Use when actual yield differed after committing.
      </p>
    </div>
  );
}

function DynamicRatesSection({
  canEdit,
  isAdmin,
  onError,
  onSuccess,
}: {
  canEdit: boolean;
  isAdmin: boolean;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ProductionRateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [window, setWindowVal] = useState<number | null>(null);
  const [windowDraft, setWindowDraft] = useState<string>("");
  const [savingWindow, setSavingWindow] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [r, w] = await Promise.all([
        listProductionRates(showHidden),
        getRateHistoryWindow(),
      ]);
      setRows(r);
      setWindowVal(w.window);
      setWindowDraft(String(w.window));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const windowDirty =
    window !== null && Number(windowDraft) !== window && windowDraft.trim() !== "";

  const saveWindow = async () => {
    const n = Number(windowDraft);
    if (!Number.isFinite(n) || n < 2 || n > 50) {
      onError("Window must be between 2 and 50.");
      return;
    }
    setSavingWindow(true);
    try {
      const res = await setRateHistoryWindow(n);
      setWindowVal(res.window);
      setWindowDraft(String(res.window));
      onSuccess(`History window set to last ${res.window} runs.`);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingWindow(false);
    }
  };

  const onRecompute = async (itemId: string, name: string) => {
    try {
      const res = await recomputeRate(itemId);
      if (res.skipped) {
        onSuccess(`${name}: ${res.skipped}`);
      } else if (res.new_rate !== res.old_rate) {
        const pct = Math.round((res.avg_hit_rate ?? 0) * 100);
        onSuccess(
          `${name}: rate ${res.old_rate?.toFixed(2)} -> ${res.new_rate?.toFixed(
            2,
          )} (avg hit ${pct}%)`,
        );
      }
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const onHide = async (itemId: string, hidden: boolean, name: string) => {
    try {
      await hideProductionRate(itemId, hidden);
      onSuccess(hidden ? `${name} hidden from rates table.` : `${name} shown in rates table.`);
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const withHistory = rows.filter((r) => r.runs_considered > 0);
  const withoutHistory = rows.filter((r) => r.runs_considered === 0);

  // Only load rates when the section is first expanded
  useEffect(() => {
    if (expanded && rows.length === 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  return (
    <section className="rounded-md border border-sand/30 bg-softCream p-md">
      <header
        className="flex flex-wrap items-baseline justify-between gap-sm cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <p className="text-tiny uppercase tracking-widest text-clay">Dynamic rate tuner</p>
          <h2 className="font-serif text-h2 text-stone">
            Target rates per finished SKU{" "}
            <span className="font-sans text-small text-stone/40">{expanded ? "▾" : "▸"}</span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex items-center gap-xs text-tiny uppercase tracking-widest text-clay">
            Window (last N runs)
            <input
              type="number"
              min="2"
              max="50"
              value={windowDraft}
              disabled={!isAdmin || savingWindow}
              onChange={(e) => setWindowDraft(e.target.value)}
              className={`ml-xs w-16 rounded-sm border border-sand bg-warmWhite px-xs py-xs text-right font-mono text-small disabled:opacity-60 focus:outline-none focus:border-terracotta ${
                windowDirty ? "bg-terracotta/5" : ""
              }`}
            />
          </label>
          {isAdmin && windowDirty && (
            <button
              type="button"
              onClick={saveWindow}
              disabled={savingWindow}
              className="rounded-sm bg-terracotta px-sm py-xs text-tiny font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
            >
              {savingWindow ? "…" : "Save"}
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className={`rounded-sm border px-sm py-xs text-tiny uppercase tracking-widest hover:opacity-80 ${
                showHidden
                  ? "border-stone bg-stone/10 text-stone"
                  : "border-sand text-stone/50"
              }`}
            >
              {showHidden ? "Hide hidden" : "Show hidden"}
            </button>
          )}
          {!isAdmin && (
            <span className="text-tiny text-stone/40">admin only to edit</span>
          )}
          {loading && <span className="text-tiny text-stone/40">loading…</span>}
        </div>
      </header>
      {expanded && (
      <>
      <p className="mt-xs text-tiny text-stone/60">
        Auto-adjusts after each completion when avg hit rate of last{" "}
        {window ?? "N"} runs drifts outside 90–100%.
      </p>

      <div className="mt-md overflow-x-auto">
        <table className="w-full min-w-[820px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Bath</Th>
              <Th align="right">Current rate</Th>
              <Th align="right">Avg hit (last N)</Th>
              <Th align="right">Runs</Th>
              <Th>Status</Th>
              <Th align="right" />
            </tr>
          </thead>
          <tbody>
            {withHistory.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-md py-md text-stone/50">
                  No completed runs yet. Rates appear as runs commit to ledger.
                </td>
              </tr>
            ) : (
              withHistory.map((r) => (
                <RateRowDisplay
                  key={r.item_id}
                  row={r}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  windowN={window ?? 10}
                  onRecompute={() => onRecompute(r.item_id, r.name)}
                  onHide={(hidden) => onHide(r.item_id, hidden, r.name)}
                  onReset={async () => {
                    if (
                      !confirm(
                        `Reset rate for ${r.name} to baseline? Clears tune history so the next completion starts the algo over.`,
                      )
                    )
                      return;
                    try {
                      const res = await resetRateToBaseline(r.item_id);
                      onSuccess(
                        `${res.finished_name}: reset to baseline ${res.new_rate ?? "—"}.`,
                      );
                      await refresh();
                    } catch (e) {
                      onError((e as Error).message);
                    }
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {withoutHistory.length > 0 && (
        <details className="mt-sm text-tiny text-stone/50">
          <summary className="cursor-pointer">
            {withoutHistory.length} SKU{withoutHistory.length === 1 ? "" : "s"} with no history
            yet
          </summary>
          <ul className="mt-xs space-y-xs">
            {withoutHistory.map((r) => (
              <li key={r.item_id} className="font-mono text-stone/60">
                {r.name} ({r.sku}){" "}
                {r.rate !== null ? `· baseline ${r.rate}` : "· no baseline rate"}
              </li>
            ))}
          </ul>
        </details>
      )}
      </>
      )}
    </section>
  );
}

function RateRowDisplay({
  row,
  canEdit,
  isAdmin,
  windowN,
  onRecompute,
  onReset,
  onHide,
}: {
  row: ProductionRateRow;
  canEdit: boolean;
  isAdmin: boolean;
  windowN: number;
  onRecompute: () => Promise<void> | void;
  onReset: () => Promise<void> | void;
  onHide: (hidden: boolean) => Promise<void> | void;
}) {
  const hit = row.avg_hit_rate;
  const pct = hit !== null ? Math.round(hit * 100) : null;
  const tone =
    hit === null
      ? "text-stone/40"
      : row.in_band
        ? "text-success"
        : hit < row.band_lo
          ? "text-critical"
          : "text-warning";
  return (
    <tr className={`border-t border-sand/30 ${row.hide_from_rates_table ? "opacity-50" : ""}`}>
      <Td>
        <span className="text-stone">{row.name}</span>
        <span className="ml-xs font-mono text-tiny text-stone/40">{row.sku}</span>
        {row.hide_from_rates_table && (
          <span className="ml-xs rounded-sm bg-stone/10 px-xs py-xs text-tiny uppercase tracking-widest text-stone/50">
            hidden
          </span>
        )}
      </Td>
      <Td align="right" className="font-mono text-stone">
        {row.rate !== null ? row.rate.toFixed(2) : "—"}
      </Td>
      <Td align="right" className={`font-mono ${tone}`}>
        {pct !== null ? `${pct}%` : "—"}
      </Td>
      <Td align="right" className="font-mono text-stone/60">
        {row.runs_considered}
      </Td>
      <Td>
        {row.in_band ? (
          <span className="rounded-sm bg-success/15 px-sm py-xs text-tiny uppercase tracking-widest text-success">
            In band
          </span>
        ) : hit !== null && hit < row.band_lo ? (
          <span className="rounded-sm bg-critical/15 px-sm py-xs text-tiny uppercase tracking-widest text-critical">
            Below 90%
          </span>
        ) : hit !== null && hit > row.band_hi ? (
          <span className="rounded-sm bg-warning/15 px-sm py-xs text-tiny uppercase tracking-widest text-warning">
            Above 100%
          </span>
        ) : (
          <span className="text-tiny text-stone/40">—</span>
        )}
        <p className="mt-xs text-tiny text-stone/50">
          {row.runs_considered < windowN
            ? `Needs ${windowN - row.runs_considered} more completed run${
                windowN - row.runs_considered === 1 ? "" : "s"
              } to retune (window = ${windowN})`
            : row.in_band
              ? "Avg inside band; no adjustment"
              : "Eligible to retune — click Recompute"}
        </p>
      </Td>
      <Td align="right">
        <div className="flex justify-end gap-sm">
          {canEdit && (
            <button
              type="button"
              onClick={onRecompute}
              className="text-tiny uppercase tracking-widest text-clay hover:underline"
            >
              Recompute
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={onReset}
              className="text-tiny uppercase tracking-widest text-stone/60 hover:text-critical hover:underline"
            >
              Reset
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => onHide(!row.hide_from_rates_table)}
              className="text-tiny uppercase tracking-widest text-stone/40 hover:text-stone hover:underline"
            >
              {row.hide_from_rates_table ? "Unhide" : "Hide"}
            </button>
          )}
        </div>
      </Td>
    </tr>
  );
}

function AggregateHitRate({ runs }: { runs: ProductionRun[] }) {
  const completed = runs.filter(
    (r) => r.status === "completed" && r.target_qty && r.target_qty > 0,
  );
  if (completed.length === 0) {
    return (
      <div className="border-b border-sand/30 px-md py-sm text-tiny text-stone/50">
        No completed runs yet -- hit rate appears once runs commit to ledger.
      </div>
    );
  }
  const totalDone = completed.reduce((acc, r) => acc + (r.completed_qty ?? 0), 0);
  const totalTarget = completed.reduce((acc, r) => acc + (r.target_qty ?? 0), 0);
  const hit = (totalDone / totalTarget) * 100;
  const tone = hit >= 95 ? "text-success" : hit >= 80 ? "text-warning" : "text-critical";
  return (
    <div className="border-b border-sand/30 px-md py-sm">
      <p className="text-tiny uppercase tracking-widest text-clay">
        Avg hit rate · last {completed.length} run{completed.length === 1 ? "" : "s"}
      </p>
      <p className={`mt-xs font-serif text-h2 ${tone}`}>{hit.toFixed(0)}%</p>
      <p className="text-tiny text-stone/50">
        {totalDone} / {totalTarget} units across completed runs
      </p>
    </div>
  );
}

function StaffHoursRow({
  runId,
  userId,
  userName,
  initialHours,
  initialShiftHours,
  locked,
  onChanged,
  onError,
  onSuccess,
}: {
  runId: string;
  userId: string;
  userName: string;
  initialHours: number;
  initialShiftHours: number | null;
  locked: boolean;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}) {
  const [prodHours, setProdHours] = useState(initialHours.toFixed(2));
  const [shiftHoursStr, setShiftHoursStr] = useState(
    initialShiftHours !== null ? initialShiftHours.toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProdHours(initialHours.toFixed(2));
    setShiftHoursStr(initialShiftHours !== null ? initialShiftHours.toFixed(2) : "");
  }, [initialHours, initialShiftHours]);

  const prodDirty = Number(prodHours) !== Number(initialHours.toFixed(2));
  const shiftDirty =
    (initialShiftHours === null ? "" : initialShiftHours.toFixed(2)) !== shiftHoursStr;
  const dirty = prodDirty || shiftDirty;

  const save = async () => {
    const n = Number(prodHours);
    if (!Number.isFinite(n) || n < 0) {
      onError("Production hours must be a non-negative number.");
      return;
    }
    let shiftN: number | null = null;
    if (shiftHoursStr.trim() !== "") {
      shiftN = Number(shiftHoursStr);
      if (!Number.isFinite(shiftN) || shiftN < 0) {
        onError("Shift hours must be a non-negative number or empty.");
        return;
      }
    }
    setBusy(true);
    try {
      await setProductionRunStaff(runId, {
        user_id: userId,
        hours: n,
        shift_hours: shiftN,
      });
      onSuccess(`Saved hours for ${userName}.`);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove ${userName} from this run?`)) return;
    try {
      await removeProductionRunStaff(runId, userId);
      onSuccess(`${userName} removed.`);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-sm py-sm text-small ${
        dirty ? "bg-terracotta/5" : ""
      }`}
    >
      <span className="text-stone">{userName}</span>
      <div className="flex flex-wrap items-center gap-sm">
        {locked ? (
          <span className="font-mono text-stone/70">
            {initialHours.toFixed(2)}h prod
            {initialShiftHours !== null && initialShiftHours !== initialHours
              ? ` · ${initialShiftHours.toFixed(2)}h shift`
              : ""}
          </span>
        ) : (
          <>
            <label className="flex items-center gap-xs text-tiny text-stone/60">
              <span className="uppercase tracking-widest text-clay">Prod</span>
              <input
                type="number"
                step="0.25"
                min="0"
                value={prodHours}
                onChange={(e) => setProdHours(e.target.value)}
                className="w-16 rounded-sm border border-sand bg-warmWhite px-xs py-xs text-right font-mono text-small focus:outline-none focus:border-terracotta"
              />
              <span>h</span>
            </label>
            <label className="flex items-center gap-xs text-tiny text-stone/60">
              <span className="uppercase tracking-widest text-clay">Shift</span>
              <input
                type="number"
                step="0.25"
                min="0"
                value={shiftHoursStr}
                onChange={(e) => setShiftHoursStr(e.target.value)}
                placeholder="same"
                className="w-16 rounded-sm border border-sand bg-warmWhite px-xs py-xs text-right font-mono text-small focus:outline-none focus:border-terracotta"
              />
              <span>h</span>
            </label>
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-sm bg-terracotta px-sm py-xs text-tiny font-medium text-warmWhite hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "…" : "Save"}
            </button>
            <button
              type="button"
              onClick={remove}
              className="text-tiny uppercase tracking-widest text-stone/60 hover:text-critical hover:underline"
            >
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number | string | null }) {
  return (
    <div className="rounded-sm border border-sand/30 bg-warmWhite px-sm py-sm">
      <p className="text-tiny uppercase tracking-widest text-clay">{label}</p>
      <p className="mt-xs font-mono text-stone">{value ?? "—"}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-small">
      <span className="text-tiny uppercase tracking-widest text-clay">{label}</span>
      <span className="mt-xs block">
        {/* Inputs/selects inside inherit a baseline style. The
            consumer adds extra classes (font-mono, etc.) on the
            element directly. */}
        {applyBaseStyle(children)}
      </span>
    </label>
  );
}

// Wraps a child input/select/textarea with shared classes by cloning it.
function applyBaseStyle(node: React.ReactNode): React.ReactNode {
  const base =
    "w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm text-small focus:outline-none focus:border-terracotta";
  if (
    typeof node === "object" &&
    node !== null &&
    "type" in (node as { type?: unknown }) &&
    "props" in (node as { props?: unknown })
  ) {
    const el = node as React.ReactElement<{ className?: string }>;
    const merged = `${base} ${el.props.className ?? ""}`.trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...el, props: { ...el.props, className: merged } } as any;
  }
  return node;
}

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

export default function ProductionSchedulePage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_inventory]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
