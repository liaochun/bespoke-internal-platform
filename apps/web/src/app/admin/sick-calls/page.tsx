// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useState } from "react";

import { AuthGate } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { Header } from "@/components/Header";
import {
  AdminUser,
  adminListUsers,
  adminMarkShiftSick,
  cancelClaimOffer,
  ClaimOffer,
  dismissSickCall,
  getClaimOffer,
  getOfferHistory,
  getSubLeaderboard,
  listSickCalls,
  listStaffUpcomingShifts,
  openClaimOffer,
  Shift,
  SickCall,
  SubHistoryEntry,
  SubLeaderboardEntry,
} from "@/lib/api";
import { CAP } from "@/lib/capabilities";
import {
  fmtDateTimeShort,
  fmtDuration,
  fmtRelativeDay,
  fmtTime,
} from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useVisibleInterval } from "@/lib/useVisibleInterval";

function statusPill(status: string | null): string {
  if (status === "pending_review") return "Pending review";
  if (status === "filling") return "Filling";
  if (status === "filled") return "Filled";
  if (status === "dismissed") return "Dismissed";
  return "—";
}

// ─── Call In Sick For Employee form ────────────────────────────────────────

function CallInSickForm({ onSuccess }: { onSuccess: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [upcomingShifts, setUpcomingShifts] = useState<Shift[] | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load active staff once on mount
  useEffect(() => {
    void adminListUsers().then((all) =>
      setUsers(all.filter((u) => u.is_active && !u.is_terminated)),
    );
  }, []);

  // When staff selection changes, fetch their upcoming shifts
  useEffect(() => {
    if (!selectedUserId) {
      setUpcomingShifts(null);
      setSelectedShiftId("");
      return;
    }
    setUpcomingShifts(null);
    setSelectedShiftId("");
    setError(null);
    void listStaffUpcomingShifts(selectedUserId)
      .then(setUpcomingShifts)
      .catch((e) => setError((e as Error).message));
  }, [selectedUserId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedShiftId) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await adminMarkShiftSick(selectedShiftId, note || undefined);
      setSuccess("Sick call logged successfully.");
      setSelectedUserId("");
      setUpcomingShifts(null);
      setSelectedShiftId("");
      setNote("");
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sortedUsers = (users ?? []).sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-md">
      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 p-sm text-small text-stone">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md border border-moss/40 bg-moss/10 p-sm text-small text-stone">
          {success}
        </div>
      )}

      {/* Step 1 — pick employee */}
      <div>
        <label className="mb-xs block text-tiny font-medium uppercase tracking-widest text-stone/60">
          Employee
        </label>
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="w-full rounded-sm border border-sand bg-warmWhite px-md py-xs text-small text-stone"
          required
        >
          <option value="">Select a staff member…</option>
          {sortedUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </select>
      </div>

      {/* Step 2 — pick shift (only shown once an employee is selected) */}
      {selectedUserId && (
        <div>
          <label className="mb-xs block text-tiny font-medium uppercase tracking-widest text-stone/60">
            Shift to cancel
          </label>
          {upcomingShifts === null ? (
            <p className="text-small text-stone/50">Loading shifts…</p>
          ) : upcomingShifts.length === 0 ? (
            <p className="text-small text-stone/50">
              No scheduled shifts found in the past 7 days or upcoming for this employee.
            </p>
          ) : (
            <select
              value={selectedShiftId}
              onChange={(e) => setSelectedShiftId(e.target.value)}
              className="w-full rounded-sm border border-sand bg-warmWhite px-md py-xs text-small text-stone"
              required
            >
              <option value="">Select a shift…</option>
              {upcomingShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {fmtRelativeDay(s.starts_at)} · {fmtTime(s.starts_at)} →{" "}
                  {fmtTime(s.ends_at)}
                  {s.location ? ` — ${s.location}` : ""}
                  {s.role_label ? ` (${s.role_label})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Step 3 — reason/note */}
      {selectedShiftId && (
        <div>
          <label className="mb-xs block text-tiny font-medium uppercase tracking-widest text-stone/60">
            Reason / note{" "}
            <span className="normal-case font-normal text-stone/40">(optional)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="e.g. Stomach bug, doctor's note to follow"
            className="w-full rounded-sm border border-sand bg-warmWhite px-md py-xs text-small text-stone placeholder:text-stone/30 resize-none"
          />
        </div>
      )}

      {selectedShiftId && (
        <button
          type="submit"
          disabled={busy || !selectedShiftId}
          className="rounded-sm bg-terracotta px-md py-xs text-small font-medium text-warmWhite disabled:opacity-50"
        >
          {busy ? "Logging…" : "Log sick call"}
        </button>
      )}
    </form>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

type DatePreset = "7d" | "30d" | "90d" | "all";
type SortBy = "date_desc" | "date_asc" | "staff_name";

function getFromDate(preset: DatePreset): string | undefined {
  if (preset === "all") return undefined;
  const d = new Date();
  if (preset === "7d") d.setDate(d.getDate() - 7);
  else if (preset === "30d") d.setDate(d.getDate() - 30);
  else if (preset === "90d") d.setDate(d.getDate() - 90);
  return d.toISOString();
}

function Inner() {
  useDocumentTitle("Sick calls");
  const [rows, setRows] = useState<SickCall[] | null>(null);
  const [offerCache, setOfferCache] = useState<Record<string, ClaimOffer | null>>({});
  const [staffFilter, setStaffFilter] = useState<string>("");
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [sortBy, setSortBy] = useState<SortBy>("date_desc");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (preset: DatePreset = datePreset, sort: SortBy = sortBy) => {
    try {
      const fresh = await listSickCalls({
        from_date: getFromDate(preset),
        sort_by: sort,
      });
      setRows(fresh);
      // For shifts currently being filled, pull the latest offer + candidate list.
      const fillingShifts = fresh.filter((r) => r.sick_call_status === "filling");
      const next: Record<string, ClaimOffer | null> = {};
      await Promise.all(
        fillingShifts.map(async (r) => {
          try {
            next[r.id] = await getClaimOffer(r.id);
          } catch {
            next[r.id] = null;
          }
        }),
      );
      setOfferCache((prev) => ({ ...prev, ...next }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load(datePreset, sortBy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datePreset, sortBy]);
  useVisibleInterval(() => load(datePreset, sortBy), 30_000);

  const onFindSub = async (shiftId: string) => {
    setBusy(shiftId);
    setError(null);
    try {
      const result = await openClaimOffer(shiftId);
      setOfferCache((prev) => ({ ...prev, [shiftId]: result.offer }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onDismiss = async (shiftId: string) => {
    const note = window.prompt("Optional note for the staff member?") ?? undefined;
    setBusy(shiftId);
    setError(null);
    try {
      await dismissSickCall(shiftId, note || undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onCancelOffer = async (shiftId: string) => {
    if (!window.confirm("Cancel this open offer? Candidates will no longer be able to claim.")) {
      return;
    }
    setBusy(shiftId);
    setError(null);
    try {
      await cancelClaimOffer(shiftId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const staffNames = Array.from(new Set((rows ?? []).map((r) => r.user.full_name))).sort();
  const filtered = (rows ?? []).filter((r) => !staffFilter || r.user.full_name === staffFilter);
  const pending = filtered.filter((r) => r.sick_call_status === "pending_review");
  const filling = filtered.filter((r) => r.sick_call_status === "filling");
  const recent = filtered.filter(
    (r) => r.sick_call_status === "filled" || r.sick_call_status === "dismissed",
  );

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-lg py-2xl">
        <header className="mb-lg">
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">Workforce</p>
          <h1 className="mt-sm font-serif text-display text-stone">Sick calls</h1>
          <p className="mt-md text-small text-stone/70">
            Triage incoming sick calls. Dismiss to leave the shift cancelled, or "find a sub" to
            email eligible staff a tokenized claim link — first to claim wins.
          </p>
        </header>

        {/* ── Call In Sick For Employee ── */}
        <Section title="Call in sick for employee">
          <div className="rounded-sm border border-sand/40 bg-warmWhite p-md">
            <p className="mb-md text-small text-stone/60">
              Use this form to call in sick on behalf of a staff member. The sick call will be
              logged under your account and added to the queue below.
            </p>
            <CallInSickForm onSuccess={() => void load(datePreset, sortBy)} />
          </div>
        </Section>

        {/* ── Filters ── */}
        <div className="mb-lg space-y-sm">
          {/* Date scope */}
          <div className="flex flex-wrap items-center gap-sm">
            <span className="text-tiny font-medium uppercase tracking-widest text-stone/60">
              Scope
            </span>
            {(["7d", "30d", "90d", "all"] as DatePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setDatePreset(p)}
                className={`rounded-sm border px-md py-xs text-small ${
                  datePreset === p
                    ? "border-terracotta bg-terracotta/10 text-terracotta font-medium"
                    : "border-sand bg-warmWhite text-stone/60 hover:text-stone"
                }`}
              >
                {p === "7d" ? "Last 7 days" : p === "30d" ? "Last 30 days" : p === "90d" ? "Last 90 days" : "All time"}
              </button>
            ))}
          </div>

          {/* Staff + sort */}
          <div className="flex flex-wrap items-center gap-sm">
            <span className="text-tiny font-medium uppercase tracking-widest text-stone/60">
              Staff
            </span>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="rounded-sm border border-sand bg-warmWhite px-md py-xs text-small text-stone"
            >
              <option value="">All staff</option>
              {staffNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {staffFilter && (
              <button
                type="button"
                onClick={() => setStaffFilter("")}
                className="text-tiny text-stone/50 underline hover:text-stone"
              >
                Clear
              </button>
            )}
            <span className="ml-auto text-tiny font-medium uppercase tracking-widest text-stone/60">
              Sort
            </span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="rounded-sm border border-sand bg-warmWhite px-md py-xs text-small text-stone"
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="staff_name">Staff name</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="mb-lg rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        <Section title={`Pending review (${pending.length})`}>
          {pending.length === 0 ? (
            <EmptyHint text="No pending sick calls." />
          ) : (
            <ul className="space-y-md">
              {pending.map((r) => (
                <li key={r.id} className="rounded-sm border border-sand/30 bg-warmWhite p-md">
                  <div className="flex flex-wrap items-start justify-between gap-md">
                    <div>
                      <p className="font-medium text-body text-stone">
                        {r.user.full_name} —{" "}
                        <span className="font-mono">
                          {fmtRelativeDay(r.starts_at)} · {fmtTime(r.starts_at)} →{" "}
                          {fmtTime(r.ends_at)}
                        </span>
                      </p>
                      <p className="mt-xs text-tiny text-stone/60">
                        {r.location}
                        {r.role_label ? ` · ${r.role_label}` : ""} ·{" "}
                        {fmtDuration(r.starts_at, r.ends_at)} · called in{" "}
                        {fmtDateTimeShort(r.sick_called_at ?? r.created_at)}
                        {r.called_in_by
                          ? ` · logged by ${r.called_in_by.full_name}`
                          : ""}
                      </p>
                      {r.sick_call_note && (
                        <p className="mt-sm text-small text-stone/80">"{r.sick_call_note}"</p>
                      )}
                    </div>
                    <div className="flex gap-sm">
                      <button
                        type="button"
                        onClick={() => void onFindSub(r.id)}
                        disabled={busy === r.id}
                        className="rounded-sm bg-terracotta px-md py-xs text-small font-medium text-warmWhite disabled:opacity-50"
                      >
                        Find a sub
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDismiss(r.id)}
                        disabled={busy === r.id}
                        className="rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20 disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Filling (${filling.length})`}>
          {filling.length === 0 ? (
            <EmptyHint text="No open offers." />
          ) : (
            <ul className="space-y-md">
              {filling.map((r) => {
                const offer = offerCache[r.id];
                return (
                  <li key={r.id} className="rounded-sm border border-sand/30 bg-warmWhite p-md">
                    <div className="flex flex-wrap items-start justify-between gap-md">
                      <div>
                        <p className="font-medium text-body text-stone">
                          {r.user.full_name} —{" "}
                          <span className="font-mono">
                            {fmtRelativeDay(r.starts_at)} · {fmtTime(r.starts_at)} →{" "}
                            {fmtTime(r.ends_at)}
                          </span>
                        </p>
                        <p className="mt-xs text-tiny text-stone/60">
                          {r.location}
                          {r.role_label ? ` · ${r.role_label}` : ""} ·{" "}
                          {offer ? `${offer.candidates.length} candidates emailed` : "Loading…"} ·
                          {offer ? ` expires ${fmtDateTimeShort(offer.expires_at)}` : ""}
                          {r.called_in_by
                            ? ` · logged by ${r.called_in_by.full_name}`
                            : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void onCancelOffer(r.id)}
                        disabled={busy === r.id}
                        className="rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20 disabled:opacity-50"
                      >
                        Cancel offer
                      </button>
                    </div>
                    {offer && offer.candidates.length > 0 && (
                      <ul className="mt-md grid grid-cols-1 gap-xs text-tiny text-stone/70 sm:grid-cols-2">
                        {offer.candidates.map((c) => (
                          <li key={c.id} className="flex items-center justify-between gap-md">
                            <span>{c.user.full_name}</span>
                            <span className="font-mono uppercase tracking-widest text-clay">
                              {c.notified_filled_at ? "notified" : "pending"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={`Historic sick calls (${recent.length})`} subtle>
          {recent.length === 0 ? (
            <EmptyHint text="No closed sick calls yet." />
          ) : (
            <ul className="space-y-xs">
              {recent.map((r) => (
                <li
                  key={r.id}
                  className="rounded-sm bg-softCream px-md py-xs text-small text-stone/80"
                >
                  <div className="flex flex-wrap items-center justify-between gap-sm">
                    <span>
                      {r.user.full_name} ·{" "}
                      <span className="font-mono">
                        {fmtRelativeDay(r.starts_at)} · {fmtTime(r.starts_at)}
                      </span>
                      {r.called_in_by ? (
                        <span className="ml-xs text-tiny text-stone/40">
                          (logged by {r.called_in_by.full_name})
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-tiny uppercase tracking-widest text-clay">
                      {statusPill(r.sick_call_status)}
                    </span>
                  </div>
                  {r.sick_call_note && (
                    <p className="mt-xs text-tiny text-stone/50">"{r.sick_call_note}"</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <SubTrackerSection />
      </main>
    </>
  );
}

// ─── Sub tracker ────────────────────────────────────────────────────────────

type TrackerTab = "history" | "leaderboard";

function SubTrackerSection() {
  const [tab, setTab] = useState<TrackerTab>("leaderboard");
  const [history, setHistory] = useState<SubHistoryEntry[] | null>(null);
  const [leaderboard, setLeaderboard] = useState<SubLeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "history" && history === null) {
      void getOfferHistory({ limit: 200 })
        .then(setHistory)
        .catch((e) => setError((e as Error).message));
    }
    if (tab === "leaderboard" && leaderboard === null) {
      void getSubLeaderboard()
        .then(setLeaderboard)
        .catch((e) => setError((e as Error).message));
    }
  }, [tab, history, leaderboard]);

  return (
    <section className="mb-2xl">
      <h2 className="mb-md font-mono text-tiny uppercase tracking-widest text-clay">
        Sub tracker
      </h2>

      {/* Tab switcher */}
      <div className="mb-md flex gap-sm border-b border-sand/30">
        {(["leaderboard", "history"] as TrackerTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`pb-xs text-small font-medium capitalize border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-terracotta text-terracotta"
                : "border-transparent text-stone/50 hover:text-stone"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-md rounded-md border border-critical/40 bg-critical/10 p-sm text-small text-stone">
          {error}
        </div>
      )}

      {tab === "leaderboard" && (
        leaderboard === null ? (
          <p className="text-small text-stone/50">Loading…</p>
        ) : leaderboard.length === 0 ? (
          <EmptyHint text="No sub data yet — offers will appear here once staff start claiming shifts." />
        ) : (
          <div className="overflow-x-auto rounded-sm border border-sand/30">
            <table className="w-full text-small">
              <thead className="bg-warmWhite">
                <tr>
                  <th className="px-md py-sm text-left font-mono text-tiny uppercase tracking-widest text-stone/50">
                    Staff member
                  </th>
                  <th className="px-md py-sm text-right font-mono text-tiny uppercase tracking-widest text-stone/50">
                    Shifts claimed
                  </th>
                  <th className="px-md py-sm text-right font-mono text-tiny uppercase tracking-widest text-stone/50">
                    Times contacted
                  </th>
                  <th className="px-md py-sm text-right font-mono text-tiny uppercase tracking-widest text-stone/50">
                    Claim rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => {
                  const rate =
                    row.times_contacted > 0
                      ? Math.round((row.shifts_claimed / row.times_contacted) * 100)
                      : 0;
                  return (
                    <tr
                      key={row.user.id}
                      className={`border-t border-sand/20 ${i === 0 && row.shifts_claimed > 0 ? "bg-terracotta/5" : ""}`}
                    >
                      <td className="px-md py-sm text-stone">
                        {i === 0 && row.shifts_claimed > 0 && (
                          <span className="mr-xs text-tiny">★</span>
                        )}
                        {row.user.full_name}
                      </td>
                      <td className="px-md py-sm text-right font-mono font-medium text-stone">
                        {row.shifts_claimed}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-stone/60">
                        {row.times_contacted}
                      </td>
                      <td className="px-md py-sm text-right font-mono text-stone/60">
                        {row.times_contacted > 0 ? `${rate}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "history" && (
        history === null ? (
          <p className="text-small text-stone/50">Loading…</p>
        ) : history.length === 0 ? (
          <EmptyHint text="No sub offers found." />
        ) : (
          <ul className="space-y-sm">
            {history.map((h) => (
              <li
                key={`${h.shift_id}-${h.opened_at}`}
                className="rounded-sm border border-sand/30 bg-warmWhite p-md"
              >
                <div className="flex flex-wrap items-start justify-between gap-md">
                  <div className="min-w-0">
                    <p className="font-medium text-stone">
                      {h.sick_user.full_name} called in sick ·{" "}
                      <span className="font-mono text-small">
                        {fmtRelativeDay(h.shift_starts_at)} · {fmtTime(h.shift_starts_at)}
                        {" → "}
                        {fmtTime(h.shift_ends_at)}
                      </span>
                    </p>
                    <p className="mt-xs text-tiny text-stone/50">
                      {h.shift_location ?? ""}
                      {h.shift_role_label ? ` · ${h.shift_role_label}` : ""} · sub offer by{" "}
                      {h.opened_by.full_name} · {fmtDateTimeShort(h.opened_at)}
                    </p>
                    <p className="mt-sm text-tiny text-stone/60">
                      <span className="font-medium text-stone/70">Sent to: </span>
                      {h.candidates.length === 0
                        ? "nobody (no eligible staff)"
                        : h.candidates.map((c) => c.full_name).join(", ")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {h.claimed_by ? (
                      <span className="inline-block rounded-sm bg-moss/10 px-sm py-xs text-tiny font-medium text-moss">
                        Claimed by {h.claimed_by.full_name}
                      </span>
                    ) : h.cancelled ? (
                      <span className="inline-block rounded-sm bg-sand/30 px-sm py-xs text-tiny text-stone/50">
                        Cancelled
                      </span>
                    ) : (
                      <span className="inline-block rounded-sm bg-sand/30 px-sm py-xs text-tiny text-stone/50">
                        Expired / unclaimed
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function Section({
  title,
  subtle,
  children,
}: {
  title: string;
  subtle?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-2xl">
      <h2
        className={`mb-md font-mono text-tiny uppercase tracking-widest ${
          subtle ? "text-stone/60" : "text-clay"
        }`}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-sm border border-dashed border-sand/40 px-md py-lg text-center text-small text-stone/60">
      {text}
    </div>
  );
}

export default function AdminSickCallsPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.manage_schedule]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
