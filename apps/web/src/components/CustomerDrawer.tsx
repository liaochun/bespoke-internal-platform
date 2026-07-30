// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useState } from "react";

import { CustomerDetailResponse, CustomerOrderLine, fetchCustomerDetail } from "@/lib/api";
import { LocalNoteEditor } from "@/components/LocalNoteEditor";
import { fmtDate } from "@/lib/format";

// fmtMoney kept page-local — this drawer's variant takes a currency param
// to flip between $ and US$, which the shared lib doesn't handle.
function fmtMoney(v: number | null, currency: string | null = "CAD"): string {
  if (v === null || v === undefined) return "—";
  const sym = currency === "USD" ? "US$" : "$";
  return `${sym}${v.toFixed(2)}`;
}

interface CustomerDrawerProps {
  customerId: string | null;
  onClose: () => void;
  /** Optional: when given, clicking an order row opens that order. */
  onOpenOrder?: (orderRowId: string) => void;
}

export function CustomerDrawer({ customerId, onClose, onOpenOrder }: CustomerDrawerProps) {
  const [data, setData] = useState<CustomerDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    void (async () => {
      try {
        setData(await fetchCustomerDetail(customerId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [customerId]);

  // ESC closes
  useEffect(() => {
    if (!customerId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [customerId, onClose]);

  if (!customerId) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="Customer detail"
    >
      {/* Backdrop */}
      <button
        type="button"
        className="flex-1 bg-stone/40"
        onClick={onClose}
        aria-label="Close"
      />
      {/* Panel */}
      <aside className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-warmWhite shadow-xl">
        <header className="flex items-baseline justify-between border-b border-sand/30 px-lg py-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">Customer</p>
            <h2 className="mt-xs font-serif text-h2 text-stone">
              {data?.customer
                ? `${data.customer.first_name ?? ""} ${data.customer.last_name ?? ""}`.trim() ||
                  data.customer.email ||
                  "—"
                : "Loading…"}
            </h2>
            {data?.customer.email && (
              <a
                href={`mailto:${data.customer.email}`}
                className="text-small text-terracotta hover:underline"
              >
                {data.customer.email}
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20"
          >
            Close · Esc
          </button>
        </header>

        <div className="flex-1 overflow-auto px-lg py-lg space-y-lg">
          {loading && <p className="text-small text-stone/60">Loading customer detail…</p>}
          {error && (
            <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
              {error}
            </div>
          )}

          {data && (
            <>
              {/* Top stat tiles */}
              <section className="grid gap-md md:grid-cols-3">
                <Stat
                  label="Total CLV"
                  value={fmtMoney(data.customer.total_clv ?? null)}
                  sub={
                    data.customer.churn_probability !== null
                      ? `${(data.customer.churn_probability * 100).toFixed(0)}% churn`
                      : undefined
                  }
                  tone={
                    (data.customer.churn_probability ?? 0) >= 0.8
                      ? "critical"
                      : (data.customer.churn_probability ?? 0) >= 0.5
                        ? "warning"
                        : "neutral"
                  }
                />
                <Stat
                  label="Orders (lifetime)"
                  value={
                    data.customer.historic_order_count
                      ? data.customer.historic_order_count.toLocaleString()
                      : "—"
                  }
                  sub={
                    data.customer.average_order_value !== null
                      ? `AOV ${fmtMoney(data.customer.average_order_value)}`
                      : undefined
                  }
                  tone="neutral"
                />
                <Stat
                  label="Last order"
                  value={fmtDate(data.customer.last_order_date)}
                  sub={
                    data.customer.expected_next_order
                      ? `next ~${fmtDate(data.customer.expected_next_order)}`
                      : undefined
                  }
                  tone="neutral"
                />
              </section>

              {/* Local note */}
              <LocalNoteEditor entityType="customer" entityId={data.customer.id} />

              {/* Profile */}
              <section className="rounded-md border border-sand/30 bg-softCream p-lg">
                <h3 className="font-serif text-h3">Profile</h3>
                <dl className="mt-md grid gap-sm md:grid-cols-2 text-small">
                  <Row label="Phone" value={data.customer.phone ?? "—"} />
                  <Row
                    label="Location"
                    value={
                      [data.customer.city, data.customer.region, data.customer.country]
                        .filter(Boolean)
                        .join(", ") || "—"
                    }
                  />
                  <Row label="Source" value={data.customer.source ?? "—"} />
                  <Row label="Created" value={fmtDate(data.customer.created_date)} />
                  <Row
                    label="Email consent"
                    value={data.customer.email_consent ? "✓" : "—"}
                  />
                  <Row
                    label="SMS consent"
                    value={data.customer.sms_consent ? "✓" : "—"}
                  />
                  <Row label="Tags" value={data.customer.shopify_tags ?? "—"} />
                  <Row label="Klaviyo ID" value={data.customer.email ? data.customer.email : "—"} />
                </dl>
              </section>

              {/* Email engagement */}
              <section className="rounded-md border border-sand/30 bg-softCream p-lg">
                <h3 className="font-serif text-h3">Email engagement</h3>
                <dl className="mt-md grid gap-sm md:grid-cols-3 text-small">
                  <Row
                    label="Received"
                    value={(data.customer.emails_received ?? 0).toLocaleString()}
                  />
                  <Row
                    label="Opened"
                    value={
                      data.customer.open_rate !== null
                        ? `${(data.customer.open_rate * 100).toFixed(1)}%  (${(
                            data.customer.emails_opened ?? 0
                          ).toLocaleString()})`
                        : "—"
                    }
                  />
                  <Row
                    label="Clicked"
                    value={
                      data.customer.click_rate !== null
                        ? `${(data.customer.click_rate * 100).toFixed(1)}%  (${(
                            data.customer.emails_clicked ?? 0
                          ).toLocaleString()})`
                        : "—"
                    }
                  />
                  <Row label="Last opened" value={fmtDate(data.customer.last_email_opened)} />
                  <Row label="Last clicked" value={fmtDate(data.customer.last_email_clicked)} />
                  <Row
                    label="Last received"
                    value={fmtDate(data.customer.last_email_received)}
                  />
                </dl>
              </section>

              {/* Order history */}
              <section className="rounded-md border border-sand/30 bg-softCream p-lg">
                <header className="flex flex-wrap items-baseline justify-between gap-md">
                  <h3 className="font-serif text-h3">
                    Order history
                    <span className="ml-sm text-small font-normal text-stone/60">
                      {data.orders_in_db.toLocaleString()} line items in our mirror ·{" "}
                      {fmtMoney(data.revenue_in_db, "CAD")} subtotal
                    </span>
                  </h3>
                  {data.customer.order_count_rollup !== null &&
                    data.customer.order_count_rollup !==
                      uniqueOrders(data.orders) && (
                      <span className="rounded-full bg-warning/15 px-sm py-xs text-tiny uppercase tracking-widest text-warning">
                        Mirror shows {data.customer.order_count_rollup} orders
                      </span>
                    )}
                </header>

                {data.orders.length === 0 ? (
                  <p className="mt-md text-small text-stone/60">
                    No orders mirrored for this customer yet.
                  </p>
                ) : (
                  <div className="mt-md overflow-x-auto">
                    <table className="w-full min-w-[700px] text-small">
                      <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
                        <tr>
                          <th className="px-md py-sm text-left font-medium">Order</th>
                          <th className="px-md py-sm text-left font-medium">Date</th>
                          <th className="px-md py-sm text-left font-medium">Item</th>
                          <th className="px-md py-sm text-right font-medium">Qty</th>
                          <th className="px-md py-sm text-right font-medium">Subtotal</th>
                          <th className="px-md py-sm text-left font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.orders.map((o) => (
                          <OrderRow key={o.id} order={o} onClick={onOpenOrder} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function uniqueOrders(orders: CustomerOrderLine[]): number {
  return new Set(orders.map((o) => o.order_id).filter(Boolean)).size;
}

function OrderRow({
  order: o,
  onClick,
}: {
  order: CustomerOrderLine;
  onClick?: (orderRowId: string) => void;
}) {
  const cancelled = o.cancelled_at_shopify !== null;
  const tone =
    o.order_fulfillment_status === "fulfilled"
      ? "bg-success/15 text-success"
      : o.order_fulfillment_status === "cancelled" || cancelled
        ? "bg-critical/15 text-critical"
        : o.order_fulfillment_status === "partially_fulfilled"
          ? "bg-warning/15 text-warning"
          : "bg-mist/30 text-stone";
  return (
    <tr
      className={`border-t border-sand/30 align-top ${cancelled ? "opacity-60" : ""}`}
    >
      <td className="px-md py-sm font-mono text-tiny">
        {o.order_number ? (
          onClick ? (
            <button
              type="button"
              onClick={() => onClick(o.id)}
              className="text-terracotta hover:underline"
            >
              #{o.order_number}
            </button>
          ) : (
            `#${o.order_number}`
          )
        ) : (
          "—"
        )}
        {o.channel && (
          <div className="text-tiny text-stone/50">{o.channel}</div>
        )}
      </td>
      <td className="px-md py-sm font-mono text-tiny">{fmtDate(o.created_at_shopify)}</td>
      <td className="px-md py-sm">
        <div className="line-clamp-2">{o.line_item_name || "—"}</div>
        {o.sku && <div className="text-tiny font-mono text-stone/50">{o.sku}</div>}
        {o.line_item_tracking_link && (
          <a
            href={o.line_item_tracking_link}
            target="_blank"
            rel="noreferrer"
            className="text-tiny text-terracotta hover:underline"
          >
            track →
          </a>
        )}
      </td>
      <td className="px-md py-sm text-right font-mono">{o.quantity ?? "—"}</td>
      <td className="px-md py-sm text-right font-mono">
        {fmtMoney(o.line_item_subtotal, o.order_currency)}
      </td>
      <td className="px-md py-sm">
        <span
          className={`rounded-full px-sm py-xs text-tiny uppercase tracking-widest ${tone}`}
        >
          {o.order_fulfillment_status || (cancelled ? "cancelled" : "—")}
        </span>
      </td>
    </tr>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-tiny uppercase tracking-widest text-clay">{label}</dt>
      <dd className="mt-xs font-mono text-stone">{value}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "success" | "warning" | "critical" | "neutral";
}) {
  const styles = {
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    critical: "border-critical/40 bg-critical/10 text-critical",
    neutral: "border-sand/40 bg-warmWhite text-stone",
  };
  return (
    <div className={`rounded-md border ${styles[tone]} p-md`}>
      <p className="text-tiny uppercase tracking-widest opacity-70">{label}</p>
      <p className="mt-xs font-mono text-h2">{value}</p>
      {sub && <p className="text-tiny opacity-70">{sub}</p>}
    </div>
  );
}
