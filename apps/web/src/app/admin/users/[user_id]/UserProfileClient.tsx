// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { Header } from "@/components/Header";
import {
  adminListUsers,
  AdminUser,
  ApiError,
  EmergencyContactData,
  updateEmergencyContact,
} from "@/lib/api";
import { CAP, has } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

function EmergencyContactCard({
  user,
  canEdit,
  onSaved,
}: {
  user: AdminUser;
  canEdit: boolean;
  onSaved: (updated: AdminUser) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ecName, setEcName] = useState(user.ec_name ?? "");
  const [ecRel, setEcRel] = useState(user.ec_relationship ?? "");
  const [ecPhone, setEcPhone] = useState(user.ec_phone ?? "");
  const [ecNotes, setEcNotes] = useState(user.ec_notes ?? "");

  const hasAny = user.ec_name || user.ec_relationship || user.ec_phone || user.ec_notes;

  const onEdit = () => {
    setEcName(user.ec_name ?? "");
    setEcRel(user.ec_relationship ?? "");
    setEcPhone(user.ec_phone ?? "");
    setEcNotes(user.ec_notes ?? "");
    setError(null);
    setEditing(true);
  };

  const onCancel = () => {
    setEditing(false);
    setError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data: EmergencyContactData = {
        ec_name: ecName.trim() || null,
        ec_relationship: ecRel.trim() || null,
        ec_phone: ecPhone.trim() || null,
        ec_notes: ecNotes.trim() || null,
      };
      const updated = await updateEmergencyContact(user.id, data);
      onSaved(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-md border border-sand/30 bg-softCream p-lg space-y-md">
      <div className="flex items-baseline justify-between gap-md">
        <h2 className="font-serif text-h2 text-stone">Emergency Contact</h2>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={onEdit}
            className="rounded-sm border border-sand px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
          >
            {hasAny ? "Edit" : "Add"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
          {error}
        </div>
      )}

      {editing ? (
        <form onSubmit={onSubmit} className="space-y-md">
          <div className="grid gap-md md:grid-cols-2">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Name</span>
              <input
                value={ecName}
                onChange={(e) => setEcName(e.target.value)}
                maxLength={255}
                placeholder="Full name"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Relationship</span>
              <input
                value={ecRel}
                onChange={(e) => setEcRel(e.target.value)}
                maxLength={128}
                placeholder="e.g. Spouse, Parent"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Phone</span>
              <input
                value={ecPhone}
                onChange={(e) => setEcPhone(e.target.value)}
                maxLength={32}
                placeholder="+1 416 555 0100"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small font-mono focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Notes</span>
              <input
                value={ecNotes}
                onChange={(e) => setEcNotes(e.target.value)}
                placeholder="Any additional notes"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
            </label>
          </div>
          <div className="flex gap-sm">
            <button
              type="submit"
              disabled={saving}
              className="rounded-sm bg-terracotta px-lg py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-sm border border-sand px-lg py-sm text-small text-stone hover:bg-sand/20"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : hasAny ? (
        <dl className="grid gap-sm md:grid-cols-2 text-small">
          {user.ec_name && (
            <div>
              <dt className="text-tiny uppercase tracking-widest text-clay">Name</dt>
              <dd className="mt-xs text-stone">{user.ec_name}</dd>
            </div>
          )}
          {user.ec_relationship && (
            <div>
              <dt className="text-tiny uppercase tracking-widest text-clay">Relationship</dt>
              <dd className="mt-xs text-stone">{user.ec_relationship}</dd>
            </div>
          )}
          {user.ec_phone && (
            <div>
              <dt className="text-tiny uppercase tracking-widest text-clay">Phone</dt>
              <dd className="mt-xs font-mono text-stone">
                <a href={`tel:${user.ec_phone}`} className="hover:text-terracotta">
                  {user.ec_phone}
                </a>
              </dd>
            </div>
          )}
          {user.ec_notes && (
            <div className="md:col-span-2">
              <dt className="text-tiny uppercase tracking-widest text-clay">Notes</dt>
              <dd className="mt-xs text-stone/80">{user.ec_notes}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-small text-stone/50">No emergency contact on file.</p>
      )}
    </section>
  );
}

function Inner() {
  const { user_id } = useParams<{ user_id: string }>();
  const me = useCurrentUser();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = has(me, CAP.manage_users);

  useDocumentTitle(user ? `${user.full_name} — Profile` : "User profile");

  useEffect(() => {
    adminListUsers(true)
      .then((list) => {
        const found = list.find((u) => u.id === user_id);
        if (found) setUser(found);
        else setError("User not found.");
      })
      .catch(() => setError("Failed to load user."));
  }, [user_id]);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-md py-xl space-y-xl md:px-lg md:py-2xl">
        <header>
          <Link
            href="/admin/users"
            className="font-mono text-tiny uppercase tracking-widest text-clay hover:text-terracotta"
          >
            ← Users
          </Link>
          {user && (
            <>
              <h1 className="mt-sm font-serif text-display text-stone">{user.full_name}</h1>
              <p className="mt-xs text-small text-stone/60">{user.email}</p>
              <div className="mt-sm flex flex-wrap gap-sm">
                <span className="rounded-full bg-sand/40 px-md py-xs text-tiny uppercase tracking-widest text-stone">
                  {user.role}
                </span>
                {user.is_terminated && (
                  <span className="rounded-full bg-critical/15 px-md py-xs text-tiny uppercase tracking-widest text-critical">
                    Terminated
                  </span>
                )}
                {!user.is_active && !user.is_terminated && (
                  <span className="rounded-full bg-warning/15 px-md py-xs text-tiny uppercase tracking-widest text-warning">
                    Inactive
                  </span>
                )}
              </div>
            </>
          )}
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        {!user && !error && (
          <p className="text-small text-stone/60">Loading…</p>
        )}

        {user && (
          <EmergencyContactCard
            user={user}
            canEdit={canEdit}
            onSaved={(updated) => setUser(updated)}
          />
        )}
      </main>
    </>
  );
}

export default function UserProfilePage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_users]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
