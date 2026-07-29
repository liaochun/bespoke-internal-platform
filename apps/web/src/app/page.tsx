"use client";

import Link from "next/link";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { Header } from "@/components/Header";
import { CAP, has, roleLabel } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

type QuickLink = { href: string; label: string; description: string; show: boolean };

function Inner() {
  useDocumentTitle("Home");
  const user = useCurrentUser();

  const links: QuickLink[] = [
    {
      href: "/admin/inventory/dashboard",
      label: "Inventory dashboard",
      description: "Stock levels, revenue snapshot, production capacity",
      show: has(user, CAP.view_inventory) || has(user, CAP.manage_inventory),
    },
    {
      href: "/admin/inventory/production-schedule",
      label: "Production schedule",
      description: "Plan and track today's production runs",
      show: has(user, CAP.view_inventory) || has(user, CAP.manage_inventory),
    },
    {
      href: "/admin/inventory/production-calendar",
      label: "Production calendar",
      description: "Week-at-a-glance view of scheduled runs",
      show: has(user, CAP.view_inventory) || has(user, CAP.manage_inventory),
    },
    {
      href: "/admin/schedule",
      label: "Schedule builder",
      description: "Plan staff shifts for the week",
      show: has(user, CAP.manage_schedule),
    },
    {
      href: "/admin/sick-calls",
      label: "Sick calls",
      description: "Open shift offers, first-to-claim workflow",
      show: has(user, CAP.manage_schedule),
    },
    {
      href: "/admin/timesheets",
      label: "Timesheets",
      description: "Hours worked, payroll export",
      show: has(user, CAP.view_timesheets) || has(user, CAP.export_timesheets),
    },
    {
      href: "/admin/users",
      label: "Users & invites",
      description: "Staff directory, roles, kiosk PINs",
      show: has(user, CAP.view_users) || has(user, CAP.manage_users),
    },
    {
      href: "/admin/roles",
      label: "Roles & capabilities",
      description: "Configure default capabilities per role",
      show: has(user, CAP.manage_permissions),
    },
    {
      href: "/me/schedule",
      label: "My schedule",
      description: "Your upcoming shifts, call in sick",
      show: true,
    },
    {
      href: "/kiosk/clock",
      label: "Kiosk clock-in",
      description: "Shared-device PIN clock in/out",
      show: true,
    },
  ];

  const visible = links.filter((l) => l.show);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-4xl px-md py-xl space-y-xl md:px-lg md:py-2xl">
        <header>
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">
            Northbound Ops · Interactive demo
          </p>
          <h1 className="mt-sm font-serif text-display text-stone">
            Welcome back, {user.full_name.split(" ")[0]}
          </h1>
          <p className="mt-md text-body text-stone/70">
            You&apos;re viewing this demo as <strong>{roleLabel(user.role)}</strong>. Use the persona
            switcher in the header to see how the same app looks for other roles — every page below
            is gated by real capability checks, not just a role label.
          </p>
        </header>

        <section className="grid gap-md md:grid-cols-2">
          {visible.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="block rounded-md border border-sand/30 bg-softCream p-lg hover:border-terracotta hover:bg-warmWhite"
            >
              <h2 className="font-serif text-h3 text-stone">{l.label}</h2>
              <p className="mt-xs text-small text-stone/70">{l.description}</p>
            </Link>
          ))}
        </section>
      </main>
    </>
  );
}

export default function HomePage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}
