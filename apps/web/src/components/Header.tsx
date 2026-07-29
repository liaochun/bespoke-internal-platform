// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useCurrentUser } from "@/components/AuthGate";
import { HeaderSyncDot } from "@/components/HeaderSyncDot";
import { NavDropdown, NavItem } from "@/components/NavDropdown";
import { PersonaSwitcher } from "@/components/PersonaSwitcher";
import { CurrentUser, fetchNavLayout, logout, NavLayout } from "@/lib/api";
import {
  CAP,
  canManageWorkforce,
  canViewDocuments,
  clocksIn,
  has,
  roleLabel,
} from "@/lib/capabilities";
import {
  type NotificationBadges,
  useNotificationBadges,
} from "@/lib/useNotificationBadges";

function staffLinks(badges: NotificationBadges): NavItem[] {
  return [
    { href: "/me/schedule", label: "My schedule", description: "Upcoming shifts" },
    {
      href: "/me/hours",
      label: "My hours",
      description: "This week + request fixes",
      badge: badges.myCorrectionUpdates,
      onClick: () => badges.markSeen("my_punch_corrections"),
    },
    { href: "/me/availability", label: "My availability", description: "Hours you can work each weekday" },
    {
      href: "/me/time-off",
      label: "My time off",
      description: "Request OOO",
      badge: badges.myTimeOffUpdates,
      onClick: () => badges.markSeen("my_time_off"),
    },
    { href: "/me/notifications", label: "Notifications", description: "Email preferences" },
    { href: "/me/profile", label: "Profile", description: "Change your display name" },
  ];
}

function workforceLinks(user: CurrentUser, badges: NotificationBadges): NavItem[] {
  const items: NavItem[] = [];
  if (has(user, CAP.manage_schedule)) {
    items.push({
      href: "/admin/schedule",
      label: "Schedule builder",
      description: "Plan staff shifts",
    });
    items.push({
      href: "/admin/time-off",
      label: "Time off",
      description: "Approve OOO requests",
      badge: badges.pendingTimeOff,
    });
    items.push({
      href: "/admin/sick-calls",
      label: "Sick calls",
      description: "Pending sick calls + open offers",
      badge: badges.pendingSickCalls,
    });
  }
  if (has(user, CAP.review_corrections)) {
    items.push({
      href: "/admin/punch-corrections",
      label: "Punch corrections",
      description: "Approve fixes",
      badge: badges.pendingCorrections,
    });
  }
  if (has(user, CAP.print_qr)) {
    items.push({ href: "/admin/qr", label: "Studio QR", description: "Print clock-in code" });
  }
  if (clocksIn(user)) {
    items.push(
      { href: "/me/schedule", label: "My schedule", description: "Your own upcoming shifts" },
      {
        href: "/me/hours",
        label: "My hours",
        description: "Your own punches",
        badge: badges.myCorrectionUpdates,
        onClick: () => badges.markSeen("my_punch_corrections"),
      },
      { href: "/me/availability", label: "My availability", description: "Hours you can work each weekday" },
      {
        href: "/me/time-off",
        label: "My time off",
        description: "Request OOO",
        badge: badges.myTimeOffUpdates,
        onClick: () => badges.markSeen("my_time_off"),
      },
      { href: "/me/notifications", label: "Notifications", description: "Email preferences" },
      { href: "/me/profile", label: "Profile", description: "Change your display name" },
    );
  }
  return items;
}

function inventoryLinks(user: CurrentUser): NavItem[] {
  const items: NavItem[] = [];
  if (process.env.NEXT_PUBLIC_INVENTORY_ENABLED === "false") return items;
  if (has(user, CAP.view_inventory) || has(user, CAP.manage_inventory)) {
    items.push({
      href: "/admin/inventory",
      label: "Master items",
      description: "Catalog + stock by location",
    });
  }
  return items;
}

/**
 * Production has its own top-level nav entry, separate from Inventory (was
 * previously the "production" group nested inside the Inventory sub-nav —
 * see InventoryNav.tsx / ProductionNav.tsx). Same gating as Inventory since
 * it's still fed by the same capability + feature flag.
 */
function productionLinks(user: CurrentUser): NavItem[] {
  const items: NavItem[] = [];
  if (process.env.NEXT_PUBLIC_INVENTORY_ENABLED === "false") return items;
  if (has(user, CAP.view_inventory) || has(user, CAP.manage_inventory)) {
    items.push(
      {
        href: "/admin/inventory/production-schedule",
        label: "Production run",
        description: "Plan + track today's runs",
      },
      {
        href: "/admin/inventory/production-calendar",
        label: "Calendar",
        description: "Scheduled runs by day",
      },
      {
        href: "/admin/inventory/production-history",
        label: "Production history",
        description: "Completed runs",
      },
      {
        href: "/admin/inventory/recipes",
        label: "Recipes",
        description: "BOM recipes for finished SKUs",
      },
      {
        href: "/admin/inventory/production-rates/guardrails",
        label: "Rate guardrails",
        description: "Per-SKU production rate limits",
      },
    );
  }
  return items;
}

/**
 * Single "Admin" dropdown gathering all back-office / management surfaces.
 * Each item is independently capability-gated so a viewer-only manager
 * doesn't see admin-write things they can't use.
 *
 * The dropdown itself only renders when at least one item passes its gate
 * (handled by the Header via `adminLinks(user).length > 0`).
 */
function adminLinks(
  user: CurrentUser,
  badges?: { pendingDisciplineActions: number },
): NavItem[] {
  const items: NavItem[] = [];
  if (has(user, CAP.view_users) || has(user, CAP.manage_users) || has(user, CAP.manage_invites)) {
    items.push({
      href: "/admin/users",
      label: "Users & invites",
      description: "Staff list, roles, kiosk PIN, invites",
    });
  }
  if (has(user, CAP.manage_users)) {
    items.push({
      href: "/admin/discipline/queue",
      label: "Discipline",
      description: "Queue, history, and PIPS policy",
      badge: badges?.pendingDisciplineActions || undefined,
    });
  }
  if (canViewDocuments(user)) {
    items.push({
      href: "/admin/documents",
      label: "Documents",
      description: "Generated PIPS & discipline documents",
    });
  }
  if (user.role === "super_admin") {
    items.push({
      href: "/admin/view-as",
      label: "View as user",
      description: "Open any staff member's read-only capability preview",
    });
    items.push({
      href: "/admin/bug-reports",
      label: "Bug reports",
      description: "Triage user-submitted bug reports",
    });
    items.push({
      href: "/admin/schedule-tools",
      label: "Schedule tools",
      description: "Clear all schedules + restore from a snapshot",
    });
    items.push({
      href: "/admin/nav-layout",
      label: "Nav layout",
      description: "Reorder the tabs in each nav section",
    });
  }
  if (has(user, CAP.manage_permissions)) {
    items.push({
      href: "/admin/roles",
      label: "Roles & capabilities",
      description: "Configure defaults per role",
    });
  }
  if (has(user, CAP.review_corrections)) {
    items.push({
      href: "/admin/kiosk-activity",
      label: "Kiosk activity",
      description: "Audit device-to-staff usage for abuse",
    });
  }
  if (has(user, CAP.view_timesheets) || has(user, CAP.export_timesheets)) {
    items.push({
      href: "/admin/timesheets",
      label: "Timesheets",
      description: "Hours export for payroll",
    });
  }
  if (has(user, CAP.manage_inventory)) {
    items.push({
      href: "/admin/integrations",
      label: "Integrations",
      description: "Shopify webhooks + setup",
    });
  }
  return items;
}

/**
 * Apply the global, super-admin-set order to a section's items.
 *
 * Items whose `href` appears in `order` are placed first, in that order.
 * Everything else keeps its default (code) relative order and is appended
 * after the ordered ones — so a brand-new feature the layout doesn't mention
 * still shows up. Ordering NEVER adds or removes items: it's a pure re-sort of
 * whatever already passed capability gating.
 */
function applyOrder(items: NavItem[], order: string[] | undefined): NavItem[] {
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((href, i) => [href, i]));
  // Stable sort: known items by their saved rank; unknown items sink to the
  // end while preserving their original relative order.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.has(a.item.href) ? (rank.get(a.item.href) as number) : Infinity;
      const rb = rank.has(b.item.href) ? (rank.get(b.item.href) as number) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.i - b.i; // tie-break by original position (keeps default order)
    })
    .map(({ item }) => item);
}

/**
 * Fetch the global nav layout once on mount. Returns `null` until loaded so
 * the Header can render the default order immediately and re-sort when the
 * layout arrives — avoids a loading flicker / empty nav. A failed fetch just
 * leaves the default order in place (never blocks the nav).
 */
function useNavLayout(): NavLayout["sections"] | null {
  const [sections, setSections] = useState<NavLayout["sections"] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchNavLayout()
      .then((res) => {
        if (alive) setSections(res.sections ?? {});
      })
      .catch(() => {
        if (alive) setSections({}); // fall back to code order
      });
    return () => {
      alive = false;
    };
  }, []);
  return sections;
}

export function Header() {
  const user = useCurrentUser();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const badges = useNotificationBadges(user);
  const navLayout = useNavLayout();

  // Build the gated item set, then re-sort each section by the saved global
  // order. Until the layout loads (navLayout === null) we render code order.
  const wfLinks = applyOrder(workforceLinks(user, badges), navLayout?.workforce);
  const adLinks = applyOrder(adminLinks(user, badges), navLayout?.admin);
  const invLinks = applyOrder(inventoryLinks(user), navLayout?.inventory);
  // Production isn't a NavLayout section (yet) — it just keeps its default
  // (code) order rather than plugging into the super-admin reorder tool.
  const prodLinks = productionLinks(user);
  const stLinks = applyOrder(staffLinks(badges), navLayout?.me);

  const showWorkforce = wfLinks.length > 0;
  const showInventory = invLinks.length > 0;
  const showProduction = prodLinks.length > 0;
  const showAdmin = adLinks.length > 0;

  const onLogout = async () => {
    try {
      await logout();
    } finally {
      // No real session to end in the demo — just bounce home.
      router.replace("/");
      router.refresh();
    }
  };

  const initials = user.full_name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

  // For staff-only users (no workforce management and no admin access),
  // collapse to a flat 2-link nav. Anyone with even one admin item gets
  // the full dropdown experience.
  const isStaffOnly = !canManageWorkforce(user) && !showAdmin;

  return (
    <header className="border-b border-sand/30 bg-warmWhite">
      <div className="mx-auto flex max-w-6xl items-center gap-md px-md py-md md:px-lg">
        <Link href="/" className="flex items-center gap-xs font-serif text-h3 text-stone hover:opacity-80">
          Northbound Ops
        </Link>

        {/* Desktop nav */}
        <nav className="ml-md hidden items-center gap-md lg:flex">
          {isStaffOnly ? (
            stLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => l.onClick?.()}
                className="inline-flex items-center text-small text-stone/70 hover:text-stone"
              >
                {l.label}
                {l.badge && l.badge > 0 ? (
                  <span
                    className="ml-xs inline-flex min-w-[18px] items-center justify-center rounded-full bg-critical px-xs py-[1px] font-mono text-tiny font-medium leading-none text-warmWhite"
                    aria-label={`${l.badge} new`}
                  >
                    {l.badge > 99 ? "99+" : l.badge}
                  </span>
                ) : null}
              </Link>
            ))
          ) : (
            <>
              {showWorkforce && wfLinks.length > 0 && (
                <NavDropdown label="Workforce" items={wfLinks} />
              )}
              {showInventory && <NavDropdown label="Inventory" items={invLinks} />}
              {showProduction && <NavDropdown label="Production" items={prodLinks} />}
              {showAdmin && <NavDropdown label="Admin" items={adLinks} />}
            </>
          )}
        </nav>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-sm">
          <PersonaSwitcher />
          <HeaderSyncDot />
          <Link
            href="/me/profile"
            className="hidden items-center gap-sm rounded-sm px-xs py-xs hover:bg-sand/20 md:flex"
            title="Profile"
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-sand/40 font-mono text-tiny font-medium text-stone"
              aria-hidden
            >
              {initials}
            </span>
            <span className="hidden flex-col text-tiny leading-tight md:flex">
              <span className="text-stone">{user.full_name}</span>
              <span className="uppercase tracking-widest text-clay">
                {roleLabel(user.role)}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onLogout}
            className="hidden rounded-sm border border-sand px-md py-xs text-small text-stone transition-colors duration-fast ease-northbound hover:bg-sand/20 md:block"
          >
            Sign out
          </button>

          {/* Mobile/tablet menu button */}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            className="rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20 lg:hidden"
            aria-expanded={drawerOpen}
            aria-label="Toggle navigation"
          >
            {drawerOpen ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="border-t border-sand/30 bg-softCream lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col gap-md px-md py-md md:px-lg">
            <PersonaSwitcher />
            {showWorkforce && wfLinks.length > 0 && (
              <DrawerSection title="Workforce" links={wfLinks} onClick={() => setDrawerOpen(false)} />
            )}
            {showInventory && (
              <DrawerSection title="Inventory" links={invLinks} onClick={() => setDrawerOpen(false)} />
            )}
            {showProduction && (
              <DrawerSection title="Production" links={prodLinks} onClick={() => setDrawerOpen(false)} />
            )}
            {showAdmin && (
              <DrawerSection title="Admin" links={adLinks} onClick={() => setDrawerOpen(false)} />
            )}
            {isStaffOnly && (
              <DrawerSection title="Me" links={stLinks} onClick={() => setDrawerOpen(false)} defaultOpen />
            )}
            <div className="border-t border-sand/30 pt-md">
              <p className="text-tiny text-stone/60">{user.full_name}</p>
              <p className="text-tiny text-stone/50">{user.email}</p>
              <p className="mt-xs text-tiny uppercase tracking-widest text-clay">
                {roleLabel(user.role)}
              </p>
              <button
                type="button"
                onClick={onLogout}
                className="mt-md rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function DrawerSection({
  title,
  links,
  onClick,
  defaultOpen = false,
}: {
  title: string;
  links: NavItem[];
  onClick: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Aggregate badge so a collapsed section still signals pending items.
  const totalBadge = links.reduce((sum, l) => sum + (l.badge ?? 0), 0);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-sm px-sm py-sm text-left hover:bg-sand/20"
      >
        <span className="inline-flex items-center text-tiny uppercase tracking-widest text-clay">
          {title}
          {totalBadge > 0 && (
            <span
              className="ml-xs inline-flex min-w-[18px] items-center justify-center rounded-full bg-critical px-xs py-[1px] font-mono text-tiny font-medium leading-none text-warmWhite"
              aria-label={`${totalBadge} new`}
            >
              {totalBadge > 99 ? "99+" : totalBadge}
            </span>
          )}
        </span>
        <span
          className={`text-stone/50 transition-transform duration-fast ease-northbound ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
      </button>
      {open && (
      <ul className="mt-xs space-y-xs">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              onClick={() => {
                l.onClick?.();
                onClick();
              }}
              className="block rounded-sm px-sm py-sm text-small text-stone hover:bg-sand/20"
            >
              <span className="inline-flex items-center">
                {l.label}
                {l.badge && l.badge > 0 ? (
                  <span
                    className="ml-xs inline-flex min-w-[18px] items-center justify-center rounded-full bg-critical px-xs py-[1px] font-mono text-tiny font-medium leading-none text-warmWhite"
                    aria-label={`${l.badge} new`}
                  >
                    {l.badge > 99 ? "99+" : l.badge}
                  </span>
                ) : null}
              </span>
              {l.description && (
                <span className="block text-tiny text-stone/50">{l.description}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
