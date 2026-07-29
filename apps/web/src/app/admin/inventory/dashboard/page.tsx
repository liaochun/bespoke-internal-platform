// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthGate } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { CustomerDrawer } from "@/components/CustomerDrawer";
import { Header } from "@/components/Header";
import { OpsV2HeroStrip } from "@/components/OpsV2HeroStrip";
import {
  ApiError,
  AtRiskCustomer,
  AirtableStatus,
  AirtableSyncErrorRow,
  BuyListRow,
  DashboardOpenOrdersSummary,
  DashboardProductionRun,
  DashboardTransaction,
  DashboardTransfer,
  fetchAirtableStatus,
  fetchBuyList,
  fetchInventoryDashboard,
  fetchProductionPlanning,
  fetchRevenueDashboard,
  InventoryDashboard,
  listAirtableSyncErrors,
  listCorrectionsAdmin,
  listShifts,
  listWebhookEvents,
  ProductionPlanRow,
  PunchCorrectionWithUsers,
  RevenueDashboard,
  ShiftWithStaff,
  WebhookEvent,
} from "@/lib/api";
import { CAP } from "@/lib/capabilities";
import { fmtDateLong as fmtDate } from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useVisibleInterval } from "@/lib/useVisibleInterval";

// fmtDate aliased to the shared "long" format used elsewhere on the
// dashboard (e.g. transfer arrival dates).

// Single tone scale used by every dashboard widget. Callers append
// `font-medium` for table-row emphasis; headlines use the bare class.
type Urgency = "critical" | "warning" | "neutral";
const TONE_CLASS: Record<Urgency, string> = {
  critical: "text-critical",
  warning: "text-warning",
  neutral: "text-stone",
};

// Lower-is-worse: stock weeks, max producible, buy thresholds.
function urgencyBelow(value: number | null, critUnder: number, warnUnder: number): Urgency {
  if (value === null) return "neutral";
  if (value < critUnder) return "critical";
  if (value < warnUnder) return "warning";
  return "neutral";
}

// Higher-is-worse: order age, days overdue.
function urgencyAbove(value: number | null, critOver: number, warnOver: number): Urgency {
  if (value === null) return "neutral";
  if (value >= critOver) return "critical";
  if (value >= warnOver) return "warning";
  return "neutral";
}

const toneClass = (u: Urgency, bold = false) =>
  `${TONE_CLASS[u]}${bold ? " font-medium" : ""}`;

// Pill badge used for headline counters: e.g. "5 over 7d" tinted critical.
function UrgencyBadge({
  tone,
  children,
}: {
  tone: Urgency;
  children: React.ReactNode;
}) {
  const bg =
    tone === "critical"
      ? "bg-critical/15 text-critical"
      : tone === "warning"
        ? "bg-warning/15 text-warning"
        : "bg-stone/10 text-stone/70";
  return (
    <span className={`ml-sm rounded-full px-sm py-xs ${bg}`}>{children}</span>
  );
}

function fmtWeeks(weeks: number | null): { label: string; tone: string } {
  if (weeks === null) return { label: "—", tone: "text-stone/40" };
  return { label: weeks.toFixed(1), tone: toneClass(urgencyBelow(weeks, 1, 4), true) };
}

// Shared shell for every dashboard card. Title + headline subtitle + a
// "See all →" action link, then the body. Keeps spacing/tones consistent
// across widgets and lets new widgets ship without re-deriving the chrome.
function DashboardCard({
  id,
  title,
  subtitle,
  actionHref,
  actionLabel,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: React.ReactNode;
  actionHref?: string;
  actionLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 rounded-md border border-sand/30 bg-softCream">
      <header className="flex flex-wrap items-baseline justify-between gap-md px-lg pt-lg">
        <div>
          <h2 className="font-serif text-h2">{title}</h2>
          {subtitle && (
            <p className="mt-xs text-tiny uppercase tracking-widest text-clay">
              {subtitle}
            </p>
          )}
        </div>
        {actionHref && actionLabel && (
          <Link
            href={actionHref}
            className="text-tiny uppercase tracking-widest text-clay hover:underline"
          >
            {actionLabel}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function Inner() {
  useDocumentTitle("Inventory dashboard");
  const [data, setData] = useState<InventoryDashboard | null>(null);
  const [planning, setPlanning] = useState<ProductionPlanRow[] | null>(null);
  const [buyList, setBuyList] = useState<BuyListRow[] | null>(null);
  const [revenue, setRevenue] = useState<RevenueDashboard | null>(null);
  const [syncStatus, setSyncStatus] = useState<AirtableStatus | null>(null);
  const [syncErrors, setSyncErrors] = useState<AirtableSyncErrorRow[] | null>(null);
  const [todayShifts, setTodayShifts] = useState<ShiftWithStaff[] | null>(null);
  const [pendingCorrections, setPendingCorrections] = useState<PunchCorrectionWithUsers[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCustomerId, setOpenCustomerId] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);

  // Distinguish first-load (show skeleton, big "Loading…" button) from
  // background re-fetch (keep showing stale data, just dim the Refresh
  // button). Without this the auto-refresh tick blanks the button text
  // every 60s which is jarring.
  const refresh = async () => {
    if (data === null) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      // Independent fetches — partial failure should not blank the page.
      // Each card decides what to render from its own slice of state.
      // Today's shift window in ISO so the backend's daterange filter
      // returns only today's rows. Local-day boundaries — server stores UTC
      // but we want the operator's local "today."
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
      const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
      const [r, p, b, rev, st, se, sh, pc, wh] = await Promise.allSettled([
        fetchInventoryDashboard(),
        fetchProductionPlanning(),
        fetchBuyList({ only_short: true }),
        fetchRevenueDashboard(),
        fetchAirtableStatus(),
        listAirtableSyncErrors({ only_unresolved: true, limit: 5 }),
        listShifts({ start: dayStart, end: dayEnd }),
        listCorrectionsAdmin("pending"),
        listWebhookEvents({ limit: 6 }),
      ]);
      if (r.status === "fulfilled") {
        setData(r.value);
      } else {
        setError((r.reason as Error)?.message ?? "Failed to load dashboard");
      }
      setPlanning(p.status === "fulfilled" ? p.value : []);
      setBuyList(b.status === "fulfilled" ? b.value : []);
      setRevenue(rev.status === "fulfilled" ? rev.value : null);
      setSyncStatus(st.status === "fulfilled" ? st.value : null);
      setSyncErrors(se.status === "fulfilled" ? se.value : []);
      setTodayShifts(sh.status === "fulfilled" ? sh.value : []);
      setPendingCorrections(pc.status === "fulfilled" ? pc.value : []);
      setWebhooks(wh.status === "fulfilled" ? wh.value : []);
      setLastRefreshed(Date.now());
    } catch (err) {
      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Background re-fetch every 60s while visible. Under the 5-min Airtable
  // poll so the dashboard reflects new pulls within one tick.
  useVisibleInterval(() => {
    void refresh();
  }, 60_000);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-7xl px-md py-xl space-y-lg md:px-lg md:py-2xl">
        <header className="space-y-md">
          <div className="flex flex-wrap items-baseline justify-between gap-md">
            <div>
              <p className="font-mono text-tiny uppercase tracking-widest text-clay">Inventory</p>
              <h1 className="mt-sm font-serif text-display text-stone">Dashboard</h1>
              <p className="mt-md text-body text-stone/70">
                What needs attention right now — based on the last Airtable sync.
              </p>
            </div>
            <div className="flex flex-col items-end gap-xs">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-60"
              disabled={loading || refreshing}
            >
              {loading ? "Loading…" : refreshing ? "Refreshing…" : "Refresh"}
            </button>
            {lastRefreshed && (
              <RelativeTime stamp={lastRefreshed} />
            )}
            </div>
          </div>
          <DashboardJumpNav />
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        <OpsV2HeroStrip />

        {syncStatus && <StaleDataBanner status={syncStatus} />}

        {syncErrors && syncErrors.length > 0 && <SyncErrorBanner errors={syncErrors} />}

        {pendingCorrections && pendingCorrections.length > 0 && (
          <PunchCorrectionsBanner pending={pendingCorrections} />
        )}

        {!data && loading && <DashboardSkeleton />}

        {data && (
          <>
            {/* Stats summary */}
            <section id="stats" className="scroll-mt-24 grid gap-md md:grid-cols-5">
              <Stat label="Variants tracked" value={data.stats.linked_variants} sub={`of ${data.stats.total_variants}`} tone="neutral" />
              <Stat label="Critical (< 1 wk)" value={data.stats.critical_count} tone={data.stats.critical_count > 0 ? "critical" : "neutral"} />
              <Stat label="Warning (1–4 wks)" value={data.stats.warning_count} tone={data.stats.warning_count > 0 ? "warning" : "neutral"} />
              <Stat label="Healthy (4+ wks)" value={data.stats.healthy_count} tone="success" />
              <Stat label="No burn data" value={data.stats.untracked_count} tone="neutral" sub="can't compute weeks" />
            </section>

            {revenue && <RevenueSnapshotCard revenue={revenue} />}

            {revenue && revenue.daily_series_90d.length > 1 && (
              <RevenueTrendCard series={revenue.daily_series_90d} />
            )}

            {revenue && revenue.top_skus_90d.length > 0 && (
              <TopSKUsCard skus={revenue.top_skus_90d} />
            )}

            {revenue && revenue.top_customers_90d.length > 0 && (
              <TopCustomersCard
                customers={revenue.top_customers_90d}
                onOpenCustomer={(id) => setOpenCustomerId(id)}
              />
            )}

            {revenue && revenue.channel_breakdown_90d.length > 0 && (
              <ChannelBreakdownCard channels={revenue.channel_breakdown_90d} />
            )}

            {todayShifts && todayShifts.length > 0 && (
              <TodayShiftsCard shifts={todayShifts} />
            )}

            {/* Action required */}
            <section id="action" className="scroll-mt-24 rounded-md border border-sand/30 bg-softCream">
              <header className="flex flex-wrap items-baseline justify-between gap-md px-lg pt-lg">
                <div>
                  <h2 className="font-serif text-h2">Action required</h2>
                  <p className="mt-xs text-tiny uppercase tracking-widest text-clay">
                    Variants with under 4 weeks of stock · sorted by urgency
                  </p>
                </div>
              </header>
              {data.low_stock.length === 0 ? (
                <p className="px-lg py-md text-small text-stone/60">
                  Nothing under 4 weeks. ✓
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-small">
                    <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
                      <tr>
                        <Th>Item</Th>
                        <Th>Variant</Th>
                        <Th className="text-right">Toronto</Th>
                        <Th className="text-right">Wavecrest</Th>
                        <Th className="text-right">Burn (CA + US /d)</Th>
                        <Th className="text-right">Wks left</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.low_stock.map((v) => {
                        const wk = fmtWeeks(v.weeks_combined);
                        return (
                          <tr key={v.id} className="border-t border-sand/30 align-top">
                            <Td>
                              {v.master_item_name ? (
                                <span className="text-stone">{v.master_item_name}</span>
                              ) : (
                                <span className="text-stone/40">unlinked</span>
                              )}
                              {v.master_item_sku && (
                                <div className="text-tiny font-mono text-stone/60">{v.master_item_sku}</div>
                              )}
                            </Td>
                            <Td>
                              <div>{v.variant_name || "—"}</div>
                              {v.sku && (
                                <div className="text-tiny font-mono text-stone/60">{v.sku}</div>
                              )}
                            </Td>
                            <Td className="text-right font-mono">
                              {v.stock_available_toronto ?? "—"}
                            </Td>
                            <Td className="text-right font-mono">
                              {v.stock_available_wavecrest ?? "—"}
                            </Td>
                            <Td className="text-right font-mono text-tiny text-stone/70">
                              {v.daily_burn_combined?.toFixed(2) ?? "—"}
                            </Td>
                            <Td className={`text-right font-mono ${wk.tone}`}>{wk.label}</Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Activity grid */}
            <section id="activity" className="scroll-mt-24 grid gap-lg md:grid-cols-3">
              <ActivityCard title="Recent incoming" subtitle="Stock received" rows={data.recent_incoming} />
              <ActivityCard title="Recent outgoing" subtitle="Stock used / shipped" rows={data.recent_outgoing} />
              <ProductionRunCard runs={data.recent_production_runs} />
            </section>

            <TransfersInFlightCard transfers={data.transfers_in_flight} />

            {data.open_orders && <OpenOrdersCard summary={data.open_orders} />}

            {planning && planning.length > 0 && <ProductionCapacityCard planning={planning} />}

            {buyList && buyList.length > 0 && <BuyListCard rows={buyList} />}

            {webhooks && webhooks.length > 0 && <WebhookActivityCard events={webhooks} />}

            <AtRiskCustomersCard customers={data.at_risk_customers} onOpenCustomer={(id) => setOpenCustomerId(id)} />
          </>
        )}
      </main>
      <CustomerDrawer
        customerId={openCustomerId}
        onClose={() => setOpenCustomerId(null)}
      />
    </>
  );
}

function AtRiskCustomersCard({
  customers,
  onOpenCustomer,
}: {
  customers: AtRiskCustomer[];
  onOpenCustomer: (id: string) => void;
}) {
  if (customers.length === 0) return null;
  return (
    <DashboardCard
      id="at-risk"
      title="At-risk customers"
      subtitle="High Klaviyo CLV × high churn probability — retention targets"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Customer</Th>
              <Th className="text-right">Total CLV</Th>
              <Th className="text-right">Churn</Th>
              <Th className="text-right">Risk score</Th>
              <Th className="text-right">Orders</Th>
              <Th>Last order</Th>
              <Th>Expected next</Th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => {
              const churn = c.churn_probability ?? 0;
              const tone = churn >= 0.8 ? "text-critical" : "text-warning";
              return (
                <tr key={c.id} className="border-t border-sand/30 align-top">
                  <Td>
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(c.id)}
                      className="text-terracotta hover:underline text-left"
                    >
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") ||
                        c.email ||
                        "—"}
                    </button>
                    <div className="text-tiny text-stone/60">{c.email}</div>
                  </Td>
                  <Td className="text-right font-mono">
                    ${c.total_clv?.toFixed(0) ?? "—"}
                  </Td>
                  <Td className={`text-right font-mono ${tone}`}>
                    {(churn * 100).toFixed(0)}%
                  </Td>
                  <Td className="text-right font-mono font-medium text-stone">
                    ${c.risk_score.toFixed(0)}
                  </Td>
                  <Td className="text-right font-mono">{c.historic_order_count ?? "—"}</Td>
                  <Td className="font-mono text-tiny">
                    {fmtDate(c.last_order_date)}
                  </Td>
                  <Td className="font-mono text-tiny text-stone/60">
                    {fmtDate(c.expected_next_order)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function ActivityCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: DashboardTransaction[];
}) {
  return (
    <div className="rounded-md border border-sand/30 bg-softCream p-lg">
      <h3 className="font-serif text-h3">{title}</h3>
      <p className="mt-xs text-tiny uppercase tracking-widest text-clay">{subtitle}</p>
      {rows.length === 0 ? (
        <p className="mt-md text-small text-stone/60">No recent activity.</p>
      ) : (
        <ul className="mt-md space-y-sm text-small">
          {rows.map((t) => (
            <li key={t.id} className="border-t border-sand/30 pt-sm first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-sm">
                <span className="font-medium text-stone">
                  {t.master_item_name || <span className="text-stone/50">unlinked</span>}
                </span>
                <span className="font-mono text-tiny text-stone/60">{fmtDate(t.occurred_at)}</span>
              </div>
              <div className="text-tiny text-stone/70">
                <span className="font-mono">{t.quantity ?? "—"}</span>
                {t.warehouse && ` · ${t.warehouse}`}
                {t.status && ` · ${t.status}`}
                {t.scanned_by && ` · ${t.scanned_by}`}
              </div>
              {t.notes && (
                <div className="mt-xs text-tiny text-stone/60 italic line-clamp-2">{t.notes}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductionRunCard({ runs }: { runs: DashboardProductionRun[] }) {
  return (
    <div className="rounded-md border border-sand/30 bg-softCream p-lg">
      <h3 className="font-serif text-h3">Recent production runs</h3>
      <p className="mt-xs text-tiny uppercase tracking-widest text-clay">
        Manufacturing batches
      </p>
      {runs.length === 0 ? (
        <p className="mt-md text-small text-stone/60">No recent runs.</p>
      ) : (
        <ul className="mt-md space-y-sm text-small">
          {runs.map((r) => (
            <li key={r.id} className="border-t border-sand/30 pt-sm first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-sm">
                <span className="font-medium text-stone line-clamp-1">
                  {r.master_item_name || r.name || <span className="text-stone/50">—</span>}
                </span>
                <span className="font-mono text-tiny text-stone/60">{fmtDate(r.run_date)}</span>
              </div>
              <div className="text-tiny text-stone/70">
                {r.status && <span>{r.status}</span>}
                {r.production_target_calculated !== null && (
                  <span className="ml-sm">
                    target <span className="font-mono">{r.production_target_calculated}</span>
                  </span>
                )}
                {r.finished_product !== null && (
                  <span className="ml-sm">
                    finished <span className="font-mono">{r.finished_product}</span>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TransfersInFlightCard({ transfers }: { transfers: DashboardTransfer[] }) {
  // Hide entirely when nothing is in flight — keeps the dashboard quiet.
  // Operationally common state, especially right after a fulfillment cycle.
  if (transfers.length === 0) return null;

  const overdueCount = transfers.filter((t) => t.overdue).length;

  return (
    <DashboardCard
      id="transfers"
      title="Transfers in flight"
      subtitle={
        <>
          {transfers.length} {transfers.length === 1 ? "transfer" : "transfers"} sent · not yet received
          {overdueCount > 0 && (
            <UrgencyBadge tone="warning">{overdueCount} overdue</UrgencyBadge>
          )}
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Item</Th>
              <Th className="text-right">Qty</Th>
              <Th>From → To</Th>
              <Th>Status</Th>
              <Th>Sent</Th>
              <Th>Est. arrival</Th>
              <Th className="text-right">Days in transit</Th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => {
              const arrivalTone = toneClass(t.overdue ? "warning" : "neutral", true);
              return (
                <tr
                  key={t.id}
                  className={`border-t border-sand/30 align-top ${t.overdue ? "bg-warning/5" : ""}`}
                >
                  <Td>
                    {t.master_item_name ? (
                      <span className="text-stone">{t.master_item_name}</span>
                    ) : (
                      <span className="text-stone/40">unlinked</span>
                    )}
                    {t.name && (
                      <div className="text-tiny text-stone/60">{t.name}</div>
                    )}
                  </Td>
                  <Td className="text-right font-mono">
                    {t.quantity == null ? "—" : t.quantity.toLocaleString()}
                  </Td>
                  <Td>
                    {(t.from_warehouse ?? "—") + " → " + (t.to_warehouse ?? "—")}
                  </Td>
                  <Td>{t.status ?? "—"}</Td>
                  <Td>{fmtDate(t.transfer_date)}</Td>
                  <Td className={arrivalTone}>{fmtDate(t.estimated_stock_in_date)}</Td>
                  <Td className="text-right font-mono">
                    {t.days_in_transit == null ? "—" : t.days_in_transit}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function OpenOrdersCard({ summary }: { summary: DashboardOpenOrdersSummary }) {
  // Hide entirely when nothing's open — common state right after fulfillment.
  if (summary.total_open === 0) return null;

  // Headline tone: 14+ day = critical, any 7+ day order = warning.
  const headlineTone = toneClass(
    (summary.oldest_age_days ?? 0) >= 14
      ? "critical"
      : summary.aging_over_7d > 0
        ? "warning"
        : "neutral",
  );

  return (
    <DashboardCard
      id="open-orders"
      title="Open orders"
      subtitle={
        <>
          <span className={headlineTone}>
            {summary.total_open} unfulfilled
            {summary.oldest_age_days != null &&
              ` · oldest ${summary.oldest_age_days}d`}
          </span>
          {summary.aging_3_to_7d > 0 && (
            <UrgencyBadge tone="warning">
              {summary.aging_3_to_7d} aging 3–7d
            </UrgencyBadge>
          )}
          {summary.aging_over_7d > 0 && (
            <UrgencyBadge tone="critical">
              {summary.aging_over_7d} over 7d
            </UrgencyBadge>
          )}
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Order #</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th className="text-right">Lines</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">Age</Th>
            </tr>
          </thead>
          <tbody>
            {summary.top.map((o) => {
              const ageTone = toneClass(urgencyAbove(o.age_days ?? null, 8, 3), true);
              return (
                <tr key={o.order_id ?? `${o.order_number}`} className="border-t border-sand/30 align-top">
                  <Td>
                    <span className="font-mono">
                      {o.order_number != null ? `#${o.order_number}` : "—"}
                    </span>
                  </Td>
                  <Td className="text-stone">
                    {o.customer_email ?? "—"}
                  </Td>
                  <Td className="text-stone/70">
                    {o.fulfillment_status ?? "—"}
                  </Td>
                  <Td className="text-right font-mono">{o.line_item_count}</Td>
                  <Td className="text-right font-mono">
                    {o.order_total_usd == null
                      ? "—"
                      : `US$${o.order_total_usd.toFixed(0)}`}
                  </Td>
                  <Td className={`text-right font-mono ${ageTone}`}>
                    {o.age_days == null ? "—" : `${o.age_days}d`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

// Tables that drive the inventory dashboard. Staleness on retail_orders_jack
// or order_summary doesn't change what's shown here, so we ignore them.
const INVENTORY_RELEVANT_SYNC_KEYS = [
  "master_items",
  "variants",
  "transactions",
  "transfers",
  "production_runs",
  "suppliers_ingredients",
  "bom_lines",
  "orders",
  "wholesale_pricing",
];

function StaleDataBanner({ status }: { status: AirtableStatus }) {
  if (!status.configured) return null;
  const ages: number[] = [];
  for (const key of INVENTORY_RELEVANT_SYNC_KEYS) {
    const iso = status.last_sync_by_table?.[key];
    if (!iso) continue;
    ages.push(Date.now() - new Date(iso).getTime());
  }
  if (ages.length === 0) return null;

  const oldestMs = Math.max(...ages);
  const oldestH = oldestMs / 3_600_000;
  if (oldestH < 2) return null; // fresh — no banner needed

  const label =
    oldestH >= 24
      ? `Mirror is ${Math.floor(oldestH / 24)}d stale`
      : `Mirror is ${Math.floor(oldestH)}h stale`;

  return (
    <Banner tone={oldestH >= 24 ? "critical" : "warning"}>
      <strong>{label}.</strong>{" "}
      <span className="text-stone/80">
        Inventory numbers below may be behind reality.
      </span>
      {!status.auto_sync_enabled && (
        <span className="ml-sm font-mono text-tiny uppercase tracking-widest">
          auto-sync OFF
        </span>
      )}
    </Banner>
  );
}

function DashboardJumpNav() {
  // Anchor jumps for the long-scrolling dashboard. Order matches DOM order
  // so the visual narrative makes sense — "what's happening now" first,
  // then revenue, then inventory action items, then activity, then deep cuts.
  const jumps: Array<{ id: string; label: string }> = [
    { id: "stats", label: "Stats" },
    { id: "revenue", label: "Revenue" },
    { id: "revenue-trend", label: "Trend" },
    { id: "top-skus", label: "Top SKUs" },
    { id: "top-customers", label: "Top customers" },
    { id: "channels", label: "Channels" },
    { id: "today", label: "Today" },
    { id: "action", label: "Action required" },
    { id: "activity", label: "Activity" },
    { id: "transfers", label: "Transfers" },
    { id: "open-orders", label: "Open orders" },
    { id: "production", label: "Production" },
    { id: "buy-list", label: "Buy list" },
    { id: "webhooks", label: "Webhooks" },
    { id: "at-risk", label: "At-risk" },
  ];
  return (
    <nav
      aria-label="Dashboard sections"
      className="flex flex-wrap gap-xs overflow-x-auto"
    >
      {jumps.map((j) => (
        <a
          key={j.id}
          href={`#${j.id}`}
          className="rounded-full border border-sand/40 bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone/70 hover:border-terracotta hover:text-terracotta"
        >
          {j.label}
        </a>
      ))}
    </nav>
  );
}

function RelativeTime({ stamp }: { stamp: number }) {
  const [, force] = useState(0);
  // Tick once per minute to keep the relative label honest.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const ageMs = Date.now() - stamp;
  const m = Math.floor(ageMs / 60_000);
  const label =
    m < 1 ? "just now" : m === 1 ? "1 min ago" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ago`;
  return (
    <span className="font-mono text-tiny text-stone/50">
      Updated {label}
    </span>
  );
}

function DashboardSkeleton() {
  // Pulse-bar placeholders matching the rough shape of the real dashboard:
  // 5-stat row + a couple of section blocks. Keeps layout from collapsing
  // before data arrives.
  return (
    <div className="space-y-lg" aria-hidden="true">
      <div className="grid gap-md md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-24 rounded-md border border-sand/30 bg-softCream/60 animate-pulse"
          />
        ))}
      </div>
      <div className="h-32 rounded-md border border-sand/30 bg-softCream/60 animate-pulse" />
      <div className="h-48 rounded-md border border-sand/30 bg-softCream/60 animate-pulse" />
      <div className="grid gap-lg md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-40 rounded-md border border-sand/30 bg-softCream/60 animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

// Inline banner above the dashboard sections. Single shape; the three
// callers (stale data, sync errors, pending corrections) pick a tone +
// supply their own content.
type BannerTone = "warning" | "critical";

function Banner({
  tone,
  children,
  actionHref,
  actionLabel,
}: {
  tone: BannerTone;
  children: React.ReactNode;
  actionHref?: string;
  actionLabel?: string;
}) {
  const cls =
    tone === "critical"
      ? "border-critical/40 bg-critical/10 text-critical"
      : "border-warning/40 bg-warning/10 text-warning";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-md rounded-md border p-md text-small ${cls}`}
    >
      <span>{children}</span>
      {actionHref && actionLabel && (
        <Link
          href={actionHref}
          className="font-mono text-tiny uppercase tracking-widest underline"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}

function WebhookActivityCard({ events }: { events: WebhookEvent[] }) {
  // Confirms the Shopify + Airtable receivers are alive. If empty, no
  // events have landed in the last batch — could mean either the
  // integration's idle or it's broken. Either way operator wants to know.
  const sorted = [...events].sort(
    (a, b) =>
      new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
  );
  const recent = sorted.slice(0, 6);
  const latest = sorted[0];
  const minsSince = latest
    ? Math.floor((Date.now() - new Date(latest.received_at).getTime()) / 60_000)
    : 0;
  const minsLabel =
    minsSince < 1 ? "just now" : minsSince < 60 ? `${minsSince}m ago` : `${Math.floor(minsSince / 60)}h ago`;

  return (
    <DashboardCard
      id="webhooks"
      title="Webhook activity"
      subtitle={
        <>
          <span className="text-stone">{recent.length} recent</span>
          {latest && (
            <span className="ml-sm text-stone/60">
              · last event {minsLabel}
            </span>
          )}
        </>
      }
    >
      <ul className="space-y-xs px-lg pb-lg pt-md text-small">
        {recent.map((e) => {
          const tone =
            e.status === "failed"
              ? "text-critical"
              : e.status === "ignored"
                ? "text-stone/50"
                : "text-stone";
          return (
            <li
              key={e.id}
              className="flex items-baseline justify-between gap-md border-t border-sand/20 pt-xs first:border-t-0 first:pt-0"
            >
              <span className={`truncate ${tone}`}>
                <span className="font-mono text-tiny uppercase tracking-widest text-clay">
                  {e.source}
                </span>{" "}
                <span className="font-mono">{e.topic}</span>
              </span>
              <span className="font-mono text-tiny text-stone/50">
                {new Date(e.received_at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          );
        })}
      </ul>
    </DashboardCard>
  );
}

function PunchCorrectionsBanner({ pending }: { pending: PunchCorrectionWithUsers[] }) {
  const count = pending.length;
  const oldest = pending.reduce<string | null>((acc, p) => {
    if (!acc) return p.created_at;
    return new Date(p.created_at).getTime() < new Date(acc).getTime() ? p.created_at : acc;
  }, null);
  const ageDays =
    oldest != null
      ? Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000)
      : 0;
  return (
    <Banner
      tone={ageDays >= 3 ? "critical" : "warning"}
    >
      <strong>
        {count} punch correction{count === 1 ? "" : "s"} awaiting review
      </strong>
      {ageDays > 0 && (
        <span className="ml-sm text-stone/80">· oldest {ageDays}d</span>
      )}
    </Banner>
  );
}

function SyncErrorBanner({ errors }: { errors: AirtableSyncErrorRow[] }) {
  const recent = errors[0];
  return (
    <Banner
      tone="critical"
    >
      <strong>
        {errors.length} unresolved sync error{errors.length === 1 ? "" : "s"}.
      </strong>{" "}
      {recent && (
        <span className="text-stone/80">
          Latest: {recent.operation ?? "unknown op"} ·{" "}
          {(recent.error_cause ?? "no cause").slice(0, 80)}
          {(recent.error_cause ?? "").length > 80 ? "…" : ""}
        </span>
      )}
    </Banner>
  );
}

function RevenueTrendCard({
  series,
}: {
  series: RevenueDashboard["daily_series_90d"];
}) {
  // Hand-rolled SVG sparkline so we don't pull in a chart lib for one viz.
  const W = 800;
  const H = 120;
  const PAD = 8;
  const sorted = [...series].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const max = Math.max(...sorted.map((p) => p.revenue), 1);
  const stepX = (W - PAD * 2) / Math.max(1, sorted.length - 1);
  const path = sorted
    .map((p, i) => {
      const x = PAD + i * stepX;
      const y = H - PAD - (p.revenue / max) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const last7 = sorted.slice(-7).reduce((acc, p) => acc + p.revenue, 0);
  const prev7 = sorted.slice(-14, -7).reduce((acc, p) => acc + p.revenue, 0);
  const delta = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;
  const trendTone =
    delta >= 5 ? "text-success" : delta <= -5 ? "text-critical" : "text-stone/70";

  return (
    <DashboardCard
      id="revenue-trend"
      title="Revenue trend · last 90 days"
      subtitle={
        <>
          <span>Last 7d: ${Math.round(last7).toLocaleString()}</span>
          <span className={`ml-sm font-mono ${trendTone}`}>
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(0)}% vs prior 7d
          </span>
        </>
      }
    >
      <div className="px-lg pb-lg pt-md">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-32 w-full"
          role="img"
          aria-label={`Daily revenue trend for the last ${sorted.length} days`}
        >
          <path
            d={`${path} L ${(PAD + (sorted.length - 1) * stepX).toFixed(1)} ${H - PAD} L ${PAD} ${H - PAD} Z`}
            fill="rgb(204 102 51 / 0.10)"
          />
          <path d={path} fill="none" stroke="rgb(204 102 51)" strokeWidth="1.5" />
        </svg>
        <div className="mt-xs flex items-baseline justify-between text-tiny text-stone/50">
          <span>{sorted[0]?.date}</span>
          <span>{sorted[sorted.length - 1]?.date}</span>
        </div>
      </div>
    </DashboardCard>
  );
}

function TopCustomersCard({
  customers,
  onOpenCustomer,
}: {
  customers: RevenueDashboard["top_customers_90d"];
  onOpenCustomer: (id: string) => void;
}) {
  const top = customers.slice(0, 8);
  return (
    <DashboardCard
      id="top-customers"
      title="Top customers · last 90 days"
      subtitle={`${top.length} customer${top.length === 1 ? "" : "s"}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Customer</Th>
              <Th className="text-right">90d revenue</Th>
              <Th className="text-right">Orders</Th>
              <Th className="text-right">Total CLV</Th>
              <Th className="text-right">Churn</Th>
            </tr>
          </thead>
          <tbody>
            {top.map((c) => {
              const churn = c.churn_probability ?? 0;
              const churnTone =
                churn >= 0.8
                  ? "text-critical font-medium"
                  : churn >= 0.5
                    ? "text-warning"
                    : "text-stone/60";
              return (
                <tr key={c.customer_id ?? c.email ?? Math.random()} className="border-t border-sand/30 align-top">
                  <Td>
                    {c.customer_id ? (
                      <button
                        type="button"
                        onClick={() => onOpenCustomer(c.customer_id!)}
                        className="text-terracotta hover:underline text-left"
                      >
                        {[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "—"}
                      </button>
                    ) : (
                      <span className="text-stone">
                        {[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "—"}
                      </span>
                    )}
                    {c.email && (
                      <div className="text-tiny text-stone/60">{c.email}</div>
                    )}
                  </Td>
                  <Td className="text-right font-mono">
                    ${Math.round(c.revenue_in_window).toLocaleString()}
                  </Td>
                  <Td className="text-right font-mono text-stone/70">
                    {c.orders_in_window}
                  </Td>
                  <Td className="text-right font-mono text-stone/80">
                    {c.total_clv == null ? "—" : `$${Math.round(c.total_clv).toLocaleString()}`}
                  </Td>
                  <Td className={`text-right font-mono ${churnTone}`}>
                    {c.churn_probability == null ? "—" : `${(churn * 100).toFixed(0)}%`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function ChannelBreakdownCard({
  channels,
}: {
  channels: RevenueDashboard["channel_breakdown_90d"];
}) {
  const total = channels.reduce((acc, c) => acc + c.revenue, 0);
  const sorted = [...channels].sort((a, b) => b.revenue - a.revenue);
  return (
    <DashboardCard
      id="channels"
      title="Channel mix · last 90 days"
      subtitle={`${channels.length} channel${channels.length === 1 ? "" : "s"} · $${Math.round(total).toLocaleString()} total`}
    >
      <ul className="space-y-sm p-lg">
        {sorted.map((c) => {
          const pct = total > 0 ? (c.revenue / total) * 100 : 0;
          return (
            <li key={c.channel ?? "unknown"}>
              <div className="flex items-baseline justify-between text-small">
                <span className="text-stone">
                  {c.channel ?? "—"}
                  <span className="ml-sm text-tiny text-stone/50">
                    {c.unique_orders} order{c.unique_orders === 1 ? "" : "s"} · {c.line_items} line
                    {c.line_items === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="font-mono text-stone">
                  ${Math.round(c.revenue).toLocaleString()}{" "}
                  <span className="text-tiny text-stone/60">({pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div className="mt-xs h-1 w-full overflow-hidden rounded-full bg-sand/40">
                <div
                  className="h-full bg-terracotta"
                  style={{ width: `${pct.toFixed(2)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </DashboardCard>
  );
}

function TopSKUsCard({ skus }: { skus: RevenueDashboard["top_skus_90d"] }) {
  const top = skus.slice(0, 8);
  const totalRev = top.reduce((acc, s) => acc + s.revenue, 0);
  return (
    <DashboardCard
      id="top-skus"
      title="Top SKUs · last 90 days"
      subtitle={
        <>
          <span>
            {top.length} SKU{top.length === 1 ? "" : "s"} ·{" "}
            ${Math.round(totalRev).toLocaleString()} combined
          </span>
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>SKU</Th>
              <Th>Item</Th>
              <Th className="text-right">Units</Th>
              <Th className="text-right">Lines</Th>
              <Th className="text-right">Revenue</Th>
            </tr>
          </thead>
          <tbody>
            {top.map((s) => (
              <tr key={s.sku ?? s.item_name ?? Math.random()} className="border-t border-sand/30 align-top">
                <Td className="font-mono text-stone/80">{s.sku ?? "—"}</Td>
                <Td className="text-stone">{s.item_name ?? "—"}</Td>
                <Td className="text-right font-mono">{s.quantity.toLocaleString()}</Td>
                <Td className="text-right font-mono text-stone/70">{s.line_items}</Td>
                <Td className="text-right font-mono">
                  ${Math.round(s.revenue).toLocaleString()}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function TodayShiftsCard({ shifts }: { shifts: ShiftWithStaff[] }) {
  const now = Date.now();
  const active = shifts.filter((s) => s.status !== "cancelled");
  const onShiftNow = active.filter((s) => {
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    return start <= now && end > now;
  });
  const upcoming = active
    .filter((s) => new Date(s.starts_at).getTime() > now)
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    );
  // Sort the table chronologically.
  const sorted = [...active].sort(
    (a, b) =>
      new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );

  const fmtClock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <DashboardCard
      id="today"
      title="Today"
      subtitle={
        <>
          <span className="text-success">{onShiftNow.length} on shift now</span>
          {upcoming.length > 0 && (
            <span className="ml-sm text-stone/60">
              · {upcoming.length} upcoming · next at {fmtClock(upcoming[0].starts_at)}
            </span>
          )}
        </>
      }
      actionHref="/admin/schedule"
      actionLabel="Open schedule →"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Staff</Th>
              <Th>Window</Th>
              <Th>Location</Th>
              <Th>Role</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const start = new Date(s.starts_at).getTime();
              const end = new Date(s.ends_at).getTime();
              const isNow = start <= now && end > now;
              return (
                <tr
                  key={s.id}
                  className={`border-t border-sand/30 align-top ${isNow ? "bg-success/5" : ""}`}
                >
                  <Td className="font-medium text-stone">{s.user.full_name}</Td>
                  <Td className="font-mono text-stone/80">
                    {fmtClock(s.starts_at)} → {fmtClock(s.ends_at)}
                  </Td>
                  <Td className="text-stone/70 capitalize">{s.location}</Td>
                  <Td className="text-stone/70">{s.role_label ?? "—"}</Td>
                  <Td>
                    <span className="font-mono text-tiny uppercase tracking-widest text-stone/60">
                      {isNow ? "on shift" : s.status}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function RevenueSnapshotCard({ revenue }: { revenue: RevenueDashboard }) {
  // Pull 7d / 30d / 90d windows. Backend returns a list keyed by `days`.
  const win = (n: number) => revenue.windows.find((w) => w.days === n) ?? null;
  const w7 = win(7);
  const w30 = win(30);
  const w90 = win(90);
  const cells: Array<{ label: string; w: typeof w7 }> = [
    { label: "Last 7 days", w: w7 },
    { label: "Last 30 days", w: w30 },
    { label: "Last 90 days", w: w90 },
  ];

  // Today's revenue from the daily series — last entry is today (or
  // yesterday if today's data hasn't synced yet).
  const series = [...revenue.daily_series_90d].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const today = series[series.length - 1] ?? null;
  const yesterday = series[series.length - 2] ?? null;
  const todayDelta =
    today && yesterday && yesterday.revenue > 0
      ? ((today.revenue - yesterday.revenue) / yesterday.revenue) * 100
      : null;
  const deltaTone =
    todayDelta == null
      ? "text-stone/60"
      : todayDelta >= 5
        ? "text-success"
        : todayDelta <= -5
          ? "text-critical"
          : "text-stone/70";

  return (
    <section id="revenue" className="scroll-mt-24 rounded-md border border-sand/30 bg-softCream">
      <header className="flex flex-wrap items-baseline justify-between gap-md px-lg pt-lg">
        <div>
          <h2 className="font-serif text-h2">Revenue snapshot</h2>
          <p className="mt-xs text-tiny uppercase tracking-widest text-clay">
            Shopify orders · gross revenue, line items, AOV
          </p>
        </div>
      </header>
      <div className="grid gap-md p-lg md:grid-cols-4">
        {today && (
          <div className="rounded-md border border-terracotta/40 bg-terracotta/5 p-md">
            <p className="text-tiny uppercase tracking-widest text-clay">Today</p>
            <p className="mt-sm font-serif text-h2 text-stone">
              ${Math.round(today.revenue).toLocaleString()}
            </p>
            <dl className="mt-md grid grid-cols-2 gap-xs text-tiny text-stone/70">
              <dt>Lines</dt>
              <dd className="text-right font-mono">{today.line_items}</dd>
              <dt>vs yest.</dt>
              <dd className={`text-right font-mono ${deltaTone}`}>
                {todayDelta == null
                  ? "—"
                  : `${todayDelta >= 0 ? "+" : ""}${todayDelta.toFixed(0)}%`}
              </dd>
            </dl>
          </div>
        )}
        {cells.map(({ label, w }) => (
          <div
            key={label}
            className="rounded-md border border-sand/30 bg-warmWhite p-md"
          >
            <p className="text-tiny uppercase tracking-widest text-clay">{label}</p>
            <p className="mt-sm font-serif text-h2 text-stone">
              {w ? `$${Math.round(w.revenue).toLocaleString()}` : "—"}
            </p>
            {w && (
              <dl className="mt-md grid grid-cols-2 gap-xs text-tiny text-stone/70">
                <dt>Orders</dt>
                <dd className="text-right font-mono">{w.unique_orders}</dd>
                <dt>Customers</dt>
                <dd className="text-right font-mono">{w.unique_customers}</dd>
                <dt>AOV</dt>
                <dd className="text-right font-mono">
                  {w.aov == null ? "—" : `$${w.aov.toFixed(0)}`}
                </dd>
              </dl>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function BuyListCard({ rows }: { rows: BuyListRow[] }) {
  // Top 8 by urgency: lowest weeks_of_stock first, NULL last.
  const sorted = [...rows]
    .sort((a, b) => {
      const aw = a.weeks_of_stock_remaining;
      const bw = b.weeks_of_stock_remaining;
      if (aw === null && bw === null) return 0;
      if (aw === null) return 1;
      if (bw === null) return -1;
      return aw - bw;
    })
    .slice(0, 8);

  if (sorted.length === 0) return null;

  const totalCost = sorted.reduce(
    (acc, r) => acc + (r.suggested_total_cost ?? 0),
    0,
  );
  const headlineTone = toneClass(
    urgencyBelow(sorted[0].weeks_of_stock_remaining, 1, 2),
  );

  return (
    <DashboardCard
      id="buy-list"
      title="Buy list"
      subtitle={
        <>
          <span className={headlineTone}>{sorted.length} ingredients short</span>
          {totalCost > 0 && (
            <span className="ml-sm text-stone/60">
              ≈ ${totalCost.toFixed(0)} suggested spend
            </span>
          )}
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Ingredient</Th>
              <Th>Supplier</Th>
              <Th className="text-right">Wks left</Th>
              <Th className="text-right">Buy</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const wk = fmtWeeks(r.weeks_of_stock_remaining);
              return (
                <tr
                  key={r.ingredient_master_item_id}
                  className="border-t border-sand/30 align-top"
                >
                  <Td className="font-medium text-stone">{r.ingredient_name}</Td>
                  <Td className="text-stone/70">{r.supplier_name ?? "—"}</Td>
                  <Td className={`text-right font-mono ${wk.tone}`}>{wk.label}</Td>
                  <Td className="text-right font-mono">
                    {r.suggested_units_to_buy == null
                      ? "—"
                      : `${r.suggested_units_to_buy} ${r.purchase_unit ?? ""}`.trim()}
                  </Td>
                  <Td className="text-right font-mono">
                    {r.suggested_total_cost == null
                      ? "—"
                      : `$${r.suggested_total_cost.toFixed(0)}`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function ProductionCapacityCard({ planning }: { planning: ProductionPlanRow[] }) {
  // Bottleneck = lowest max_producible. NULL means no recipe / no limit data → skip.
  const ranked = planning
    .filter((p) => p.max_producible !== null && p.bom_line_count > 0)
    .sort((a, b) => (a.max_producible ?? 0) - (b.max_producible ?? 0))
    .slice(0, 5);

  if (ranked.length === 0) return null;

  const worstTone = toneClass(urgencyBelow(ranked[0].max_producible, 50, 250));

  return (
    <DashboardCard
      id="production"
      title="Production capacity"
      subtitle={
        <>
          <span className={worstTone}>
            Tightest bottleneck: {ranked[0].max_producible} bag
            {ranked[0].max_producible === 1 ? "" : "s"}
          </span>
          <span className="ml-sm text-stone/60">— limited by ingredient stock</span>
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-small">
          <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
            <tr>
              <Th>Product</Th>
              <Th>Limiting ingredient</Th>
              <Th className="text-right">Max bags</Th>
              <Th className="text-right">g / bag</Th>
              <Th className="text-right">g on hand</Th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => {
              const m = row.max_producible ?? 0;
              const tone = toneClass(urgencyBelow(m, 50, 250), true);
              return (
                <tr
                  key={row.product_master_item_id}
                  className="border-t border-sand/30 align-top"
                >
                  <Td className="font-medium text-stone">{row.product_name}</Td>
                  <Td className="text-stone/80">
                    {row.limiting_ingredient_name ?? "—"}
                  </Td>
                  <Td className={`text-right font-mono ${tone}`}>{m}</Td>
                  <Td className="text-right font-mono text-stone/70">
                    {row.limiting_grams_per_bag == null
                      ? "—"
                      : row.limiting_grams_per_bag.toFixed(1)}
                  </Td>
                  <Td className="text-right font-mono text-stone/70">
                    {row.limiting_ingredient_available == null
                      ? "—"
                      : row.limiting_ingredient_available.toFixed(0)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-md py-sm text-left font-medium ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-md py-sm align-top ${className}`}>{children}</td>;
}

function Stat({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: number;
  sub?: string;
  tone: "success" | "warning" | "critical" | "neutral";
  href?: string;
}) {
  const styles = {
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    critical: "border-critical/40 bg-critical/10 text-critical",
    neutral: "border-sand/40 bg-warmWhite text-stone",
  };
  const body = (
    <>
      <p className="text-tiny uppercase tracking-widest opacity-70">{label}</p>
      <p className="mt-xs font-mono text-h2">{value.toLocaleString()}</p>
      {sub && <p className="text-tiny opacity-60">{sub}</p>}
    </>
  );
  const cls = `block rounded-md border ${styles[tone]} p-md`;
  if (href) {
    return (
      <Link href={href} className={`${cls} transition-colors hover:opacity-90`}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

export default function InventoryDashboardPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_inventory]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
