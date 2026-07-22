// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { CAP, has } from "@/lib/capabilities";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { Header } from "@/components/Header";
import {
  adminCreateInvite,
  adminListInvites,
  adminListUsers,
  adminRevokeInvite,
  adminSendPasswordReset,
  adminSetActive,
  adminUpdateRole,
  adminUpdateUser,
  AdminUser,
  ApiError,
  Invite,
  InviteCreated,
  kioskUnlock,
  listRoles,
  rehireUser,
  resetKioskPin,
  restoreUserViewOnly,
  Role,
  RoleDefinition,
  terminateUser,
  updateKioskCreds,
} from "@/lib/api";

const RESTRICTED_INTERNAL_ONLY: Role[] = ["super_admin", "admin"];

function rolesAssignableBy(
  actorRole: Role,
  targetType: "internal" | "external",
  allRoles: RoleDefinition[],
): RoleDefinition[] {
  return allRoles.filter((r) => {
    if (r.key === "super_admin" && actorRole !== "super_admin") return false;
    if (targetType === "external" && RESTRICTED_INTERNAL_ONLY.includes(r.key as Role)) return false;
    return true;
  });
}

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString();
}

function Inner() {
  useDocumentTitle("Users & invites");
  const me = useCurrentUser();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [allRoles, setAllRoles] = useState<RoleDefinition[]>([]);
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Show-terminated toggle — when on, refetch with include_terminated=true
  // so admins can see (and restore/rehire) ex-employees.
  const [showTerminated, setShowTerminated] = useState(false);
  // Client-side status filter over the already-loaded users. "all" (default),
  // "active" (no terminated_at), "terminated" (terminated_at set — covers both
  // fully-terminated and restored-view-only). No extra API call.
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "terminated">("all");
  // Kiosk PIN modal — open when admin clicks "Set" / "Edit" in the Kiosk column.
  const [kioskTarget, setKioskTarget] = useState<AdminUser | null>(null);
  // Expandable rows — the user list shows essential columns inline (no
  // horizontal scroll at desktop width) and reveals role/kiosk/employment/
  // preview controls in an inline detail panel when a row is expanded. On
  // mobile each row is a stacked card; tapping it expands the same panel.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canManageUsers = has(me, CAP.manage_users);

  const roleLabelOf = (key: string): string =>
    allRoles.find((r) => r.key === key)?.label ?? key;

  const refresh = async () => {
    setError(null);
    try {
      const [u, i, r] = await Promise.all([
        adminListUsers(showTerminated),
        adminListInvites(),
        listRoles(),
      ]);
      setUsers(u);
      setInvites(i);
      setAllRoles(r);
    } catch (e) {
      setError(e instanceof ApiError && e.status < 500 ? (e.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTerminated]);
  // Catch invite-accepted state without manual reload — when an external
  // user clicks the accept link the manager wants to see the new active
  // user appear. 90s tick.
  useVisibleInterval(() => {
    void refresh();
  }, 90_000);

  const onInvite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLastAcceptUrl(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const created: InviteCreated = await adminCreateInvite({
        email: String(fd.get("email") || ""),
        full_name: String(fd.get("full_name") || ""),
        role: String(fd.get("role") || "staff") as Role,
        expires_in_days: Number(fd.get("expires") || 30),
      });
      setLastAcceptUrl(created.accept_url);
      form.reset();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.status < 500 ? (e.message || "Request failed.") : "Server error. Please try again.");
    }
  };

  // Apply the client-side status filter. Terminated = terminated_at is set;
  // Active = not terminated. The terminated rows are only present in `users`
  // when the Show-terminated fetch toggle is on, so the "Terminated" view
  // depends on that data already being loaded.
  const visibleUsers = users.filter((u) => {
    if (statusFilter === "active") return !u.terminated_at;
    if (statusFilter === "terminated") return Boolean(u.terminated_at);
    return true;
  });

  // Mirrors the backend's "don't strand the org" guard (users.py change_role):
  // self-demotion off super_admin is only actually blocked when the acting
  // user is the *sole* active super admin. With 2+ active super admins, the
  // acting super admin should be able to edit their own role like any other.
  const otherActiveSuperAdmins = users.filter(
    (u) => u.role === "super_admin" && u.is_active && !u.terminated_at && u.id !== me.id,
  ).length;
  const selfIsSoleActiveSuperAdmin = me.role === "super_admin" && otherActiveSuperAdmins === 0;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-lg py-2xl space-y-2xl">
        <header className="flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">Admin</p>
            <h1 className="mt-sm font-serif text-display text-stone">Users & invites</h1>
          </div>
          <Link
            href="/admin/emergency-contacts"
            className="rounded-sm border border-sand px-md py-sm text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
          >
            Emergency contacts
          </Link>
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <h2 className="font-serif text-h2">Invite a user</h2>
          <p className="text-small text-stone/70 mt-xs">
            External invitees max out at Manager. Admin invites require a super admin.
          </p>
          <form onSubmit={onInvite} className="mt-md grid gap-md md:grid-cols-4">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Email</span>
              <input
                name="email"
                type="email"
                required
                placeholder="email"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Full name</span>
              <input
                name="full_name"
                required
                placeholder="Full name"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Role</span>
              <select
                name="role"
                defaultValue="staff"
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              >
                {/* Invitees are always external — exclude super_admin/admin (no invites for those) */}
                {allRoles
                  .filter((r) => r.key !== "super_admin" && r.key !== "admin")
                  .map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                {me.role === "super_admin" && <option value="admin">Admin</option>}
              </select>
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">
                Invite expires in (days)
              </span>
              <input
                name="expires"
                type="number"
                defaultValue={30}
                min={1}
                max={365}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
              />
              <span className="mt-xs block text-tiny text-stone/50">
                The invite link stops working after this many days (default 30).
              </span>
            </label>
            <div className="md:col-span-4">
              <button
                type="submit"
                className="w-full rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite transition-opacity duration-fast ease-northbound hover:opacity-90 md:w-auto"
              >
                Send invite
              </button>
            </div>
          </form>
          {lastAcceptUrl && (
            <div className="mt-md rounded-sm border border-success/40 bg-success/10 p-md">
              <p className="text-tiny uppercase tracking-widest text-clay">Invite link (copy + send)</p>
              <code className="mt-xs block break-all font-mono text-small text-stone">{lastAcceptUrl}</code>
            </div>
          )}
        </section>

        <section className="rounded-md border border-sand/30 bg-softCream">
          <header className="flex flex-wrap items-center justify-between gap-md px-lg pt-lg">
            <h2 className="font-serif text-h2">Users ({visibleUsers.length})</h2>
            <div className="flex flex-wrap items-center gap-sm">
              {/* Client-side status filter — segmented buttons. Filters the
                  already-loaded list; no API call. */}
              <div
                role="group"
                aria-label="Filter users by status"
                className="flex items-center gap-xs rounded-full border border-sand bg-warmWhite p-xs"
              >
                {([
                  { key: "all", label: "All" },
                  { key: "active", label: "Active" },
                  { key: "terminated", label: "Terminated" },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setStatusFilter(opt.key);
                      // Selecting "Terminated" is meaningless unless the
                      // terminated rows have been fetched — turn that on too.
                      if (opt.key === "terminated") setShowTerminated(true);
                    }}
                    aria-pressed={statusFilter === opt.key}
                    className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest transition-colors ${
                      statusFilter === opt.key
                        ? "bg-stone text-warmWhite"
                        : "text-stone/70 hover:bg-sand/20"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowTerminated((v) => !v)}
                aria-pressed={showTerminated}
                className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest transition-colors ${
                  showTerminated
                    ? "bg-stone text-warmWhite"
                    : "bg-warmWhite text-stone/70 border border-sand hover:bg-sand/20"
                }`}
                title={
                  showTerminated
                    ? "Currently fetching terminated users — click to hide"
                    : "Load terminated users (read-only and rehirable)"
                }
              >
                {showTerminated ? "Hiding none" : "Show terminated"}
              </button>
            </div>
          </header>
          {loading ? (
            <p className="px-lg py-md text-small text-stone/60">Loading…</p>
          ) : visibleUsers.length === 0 ? (
            <p className="mt-md border-t border-sand/30 px-lg py-md text-small text-stone/60">
              {statusFilter === "terminated"
                ? "No terminated users."
                : statusFilter === "active"
                  ? "No active users."
                  : "No users."}
            </p>
          ) : (
            <ul className="mt-md divide-y divide-sand/30 border-t border-sand/30">
              {visibleUsers.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me.id}
                  selfIsSoleActiveSuperAdmin={selfIsSoleActiveSuperAdmin}
                  expanded={expandedId === u.id}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === u.id ? null : u.id))
                  }
                  canManageUsers={canManageUsers}
                  canPreview={me.role === "super_admin"}
                  allRoles={allRoles}
                  assignableRoles={rolesAssignableBy(me.role, u.user_type, allRoles)}
                  actorRole={me.role}
                  onRoleChange={async (role) => {
                    try {
                      await adminUpdateRole(u.id, role);
                      await refresh();
                    } catch (err) {
                      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
                    }
                  }}
                  onNameChange={async (name) => {
                    try {
                      await adminUpdateUser(u.id, { full_name: name });
                      await refresh();
                    } catch (err) {
                      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
                    }
                  }}
                  onToggleActive={async () => {
                    try {
                      await adminSetActive(u.id, !u.is_active);
                      await refresh();
                    } catch (err) {
                      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
                    }
                  }}
                  onKiosk={() => setKioskTarget(u)}
                  onEmployment={async (action) => {
                    try {
                      if (action === "terminate") {
                        if (
                          !confirm(
                            `Terminate ${u.full_name}?\n\n` +
                              `This will:\n` +
                              `  • Block their login\n` +
                              `  • Cancel their future shifts\n` +
                              `  • Cancel pending time-off\n` +
                              `  • Clear their kiosk PIN\n\n` +
                              `Historical records (past shifts, punches, time-off) are kept.\n` +
                              `You can restore them as view-only or rehire them later.`,
                          )
                        )
                          return;
                        await terminateUser(u.id);
                      } else if (action === "restore-view") {
                        if (
                          !confirm(
                            `Restore ${u.full_name} as view-only?\n\n` +
                              `They will be able to log in and see their own historical ` +
                              `records (shifts, hours, time-off) but cannot mutate anything ` +
                              `or appear in scheduler pickers.`,
                          )
                        )
                          return;
                        await restoreUserViewOnly(u.id);
                      } else if (action === "rehire") {
                        if (
                          !confirm(
                            `Rehire ${u.full_name} as a full employee?\n\n` +
                              `This clears their terminated status and restores their ` +
                              `role's normal capabilities. Use this for actual re-employment ` +
                              `— "Restore view-only" is the right choice if they only need ` +
                              `read access to their own records.`,
                          )
                        )
                          return;
                        await rehireUser(u.id);
                      }
                      await refresh();
                    } catch (err) {
                      setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-md border border-sand/30 bg-softCream">
          <header className="flex flex-wrap items-center justify-between gap-md px-lg pt-lg">
            <h2 className="font-serif text-h2">Invites ({invites.length})</h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-full border border-sand bg-warmWhite px-md py-xs text-tiny uppercase tracking-widest text-stone/70 hover:bg-sand/20"
            >
              Refresh
            </button>
          </header>
          {invites.length === 0 ? (
            <p className="px-lg py-md text-small text-stone/60">No invites yet.</p>
          ) : (
            <div className="overflow-x-auto">
            <table className="mt-md w-full min-w-[560px] text-small">
              <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
                <tr>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Invited</Th>
                  <Th>Expires</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const status =
                    i.accepted_at ? "accepted" : i.revoked_at ? "revoked" : new Date(i.expires_at) < new Date() ? "expired" : "open";
                  return (
                    <tr key={i.id} className="border-t border-sand/30">
                      <Td>{i.email}</Td>
                      <Td>{roleLabelOf(i.role)}</Td>
                      <Td>
                        <span className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
                          status === "accepted"
                            ? "bg-success/15 text-success"
                            : status === "open"
                              ? "bg-warning/15 text-warning"
                              : "bg-stone/10 text-stone/50"
                        }`}>
                          {status}
                        </span>
                      </Td>
                      <Td>{fmt(i.created_at)}</Td>
                      <Td>{fmt(i.expires_at)}</Td>
                      <Td>
                        {status === "open" && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await adminRevokeInvite(i.id);
                                await refresh();
                              } catch (err) {
                                setError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
                              }
                            }}
                            className="text-tiny uppercase tracking-widest text-critical hover:underline"
                          >
                            Revoke
                          </button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </section>
      </main>

      {kioskTarget && (
        <KioskCredsModal
          user={kioskTarget}
          onClose={() => setKioskTarget(null)}
          onSaved={async () => {
            setKioskTarget(null);
            await refresh();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </>
  );
}

function KioskCredsModal({
  user,
  onClose,
  onSaved,
  onError,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [phone, setPhone] = useState(user.phone_e164 ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "unlock" | "reset" | null>(null);
  // Surface the freshly-reset PIN so the admin can copy/paste it if email
  // delivery isn't configured — the backend always returns it.
  const [resetResult, setResetResult] = useState<{ pin: string; emailed: boolean } | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy("save");
    try {
      // Send phone always; only send PIN if the admin typed one (avoids
      // wiping an existing PIN when only the phone changes).
      await updateKioskCreds(user.id, {
        phone: phone.trim() || null,
        pin: pin.length >= 4 ? pin : null,
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onClear = async () => {
    if (!confirm(`Clear ${user.full_name}'s PIN? They won't be able to clock in via kiosk until you set a new one.`)) return;
    setBusy("clear");
    try {
      await updateKioskCreds(user.id, { clear_pin: true });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onUnlock = async () => {
    setBusy("unlock");
    try {
      await kioskUnlock(user.id);
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onResetByEmail = async () => {
    if (!confirm(
      `Reset ${user.full_name}'s PIN? A new random PIN will be generated and ` +
      `emailed to ${user.email}. The current PIN will stop working immediately.`
    )) return;
    setBusy("reset");
    setResetResult(null);
    try {
      const r = await resetKioskPin(user.id);
      setResetResult({ pin: r.new_pin, emailed: r.email_sent });
    } catch (err) {
      onError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone/40 p-md"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-md border border-sand/30 bg-warmWhite p-lg shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-md">
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">Kiosk clock-in</p>
          <h3 className="mt-xs font-serif text-h2 text-stone">{user.full_name}</h3>
          <p className="text-small text-stone/60">{user.email}</p>
        </header>

        <form onSubmit={onSubmit} className="space-y-md">
          <label className="block text-small">
            <span className="text-tiny uppercase tracking-widest text-clay">Phone number</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (416) 555-1234"
              className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
            />
            <span className="mt-xs block text-tiny text-stone/50">
              Used as the staffer&apos;s identifier on the kiosk page. Country code optional but recommended.
            </span>
          </label>

          <label className="block text-small">
            <span className="text-tiny uppercase tracking-widest text-clay">
              {user.has_pin ? "New PIN (leave blank to keep current)" : "PIN"}
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d*"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder={user.has_pin ? "(unchanged)" : "4–6 digits"}
              minLength={user.has_pin ? 0 : 4}
              maxLength={6}
              className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono tracking-[0.4em] focus:outline-none focus:border-terracotta"
            />
            <span className="mt-xs block text-tiny text-stone/50">
              Numeric, 4–6 digits. Tell the staffer in person — we don&apos;t email PINs.
            </span>
          </label>

          <div className="flex flex-wrap gap-sm pt-sm">
            <button
              type="submit"
              disabled={busy !== null}
              className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy !== null}
              className="rounded-sm border border-sand bg-warmWhite px-md py-sm text-small text-stone hover:bg-sand/20 disabled:opacity-50"
            >
              Cancel
            </button>
            {user.has_pin && (
              <button
                type="button"
                onClick={onClear}
                disabled={busy !== null}
                className="ml-auto rounded-sm border border-critical/40 bg-critical/10 px-md py-sm text-small text-critical hover:bg-critical/20 disabled:opacity-50"
              >
                Clear PIN
              </button>
            )}
          </div>

          <div className="border-t border-sand/30 pt-md">
            <p className="text-tiny uppercase tracking-widest text-clay">Locked out?</p>
            <button
              type="button"
              onClick={onUnlock}
              disabled={busy !== null}
              className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm text-small text-stone hover:bg-sand/20 disabled:opacity-50"
            >
              {busy === "unlock" ? "Working…" : "Clear lockout"}
            </button>
            <p className="mt-xs text-tiny text-stone/50">
              Resets failed-attempts counter so they can try their PIN again immediately.
            </p>
          </div>

          <div className="border-t border-sand/30 pt-md">
            <p className="text-tiny uppercase tracking-widest text-clay">
              Forgot PIN — generate + email a new one
            </p>
            <button
              type="button"
              onClick={onResetByEmail}
              disabled={busy !== null}
              className="mt-xs rounded-sm border border-terracotta/40 bg-terracotta/5 px-md py-sm text-small text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
            >
              {busy === "reset" ? "Generating…" : "Reset PIN (email)"}
            </button>
            <p className="mt-xs text-tiny text-stone/50">
              Generates a random 4-digit PIN, emails it to the staff member, and
              invalidates the current one immediately.
            </p>
            {resetResult && (
              <div className="mt-sm rounded-sm border border-success/40 bg-success/10 p-md text-small">
                <p className="font-mono text-tiny uppercase tracking-widest text-clay">
                  New PIN (visible once — save now if email isn&apos;t configured)
                </p>
                <p className="mt-xs font-mono text-h2 tracking-[0.4em] text-stone">
                  {resetResult.pin}
                </p>
                <p className="mt-xs text-tiny text-stone/60">
                  {resetResult.emailed
                    ? `Email sent to ${user.email}.`
                    : `Email NOT sent — Resend may not be configured. Pass the PIN to ${user.full_name} directly.`}
                </p>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// A single user as an expandable row. Essential identity (name, email, role,
// status) shows in the always-visible summary; the rest (role editor, active
// toggle, kiosk, employment, preview) lives in the inline detail panel that
// opens on click. The summary is a stacked card on mobile and a horizontal row
// at md+, so there's no horizontal scroll at any width.
function UserRow({
  user: u,
  isSelf,
  selfIsSoleActiveSuperAdmin,
  expanded,
  onToggle,
  canManageUsers,
  canPreview,
  allRoles,
  assignableRoles,
  actorRole,
  onRoleChange,
  onNameChange,
  onToggleActive,
  onKiosk,
  onEmployment,
}: {
  user: AdminUser;
  isSelf: boolean;
  selfIsSoleActiveSuperAdmin: boolean;
  expanded: boolean;
  onToggle: () => void;
  canManageUsers: boolean;
  canPreview: boolean;
  allRoles: RoleDefinition[];
  assignableRoles: RoleDefinition[];
  actorRole: Role;
  onRoleChange: (role: Role) => void | Promise<void>;
  onNameChange: (name: string) => void | Promise<void>;
  onToggleActive: () => void | Promise<void>;
  onKiosk: () => void;
  onEmployment: (
    action: "terminate" | "restore-view" | "rehire",
  ) => void | Promise<void>;
}) {
  // Determine if the actor can change this user's role at all.
  // Hard blocks (both enforced by the backend too):
  //  - a non-super_admin actor cannot touch a super_admin's role
  //  - a super_admin cannot demote themselves off super_admin while they're
  //    the sole active super_admin (would strand the org with no one able
  //    to grant/revoke super_admin). With 2+ active super admins this no
  //    longer applies, so self-editing is allowed like any other row.
  const targetIsSuperAdmin = u.role === "super_admin";
  const actorIsSuperAdmin = actorRole === "super_admin";
  const roleSelectDisabled =
    (targetIsSuperAdmin && !actorIsSuperAdmin) ||
    (isSelf && targetIsSuperAdmin && selfIsSoleActiveSuperAdmin);

  // Always show the current role as a display option so the select reflects
  // reality even when the role isn't in assignableRoles.
  const currentRoleInAssignable = assignableRoles.some(r => r.key === u.role);
  const currentRoleLabel = allRoles.find(r => r.key === u.role)?.label ?? u.role;
  const roleLabel = currentRoleLabel;
  const detailId = `user-detail-${u.id}`;

  // Compact status pill shown in the summary (read-only here; the actionable
  // toggle lives in the detail panel).
  const statusPill = u.terminated_at ? (
    <span className="rounded-full bg-stone/10 px-md py-xs text-tiny uppercase tracking-widest text-stone/60">
      {u.is_active
        ? `View-only · ${fmtDate(u.terminated_at)}`
        : `Terminated · ${fmtDate(u.terminated_at)}`}
    </span>
  ) : (
    <span
      className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
        u.is_active ? "bg-success/15 text-success" : "bg-critical/15 text-critical"
      }`}
    >
      {u.is_active ? "Active" : "Inactive"}
    </span>
  );

  return (
    <li>
      {/* Summary — click anywhere to expand. Stacks on mobile, row at md+. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="flex w-full flex-col gap-xs px-lg py-md text-left transition-colors hover:bg-sand/10 md:flex-row md:items-center md:gap-md"
      >
        <span
          className={`shrink-0 text-clay transition-transform duration-fast ease-northbound ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ›
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-stone">{u.full_name}</span>
          <span className="block truncate text-small text-stone/60">{u.email}</span>
        </span>
        <span className="flex flex-wrap items-center gap-sm md:justify-end">
          <span className="rounded-full bg-mist/30 px-md py-xs text-tiny uppercase tracking-widest text-stone">
            {roleLabel}
          </span>
          <span className="capitalize text-tiny uppercase tracking-widest text-clay">
            {u.user_type}
          </span>
          {statusPill}
        </span>
      </button>

      {/* Detail panel — all per-user actions, relocated from the old wide
          columns. Shown only when this row is expanded. */}
      {expanded && (
        <div
          id={detailId}
          className="grid gap-lg bg-warmWhite px-lg py-md md:grid-cols-2"
        >
          <div className="space-y-xs">
            <p className="text-tiny uppercase tracking-widest text-clay">Role</p>
            <select
              value={u.role}
              disabled={roleSelectDisabled}
              onChange={(e) => void onRoleChange(e.target.value as Role)}
              className="w-full rounded-sm border border-sand bg-warmWhite px-md py-sm text-small disabled:opacity-50"
            >
              {!currentRoleInAssignable && (
                <option value={u.role}>{currentRoleLabel}</option>
              )}
              {assignableRoles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-xs">
            <p className="text-tiny uppercase tracking-widest text-clay">Status</p>
            {u.terminated_at ? (
              <span
                className="inline-block rounded-full bg-stone/10 px-md py-sm text-tiny uppercase tracking-widest text-stone/60"
                title={`Terminated ${fmtDate(u.terminated_at)}${
                  u.is_active ? " · restored view-only" : ""
                }`}
              >
                {u.is_active
                  ? `View-only · ${fmtDate(u.terminated_at)}`
                  : `Terminated · ${fmtDate(u.terminated_at)}`}
              </span>
            ) : (
              <button
                type="button"
                disabled={isSelf}
                onClick={() => void onToggleActive()}
                className={`rounded-full px-md py-sm text-tiny uppercase tracking-widest disabled:opacity-50 ${
                  u.is_active
                    ? "bg-success/15 text-success"
                    : "bg-critical/15 text-critical"
                }`}
              >
                {u.is_active ? "Active — click to deactivate" : "Inactive — click to activate"}
              </button>
            )}
          </div>

          <div className="space-y-xs">
            <p className="text-tiny uppercase tracking-widest text-clay">Kiosk clock-in</p>
            <button
              type="button"
              onClick={onKiosk}
              className={`rounded-sm border px-md py-sm text-tiny uppercase tracking-widest transition-colors ${
                u.has_pin
                  ? "border-success/40 bg-success/10 text-success hover:bg-success/20"
                  : "border-sand bg-warmWhite text-stone/60 hover:bg-sand/20"
              }`}
              title={
                u.has_pin
                  ? `PIN set · phone ${u.phone_e164 ?? "(none)"} — click to edit`
                  : "Click to set up kiosk clock-in for this user"
              }
            >
              {u.has_pin ? "PIN set — edit" : "Set PIN"}
            </button>
          </div>


          {canManageUsers && (
            <NameEditSection
              userId={u.id}
              initialName={u.full_name}
              onSaved={onNameChange}
            />
          )}

          {canManageUsers && (
            <div className="space-y-xs">
              <p className="text-tiny uppercase tracking-widest text-clay">Employment</p>
              <EmploymentActions
                user={u}
                disabled={isSelf}
                onAction={onEmployment}
              />
            </div>
          )}

          {canManageUsers && !isSelf && (
            <PasswordResetButton userId={u.id} />
          )}

          <div className="space-y-xs">
            <p className="text-tiny uppercase tracking-widest text-clay">Profile</p>
            <div className="flex flex-wrap gap-sm">
              <Link
                href={`/admin/staff/${u.id}`}
                className="rounded-sm border border-sand px-md py-sm text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
              >
                Open profile
              </Link>
              <Link
                href={`/admin/users/${u.id}`}
                className="rounded-sm border border-sand px-md py-sm text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
              >
                Emergency contact
              </Link>
              {canPreview && (
                <Link
                  href={`/admin/users/${u.id}/preview`}
                  className="rounded-sm border border-sand px-md py-sm text-tiny uppercase tracking-widest text-stone hover:bg-sand/20"
                >
                  View as
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-lg py-sm text-left font-medium">{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-lg py-sm align-middle ${className}`}>{children}</td>;
}

function EmploymentActions({
  user,
  disabled,
  onAction,
}: {
  user: AdminUser;
  disabled: boolean;
  onAction: (
    action: "terminate" | "restore-view" | "rehire",
  ) => void | Promise<void>;
}) {
  // Three states determine which buttons appear:
  //   Employed (no terminated_at) -> "Terminate"
  //   Terminated, not active      -> "Restore view-only" + "Rehire"
  //   Restored view-only          -> "Rehire" + "Terminate" (re-block login)
  if (!user.terminated_at) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAction("terminate")}
        className="rounded-sm border border-critical/40 px-md py-xs text-tiny uppercase tracking-widest text-critical hover:bg-critical/10 disabled:opacity-40"
      >
        Terminate
      </button>
    );
  }
  if (!user.is_active) {
    return (
      <div className="flex flex-wrap gap-xs">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAction("restore-view")}
          className="rounded-sm border border-sand px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20 disabled:opacity-40"
        >
          Restore view-only
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAction("rehire")}
          className="rounded-sm border border-success/40 px-md py-xs text-tiny uppercase tracking-widest text-success hover:bg-success/10 disabled:opacity-40"
        >
          Rehire
        </button>
      </div>
    );
  }
  // is_active + terminated_at -> restored view-only
  return (
    <div className="flex flex-wrap gap-xs">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAction("rehire")}
        className="rounded-sm border border-success/40 px-md py-xs text-tiny uppercase tracking-widest text-success hover:bg-success/10 disabled:opacity-40"
      >
        Rehire
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAction("terminate")}
        className="rounded-sm border border-critical/40 px-md py-xs text-tiny uppercase tracking-widest text-critical hover:bg-critical/10 disabled:opacity-40"
      >
        Re-block
      </button>
    </div>
  );
}

function NameEditSection({
  userId,
  initialName,
  onSaved,
}: {
  userId: string;
  initialName: string;
  onSaved: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isDirty = name.trim() !== initialName && name.trim().length > 0;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || !isDirty) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      setSaved(true);
      await onSaved(trimmed);
    } catch (err) {
      setSaveError(err instanceof ApiError && err.status < 500 ? (err.message || "Request failed.") : "Server error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-xs">
      <p className="text-tiny uppercase tracking-widest text-clay">Name</p>
      <div className="flex gap-sm">
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          className="min-w-0 flex-1 rounded-sm border border-sand bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
        />
        <button
          type="button"
          disabled={busy || !isDirty}
          onClick={() => void handleSave()}
          className="shrink-0 rounded-sm border border-sand bg-warmWhite px-md py-sm text-tiny uppercase tracking-widest text-stone hover:bg-sand/20 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {saveError && <p className="text-tiny text-critical">{saveError}</p>}
      {saved && <p className="text-tiny text-success">Name updated.</p>}
    </div>
  );
}

function PasswordResetButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [resetUrl, setResetUrl] = useState<string | null>(null);

  async function handleClick() {
    setState("sending");
    try {
      const res = await adminSendPasswordReset(userId);
      setResetUrl(res.email_sent ? null : (res.reset_url ?? null));
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="space-y-xs">
      <p className="text-tiny uppercase tracking-widest text-clay">Password reset</p>
      {state === "done" ? (
        <div className="space-y-xs">
          <p className="text-tiny text-success">
            {resetUrl ? "Email failed — copy link below:" : "Reset email sent."}
          </p>
          {resetUrl && (
            <input
              readOnly
              value={resetUrl}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="w-full rounded-sm border border-sand bg-warmWhite px-md py-xs text-tiny text-stone"
            />
          )}
        </div>
      ) : state === "error" ? (
        <p className="text-tiny text-critical">Failed. Try again.</p>
      ) : (
        <button
          type="button"
          disabled={state === "sending"}
          onClick={() => void handleClick()}
          className="rounded-sm border border-sand px-md py-xs text-tiny uppercase tracking-widest text-stone hover:bg-sand/20 disabled:opacity-50"
        >
          {state === "sending" ? "Sending…" : "Send reset email"}
        </button>
      )}
    </div>
  );
}

export default function AdminUsersPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_users, CAP.manage_users, CAP.manage_invites]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
