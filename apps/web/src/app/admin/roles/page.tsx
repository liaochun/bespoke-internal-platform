// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import { AuthGate } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { Header } from "@/components/Header";
import {
  ApiError,
  CapabilityCatalog,
  createRole,
  fetchCapabilityCatalog,
  listRoles,
  RoleDefinition,
} from "@/lib/api";
import { CAP } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function Inner() {
  useDocumentTitle("Roles & capabilities");
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async (silent = false) => {
    if (!silent) setError(null);
    try {
      const [r, c] = await Promise.all([listRoles(), fetchCapabilityCatalog()]);
      setRoles(r);
      setCatalog(c);
    } catch (e) {
      if (!silent) setError(e instanceof ApiError && e.status < 500 ? (e.message || "Request failed.") : "Server error. Please try again.");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      await createRole({
        key: String(fd.get("key") || ""),
        label: String(fd.get("label") || ""),
        description: (String(fd.get("description") || "") || null) as string | null,
        based_on: (String(fd.get("based_on") || "") || null) as string | null,
      });
      form.reset();
      setCreating(false);
      await refresh(true);
    } catch (err) {
      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    }
  };

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-md py-xl space-y-xl md:px-lg md:py-2xl md:space-y-2xl">
        <header className="flex flex-wrap items-baseline justify-between gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">People</p>
            <h1 className="mt-sm font-serif text-display text-stone">Roles</h1>
            <p className="mt-md text-body text-stone/70">
              Each role has a default set of capabilities. Admins can edit the current set; super
              admins lock them in as default. Per-user grants/denials live on each staff page.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90"
          >
            {creating ? "Cancel" : "New role"}
          </button>
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        {creating && (
          <section className="rounded-md border border-sand/30 bg-softCream p-lg">
            <h2 className="font-serif text-h2">New role</h2>
            <form onSubmit={onCreate} className="mt-md grid gap-md md:grid-cols-2">
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">Key (snake_case)</span>
                <input
                  name="key"
                  required
                  pattern="[a-z][a-z0-9_]*"
                  placeholder="production_lead"
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
                />
              </label>
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">Label</span>
                <input
                  name="label"
                  required
                  placeholder="Production Lead"
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                />
              </label>
              <label className="block text-small md:col-span-2">
                <span className="text-tiny uppercase tracking-widest text-clay">Description</span>
                <input
                  name="description"
                  placeholder="Briefly describe what this role does"
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                />
              </label>
              <label className="block text-small md:col-span-2">
                <span className="text-tiny uppercase tracking-widest text-clay">
                  Copy initial defaults from (optional)
                </span>
                <select
                  name="based_on"
                  defaultValue=""
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                >
                  <option value="">Start from scratch</option>
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="md:col-span-2 flex justify-end">
                <button
                  type="submit"
                  className="rounded-sm bg-terracotta px-lg py-sm text-small font-medium text-warmWhite hover:opacity-90"
                >
                  Create
                </button>
              </div>
            </form>
          </section>
        )}

        {!catalog ? (
          <p className="text-small text-stone/60">Loading…</p>
        ) : (
          <ul className="grid gap-md md:grid-cols-2">
            {roles.map((r) => {
              const drift = !arraysEqual(r.default_capabilities, r.canonical_capabilities);
              return (
                <li key={r.key}>
                  <Link
                    href={`/admin/roles/${r.key}`}
                    className="group block h-full rounded-md border border-sand/30 bg-softCream p-lg hover:border-terracotta hover:bg-warmWhite"
                  >
                    <div className="flex items-baseline justify-between gap-md">
                      <div>
                        <h3 className="font-serif text-h3 text-stone">{r.label}</h3>
                        <p className="font-mono text-tiny text-clay">{r.key}</p>
                      </div>
                      <span
                        className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
                          r.is_built_in ? "bg-mist/30 text-stone" : "bg-sage/15 text-sage"
                        }`}
                      >
                        {r.is_built_in ? "Built-in" : "Custom"}
                      </span>
                    </div>
                    {r.description && (
                      <p className="mt-sm text-small text-stone/70">{r.description}</p>
                    )}
                    <div className="mt-md flex items-baseline justify-between text-tiny">
                      <span className="text-stone/60">
                        {r.default_capabilities.length} of {catalog.capabilities.length}{" "}
                        capabilities
                      </span>
                      {drift && (
                        <span className="text-warning uppercase tracking-widest">
                          Diverged from default
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}

export default function RolesPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.manage_permissions]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
