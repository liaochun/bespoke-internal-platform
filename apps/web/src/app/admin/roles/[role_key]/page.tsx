// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { Header } from "@/components/Header";
import {
  CapabilityCatalog,
  deleteRole,
  fetchCapabilityCatalog,
  fetchRole,
  resetRoleToCanonical,
  resetRoleToFactory,
  RoleDefinition,
  saveRoleAsCanonical,
  updateRole,
} from "@/lib/api";
import { CAP } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function Inner({ roleKey }: { roleKey: string }) {
  const me = useCurrentUser();
  const [role, setRole] = useState<RoleDefinition | null>(null);
  useDocumentTitle(role?.label ? `Role · ${role.label}` : "Role");
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Local working set for in-form editing; only saved on Apply
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  const refresh = async () => {
    setError(null);
    try {
      const [r, c] = await Promise.all([fetchRole(roleKey), fetchCapabilityCatalog()]);
      setRole(r);
      setCatalog(c);
      setWorking(new Set(r.default_capabilities));
      setLabel(r.label);
      setDescription(r.description ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleKey]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  if (!role || !catalog) {
    return (
      <>
        <Header />
        <main className="mx-auto max-w-5xl px-md py-xl md:px-lg md:py-2xl">
          {error ? (
            <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
              {error}
            </div>
          ) : (
            <p className="text-small text-stone/60">Loading…</p>
          )}
        </main>
      </>
    );
  }

  const isSuperAdmin = me.role === "super_admin";
  const dirty =
    !arraysEqual([...working], role.default_capabilities) ||
    label.trim() !== role.label ||
    (description || "") !== (role.description || "");
  const drift = !arraysEqual(role.default_capabilities, role.canonical_capabilities);

  const toggle = (id: string) => {
    setWorking((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onApply = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateRole(roleKey, {
        label: label.trim() !== role.label ? label.trim() : undefined,
        description:
          (description || null) !== (role.description || null) ? description || null : undefined,
        default_capabilities: !arraysEqual([...working], role.default_capabilities)
          ? [...working]
          : undefined,
      });
      setRole(updated);
      setWorking(new Set(updated.default_capabilities));
      setLabel(updated.label);
      setDescription(updated.description ?? "");
      setSuccess("Working defaults saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const callAction = async (
    fn: () => Promise<RoleDefinition>,
    msg: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setRole(updated);
      setWorking(new Set(updated.default_capabilities));
      setLabel(updated.label);
      setDescription(updated.description ?? "");
      setSuccess(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Group capabilities by category
  const byCategory: Record<string, typeof catalog.capabilities> = {};
  for (const c of catalog.capabilities) {
    (byCategory[c.category] ??= []).push(c);
  }

  const canonicalSet = new Set(role.canonical_capabilities);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-md py-xl space-y-xl md:px-lg md:py-2xl md:space-y-2xl">
        <div>
          <Link
            href="/admin/roles"
            className="text-tiny uppercase tracking-widest text-clay hover:underline"
          >
            ← All roles
          </Link>
        </div>

        <header className="flex flex-wrap items-baseline justify-between gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">{role.key}</p>
            <h1 className="mt-sm font-serif text-display text-stone">{role.label}</h1>
            <div className="mt-sm flex flex-wrap items-center gap-sm">
              <span
                className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
                  role.is_built_in ? "bg-mist/30 text-stone" : "bg-sage/15 text-sage"
                }`}
              >
                {role.is_built_in ? "Built-in" : "Custom"}
              </span>
              {drift && (
                <span className="rounded-full px-md py-xs text-tiny uppercase tracking-widest bg-warning/15 text-warning">
                  Diverged from default
                </span>
              )}
            </div>
          </div>
          {!role.is_built_in && (
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete role "${role.label}"? Any users with it must be reassigned first.`))
                  return;
                setBusy(true);
                try {
                  await deleteRole(roleKey);
                  window.location.href = "/admin/roles";
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="text-small text-critical hover:underline"
            >
              Delete role
            </button>
          )}
        </header>

        {error && (
          <div className="whitespace-pre-line rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}
        {success && (
          <div className="flex items-center gap-sm rounded-md border border-success/40 bg-success/10 p-md text-small text-stone">
            <span className="text-success">✓</span>
            <span>{success}</span>
          </div>
        )}

        {/* Action bar */}
        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <h2 className="font-serif text-h2">Default capabilities</h2>
          <p className="mt-xs text-small text-stone/70">
            <strong>Current</strong> (what&apos;s in effect): toggle anything below.
            <strong className="ml-md">Default</strong> is the super-admin-blessed snapshot. Reset
            falls back to default, then factory.
          </p>
          <div className="mt-md flex flex-wrap gap-sm">
            <button
              type="button"
              onClick={() => callAction(() => resetRoleToCanonical(roleKey), "Reset to default.")}
              disabled={busy || !drift}
              title={drift ? "" : "Current already matches default"}
              className="rounded-sm border border-sand px-md py-sm text-small hover:bg-sand/20 disabled:opacity-50"
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={() =>
                callAction(() => saveRoleAsCanonical(roleKey), "Saved as default.")
              }
              disabled={busy || !isSuperAdmin || !drift}
              title={
                !isSuperAdmin
                  ? "Only super admins can update default"
                  : !drift
                    ? "Already matches default"
                    : ""
              }
              className="rounded-sm bg-stone px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
            >
              Save as default {isSuperAdmin ? "" : "(super admin only)"}
            </button>
            {role.is_built_in && (
              <button
                type="button"
                onClick={() =>
                  callAction(
                    () => resetRoleToFactory(roleKey),
                    "Restored to factory defaults (current + default).",
                  )
                }
                disabled={busy || !isSuperAdmin}
                title={isSuperAdmin ? "" : "Only super admins can reset to factory"}
                className="rounded-sm border border-stone px-md py-sm text-small text-stone hover:bg-stone/5 disabled:opacity-50"
              >
                Reset to factory {isSuperAdmin ? "" : "(super admin only)"}
              </button>
            )}
          </div>
        </section>

        {/* Edit form */}
        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <div className="grid gap-md md:grid-cols-2">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Label</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
              />
            </label>
          </div>

          <div className="mt-lg space-y-lg">
            {Object.entries(byCategory).map(([cat, caps]) => (
              <div key={cat}>
                <h3 className="font-mono text-tiny uppercase tracking-widest text-clay">{cat}</h3>
                <ul className="mt-sm divide-y divide-sand/30 rounded-md border border-sand/30 bg-warmWhite">
                  {caps.map((c) => {
                    const isOn = working.has(c.id);
                    const isCanonical = canonicalSet.has(c.id);
                    return (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-start justify-between gap-md p-md"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-small font-medium text-stone">
                            {c.label}
                            {isOn !== isCanonical && (
                              <span className="ml-sm text-tiny uppercase tracking-widest text-warning">
                                changed
                              </span>
                            )}
                          </p>
                          <p className="text-tiny text-stone/60">{c.description}</p>
                          <p className="mt-xs text-tiny text-stone/40 font-mono">
                            Default: {isCanonical ? "on" : "off"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggle(c.id)}
                          aria-pressed={isOn}
                          className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
                            isOn ? "bg-success text-warmWhite" : "bg-stone/10 text-stone/60"
                          }`}
                        >
                          {isOn ? "On" : "Off"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-lg flex items-center justify-between gap-md">
            <p className="text-small text-stone/60">
              {dirty
                ? "Unsaved changes."
                : "Up to date."}
            </p>
            <div className="flex gap-sm">
              <button
                type="button"
                onClick={() => {
                  setWorking(new Set(role.default_capabilities));
                  setLabel(role.label);
                  setDescription(role.description ?? "");
                }}
                disabled={!dirty || busy}
                className="rounded-sm border border-sand px-md py-sm text-small hover:bg-sand/20 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={onApply}
                disabled={!dirty || busy}
                className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Apply"}
              </button>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

export default function RoleDetailPage({ params }: { params: { role_key: string } }) {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.manage_permissions]}>
        <Inner roleKey={params.role_key} />
      </CapabilityGate>
    </AuthGate>
  );
}
