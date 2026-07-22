// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GlobalSearch } from "@/components/GlobalSearch";

type Version = "v1" | "v2";
type Group = "sales" | "transfers" | "in_out" | "system" | "items" | "tools";
type Tab = { href: string; label: string; version: Version; group?: Group };

// v1 = legacy Airtable mirrors (read-mostly, push back to Airtable).
// v2 = Postgres-canonical ops platform (Phase B onward).
const TABS: Tab[] = [
  // v1
  { href: "/admin/inventory/dashboard", label: "Dashboard", version: "v1" },
  { href: "/admin/inventory/revenue", label: "Revenue", version: "v1" },
  { href: "/admin/inventory/master-items", label: "Master items", version: "v1" },
  { href: "/admin/inventory/variants", label: "Variants", version: "v1" },
  { href: "/admin/inventory/orders", label: "Orders", version: "v1" },
  { href: "/admin/inventory/customers", label: "Customers", version: "v1" },
  { href: "/admin/inventory/retail-orders", label: "Retail orders", version: "v1" },
  { href: "/admin/inventory/retailers", label: "Retailers", version: "v1" },
  { href: "/admin/inventory/transactions", label: "Transactions", version: "v1" },
  { href: "/admin/inventory/transfers", label: "Transfers", version: "v1" },
  { href: "/admin/inventory/production-runs", label: "Production", version: "v1" },
  { href: "/admin/inventory/production-planning", label: "Planning", version: "v1" },
  { href: "/admin/inventory/buy-list", label: "Buy list", version: "v1" },
  { href: "/admin/inventory/bom", label: "BOM (Recipes)", version: "v1" },
  { href: "/admin/inventory/ingredients", label: "Ingredients", version: "v1" },
  { href: "/admin/inventory/suppliers", label: "Suppliers", version: "v1" },
  { href: "/admin/inventory/wholesale-pricing", label: "Wholesale pricing", version: "v1" },
  { href: "/admin/inventory/products", label: "Products", version: "v1" },
  { href: "/admin/inventory/order-summary", label: "Order summary", version: "v1" },
  { href: "/admin/inventory/retail-orders-jack", label: "Retail orders (Jack)", version: "v1" },
  { href: "/admin/inventory/sync-errors", label: "Sync errors", version: "v1" },
  // v2 — production: moved to its own top-level nav entry (Header.tsx +
  // ProductionNav.tsx). Routes are unchanged, just no longer listed here.
  // v2 — sales (Shopify orders/customers/revenue)
  { href: "/admin/inventory/orders-v2", label: "Orders", version: "v2", group: "sales" },
  { href: "/admin/inventory/customers-v2", label: "Customers", version: "v2", group: "sales" },
  { href: "/admin/inventory/revenue-v2", label: "Revenue", version: "v2", group: "sales" },
  // v2 — transfers & POs
  { href: "/admin/inventory/transfers-v2", label: "Transfers", version: "v2", group: "transfers" },
  { href: "/admin/inventory/documents-v2", label: "All Documents", version: "v2", group: "transfers" },
  { href: "/admin/inventory/purchase-orders", label: "Purchase orders", version: "v2", group: "transfers" },
  { href: "/admin/inventory/in-transit", label: "In Transit", version: "v2", group: "transfers" },
  { href: "/admin/inventory/replenishment", label: "Replenishment", version: "v2", group: "transfers" },
  // v2 — incoming / outgoing
  { href: "/admin/inventory/incoming-v2", label: "Incoming", version: "v2", group: "in_out" },
  { href: "/admin/inventory/outgoing-v2", label: "Outgoing", version: "v2", group: "in_out" },
  // v2 — system
  { href: "/admin/inventory/sync-errors-v2", label: "Sync errors", version: "v2", group: "system" },
  { href: "/admin/inventory/shopify-drift", label: "Shopify drift", version: "v2", group: "system" },
  { href: "/admin/inventory/check", label: "Check + Lookback", version: "v2", group: "system" },
  { href: "/admin/inventory/platform-drift", label: "Platform drift", version: "v2", group: "system" },
  // v2 — items (the rest)
  { href: "/admin/inventory/master-items-v2", label: "Master items", version: "v2", group: "items" },
  { href: "/admin/inventory/variants-v2", label: "Variants - Shopify", version: "v2", group: "items" },
  { href: "/admin/inventory/variants-mapping", label: "Variant mapping", version: "v2", group: "items" },
  { href: "/admin/inventory/suppliers-v2", label: "Suppliers", version: "v2", group: "items" },
  { href: "/admin/inventory/ingredients-v2", label: "Ingredients/Supplies", version: "v2", group: "items" },
  // v2 — tools
  { href: "/admin/inventory/reconciliation-v2", label: "Reconciliation", version: "v2", group: "tools" },
];

const GROUPS: { id: Group; label: string; highlight?: boolean }[] = [
  { id: "sales", label: "Sales (Shopify)" },
  { id: "transfers", label: "Transfers & POs" },
  { id: "in_out", label: "Incoming / Outgoing" },
  { id: "system", label: "System" },
  { id: "items", label: "Items" },
  { id: "tools", label: "Tools" },
];

const VERSION_KEY = "northbound.inventory.version";
const GROUP_KEY = "northbound.inventory.group";
const SHOW_V1 = process.env.NEXT_PUBLIC_SHOW_AIRTABLE_V1 === "true";

export function InventoryNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);

  const activeTab = TABS.find((t) => t.href === pathname);

  const [version, setVersion] = useState<Version>(() => {
    if (!SHOW_V1) return "v2";
    return activeTab?.version ?? "v1";
  });

  const [group, setGroup] = useState<Group>(() => activeTab?.group ?? "transfers");

  // After hydration: restore last-used preferences unless active route says otherwise.
  useEffect(() => {
    if (activeTab) {
      if (SHOW_V1) setVersion(activeTab.version);
      if (activeTab.group) setGroup(activeTab.group);
      return;
    }
    if (typeof window === "undefined") return;
    const storedVersion = window.localStorage.getItem(VERSION_KEY) as Version | null;
    if (storedVersion === "v1" || storedVersion === "v2") {
      setVersion(SHOW_V1 ? storedVersion : "v2");
    }
    const storedGroup = window.localStorage.getItem(GROUP_KEY) as Group | null;
    if (storedGroup && GROUPS.some((g) => g.id === storedGroup)) setGroup(storedGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const persistVersion = (v: Version) => {
    setVersion(v);
    if (typeof window !== "undefined") window.localStorage.setItem(VERSION_KEY, v);
  };

  const persistGroup = (g: Group) => {
    setGroup(g);
    if (typeof window !== "undefined") window.localStorage.setItem(GROUP_KEY, g);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const visible = version === "v1"
    ? TABS.filter((t) => t.version === "v1")
    : TABS.filter((t) => t.version === "v2" && t.group === group);

  return (
    <>
      <div className="border-b border-sand/20 bg-warmWhite/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="mx-auto max-w-7xl px-lg">
        {/* Version toggle — only shown when v1 is enabled (production) */}
        {SHOW_V1 && (
          <div className="flex flex-wrap items-center gap-xs mb-xs">
            <button
              type="button"
              onClick={() => persistVersion("v1")}
              className={`rounded-sm px-md py-xs text-tiny font-medium uppercase tracking-widest transition ${
                version === "v1"
                  ? "bg-stone text-warmWhite"
                  : "border border-sand bg-warmWhite text-stone hover:bg-sand/20"
              }`}
            >
              v1 · Airtable
            </button>
            <button
              type="button"
              onClick={() => persistVersion("v2")}
              className={`rounded-sm px-md py-xs text-tiny font-medium uppercase tracking-widest transition ${
                version === "v2"
                  ? "bg-terracotta text-warmWhite"
                  : "border border-sand bg-warmWhite text-stone hover:bg-sand/20"
              }`}
            >
              v2 · Postgres
            </button>
            <span className="ml-sm text-tiny text-stone/50">
              {version === "v1" ? "Legacy surface" : "Canonical surface"}
            </span>
          </div>
        )}

        {/* Group selector — v2 only */}
        {version === "v2" && (
          <div className="flex flex-wrap items-center gap-xs mb-xs">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  persistGroup(g.id);
                  const firstTab = TABS.find((t) => t.version === "v2" && t.group === g.id);
                  if (firstTab) router.push(firstTab.href);
                }}
                className={`rounded-sm px-md py-xs text-tiny font-medium uppercase tracking-widest transition ${
                  group === g.id
                    ? "bg-terracotta text-warmWhite"
                    : g.highlight
                      ? "border-2 border-terracotta bg-warmWhite text-terracotta hover:bg-terracotta/10"
                      : "border border-sand bg-warmWhite text-stone hover:bg-sand/20"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}

        {/* Tab row */}
        <nav className="mt-xs flex flex-wrap items-center gap-xs pb-sm">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="whitespace-nowrap rounded-sm border border-sand bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
            title="Open global search (Ctrl/Cmd+K)"
          >
            🔍 Search · ⌘K
          </button>
          {visible.map((t) => {
            const isExact = pathname === t.href;
            return (
              <Link
                key={t.href}
                href={t.href as never}
                className={`whitespace-nowrap rounded-sm border px-md py-xs text-tiny uppercase tracking-widest transition ${
                  isExact
                    ? "border-terracotta bg-terracotta text-warmWhite"
                    : "border-sand bg-warmWhite text-stone hover:bg-sand/20"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>

      </div>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
