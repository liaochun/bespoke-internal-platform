// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type NavItem = {
  href: string;
  label: string;
  description?: string;
  // Red badge count rendered to the right of the label. Falsy/zero hides it.
  badge?: number;
  // Fires when this item's link is clicked — used to bump per-category
  // last_seen timestamps so personal badges clear on click.
  onClick?: () => void;
};

function Badge({ count }: { count: number }) {
  if (!count || count <= 0) return null;
  // Cap at 99 so a runaway queue doesn't blow out the dropdown width.
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className="ml-xs inline-flex min-w-[18px] items-center justify-center rounded-full bg-critical px-xs py-[1px] font-mono text-tiny font-medium leading-none text-warmWhite"
      aria-label={`${count} new`}
    >
      {label}
    </span>
  );
}

export function NavDropdown({
  label,
  items,
}: {
  label: string;
  items: NavItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // Surface a single rolled-up badge on the closed dropdown trigger so a
  // manager scanning the nav can tell at a glance there's something pending
  // without expanding every menu.
  const totalBadge = items.reduce((sum, item) => sum + (item.badge ?? 0), 0);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-xs rounded-sm px-sm py-xs text-small text-stone/70 hover:text-stone"
      >
        <span>{label}</span>
        <Badge count={totalBadge} />
        <span aria-hidden className={`text-tiny transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-xs min-w-56 rounded-md border border-sand/40 bg-warmWhite shadow-lg"
        >
          <ul className="py-xs">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => {
                    setOpen(false);
                    item.onClick?.();
                  }}
                  className="block px-md py-sm text-small text-stone hover:bg-sand/20"
                  role="menuitem"
                >
                  <span className="inline-flex items-center font-medium">
                    {item.label}
                    <Badge count={item.badge ?? 0} />
                  </span>
                  {item.description && (
                    <span className="block text-tiny text-stone/60">{item.description}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
