// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sub-nav tab bar for the Production top-level section. Split out of
 * InventoryNav's former "production" group so Production has its own
 * top-level nav entry (see Header.tsx) instead of living under Inventory.
 * Keep this list in sync with `productionLinks()` in Header.tsx.
 */
const TABS = [
  { href: "/admin/inventory/production-schedule", label: "Production run" },
  { href: "/admin/inventory/production-calendar", label: "Calendar" },
  { href: "/admin/inventory/production-history", label: "Production history" },
  { href: "/admin/inventory/recipes", label: "Recipes" },
  { href: "/admin/inventory/production-rates/guardrails", label: "Rate guardrails" },
];

export function ProductionNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-sand/20 bg-warmWhite/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="mx-auto max-w-7xl px-lg">
        <nav className="flex flex-wrap items-center gap-xs py-sm">
          {TABS.map((t) => {
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
  );
}
