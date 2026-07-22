// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { globalSearch, GlobalSearchHit } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  master_item: "Master items",
  variant: "Variants",
  customer: "Customers",
  order: "Orders",
  retailer: "Retailers",
};

const TYPE_ORDER = ["master_item", "variant", "customer", "order", "retailer"];

/** Map a hit to a destination URL. Customers/Orders go to the table page;
 * Master Items go to the existing item detail page; Variants too.
 * (Drawer-based deep-linking would require URL state — out of scope.) */
function hitHref(hit: GlobalSearchHit): string {
  switch (hit.entity_type) {
    case "master_item":
      return `/admin/inventory/items/${hit.id}`;
    case "variant":
      // Variants don't have a detail page; jump to the variants list filtered by sku
      return `/admin/inventory/variants${hit.secondary ? `?q=${encodeURIComponent(hit.secondary)}` : ""}`;
    case "customer":
      return `/admin/inventory/customers${hit.secondary ? `?q=${encodeURIComponent(hit.secondary)}` : ""}`;
    case "order":
      return `/admin/inventory/orders${hit.tertiary ? `?q=${encodeURIComponent(hit.tertiary)}` : ""}`;
    case "retailer":
      return `/admin/inventory/retailers${hit.primary ? `?q=${encodeURIComponent(hit.primary)}` : ""}`;
    default:
      return "/admin/inventory/dashboard";
  }
}

export function GlobalSearch({ open, onClose }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GlobalSearchHit[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setHits([]);
      setCounts({});
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await globalSearch(trimmed);
        setHits(r.hits);
        setCounts(r.counts_by_type);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Group hits by type
  const grouped = useMemo(() => {
    const g: Record<string, GlobalSearchHit[]> = {};
    for (const h of hits) {
      (g[h.entity_type] ||= []).push(h);
    }
    return g;
  }, [hits]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-stone/40 p-md pt-2xl"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-sand/30 bg-warmWhite shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-md border-b border-sand/30 px-lg py-md">
          <span className="font-mono text-tiny uppercase tracking-widest text-clay">
            Search
          </span>
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="SKU, customer email, order number, retailer name…"
            className="flex-1 border-0 bg-transparent text-body focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-tiny text-stone/60 hover:text-stone"
          >
            Esc
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && q && (
            <p className="px-lg py-md text-small text-stone/60">Searching…</p>
          )}
          {!loading && q && hits.length === 0 && (
            <p className="px-lg py-md text-small text-stone/60">
              No matches for {q ? `"${q}"` : "that"}.
            </p>
          )}
          {!q && (
            <p className="px-lg py-md text-small text-stone/60">
              Type to search across master items, variants, customers, orders, and retailers.
              {" "}
              <kbd className="rounded-sm border border-sand bg-warmWhite px-xs py-xs text-tiny">Esc</kbd>{" "}
              to close.
            </p>
          )}
          {TYPE_ORDER.map((t) => {
            const list = grouped[t];
            if (!list || list.length === 0) return null;
            return (
              <section key={t} className="border-t border-sand/30 first:border-t-0">
                <header className="flex items-baseline justify-between bg-softCream px-lg py-xs">
                  <span className="text-tiny uppercase tracking-widest text-clay">
                    {TYPE_LABEL[t]}
                  </span>
                  <span className="text-tiny text-stone/50">
                    {counts[t] ?? list.length}
                    {(counts[t] ?? 0) >= 8 && "+"}
                  </span>
                </header>
                <ul>
                  {list.map((h) => (
                    <li key={`${h.entity_type}-${h.id}`}>
                      <Link
                        href={hitHref(h) as never}
                        onClick={onClose}
                        className="block border-t border-sand/20 px-lg py-sm hover:bg-sand/10 first:border-t-0"
                      >
                        <div className="font-medium text-stone">{h.primary}</div>
                        {h.secondary && (
                          <div className="text-tiny text-stone/60">{h.secondary}</div>
                        )}
                        {h.tertiary && (
                          <div className="text-tiny text-stone/50">{h.tertiary}</div>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
