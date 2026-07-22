// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { Header } from "@/components/Header";
import { callInSick, fetchMyShifts, Shift } from "@/lib/api";
import { fmtDuration, fmtTime } from "@/lib/format";

type ExtShift = Shift & {
  sick_call_status?: "pending_review" | "dismissed" | "filling" | "filled" | null;
};

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function sickCallPillLabel(status: string | null): string | null {
  if (status === "pending_review") return "Sick — pending review";
  if (status === "filling") return "Sick — finding sub";
  if (status === "filled") return "Sick — filled";
  if (status === "dismissed") return "Sick — closed";
  return null;
}

function fmtDayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dStart = new Date(d);
  dStart.setHours(0, 0, 0, 0);
  const diff = Math.round((dStart.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diff === 0) return `Today · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  if (diff === 1) return `Tomorrow · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function Inner() {
  useDocumentTitle("My schedule");
  const me = useCurrentUser();
  const [shifts, setShifts] = useState<ExtShift[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sickPromptOpenFor, setSickPromptOpenFor] = useState<string | null>(null);
  const [sickNote, setSickNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchMyShifts(28)
      .then((rows) => setShifts(rows as ExtShift[]))
      .catch((e) => setError((e as Error).message));
  };

  const submitSick = async () => {
    if (!sickPromptOpenFor) return;
    setBusy(true);
    setError(null);
    try {
      await callInSick(sickPromptOpenFor, sickNote || undefined);
      setSickPromptOpenFor(null);
      setSickNote("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 5-min poll while visible — schedule changes are infrequent but worth
  // catching without manual reload.
  useVisibleInterval(load, 300_000);

  const grouped: Record<string, ExtShift[]> = {};
  for (const s of shifts ?? []) {
    (grouped[dayKey(s.starts_at)] ??= []).push(s);
  }
  const orderedKeys = Object.keys(grouped).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  );

  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-lg py-2xl">
        <header className="mb-lg">
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">Workforce</p>
          <h1 className="mt-sm font-serif text-display text-stone">
            {me.full_name.split(" ")[0]}&apos;s schedule
          </h1>
          <p className="mt-md text-small text-stone/70">Upcoming shifts, next 28 days.</p>
        </header>

        {error && (
          <div className="mb-lg rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        {shifts === null ? (
          <div className="space-y-md" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-32 rounded-md border border-sand/30 bg-softCream/60 animate-pulse"
              />
            ))}
          </div>
        ) : orderedKeys.length === 0 ? (
          <div className="rounded-md border border-sand/30 bg-softCream p-lg text-center">
            <p className="text-body text-stone">No shifts scheduled.</p>
            <p className="mt-xs text-small text-stone/60">Your manager will assign you when ready.</p>
          </div>
        ) : (
          <div className="space-y-lg">
            {orderedKeys.map((k) => {
              const list = grouped[k];
              return (
                <section key={k} className="rounded-md border border-sand/30 bg-softCream p-lg">
                  <p className="font-mono text-tiny uppercase tracking-widest text-clay">
                    {fmtDayHeader(list[0].starts_at)}
                  </p>
                  <ul className="mt-md space-y-sm">
                    {list.map((s) => {
                      const sickPill = sickCallPillLabel(s.sick_call_status ?? null);
                      const upcoming =
                        new Date(s.starts_at).getTime() > Date.now() &&
                        s.status === "scheduled" &&
                        !s.sick_call_status;
                      return (
                        <li
                          key={s.id}
                          className="flex flex-wrap items-center justify-between gap-sm rounded-sm bg-warmWhite px-md py-sm"
                        >
                          <div>
                            <p className="font-mono text-body text-stone">
                              {fmtTime(s.starts_at)} → {fmtTime(s.ends_at)}
                            </p>
                            <p className="mt-xs text-small text-stone/60 capitalize">
                              {s.location}
                              {s.role_label ? ` · ${s.role_label}` : ""}
                            </p>
                            {s.notes && (
                              <p className="mt-xs text-small text-stone/50">{s.notes}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-sm">
                            {sickPill && (
                              <span className="rounded-sm bg-critical/10 px-sm py-[2px] font-mono text-tiny uppercase tracking-widest text-critical">
                                {sickPill}
                              </span>
                            )}
                            <p className="font-mono text-small text-terracotta">
                              {fmtDuration(s.starts_at, s.ends_at)}
                            </p>
                            {upcoming && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSickPromptOpenFor(s.id);
                                  setSickNote("");
                                }}
                                className="rounded-sm border border-sand px-sm py-xs text-tiny text-stone hover:bg-sand/20"
                              >
                                Call in sick
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {sickPromptOpenFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone/40 p-md">
          <div className="w-full max-w-md rounded-md border border-sand/40 bg-warmWhite p-lg shadow-lg">
            <h2 className="font-serif text-h2 text-stone">Call in sick</h2>
            <p className="mt-sm text-small text-stone/70">
              Your manager will be notified. This shift will be cancelled. Add an optional note.
            </p>
            <textarea
              value={sickNote}
              onChange={(e) => setSickNote(e.target.value)}
              placeholder="Optional note (e.g. stomach bug, will follow up tomorrow)"
              className="mt-md h-24 w-full rounded-sm border border-sand/40 bg-softCream px-sm py-xs text-small text-stone"
            />
            <div className="mt-md flex justify-end gap-sm">
              <button
                type="button"
                onClick={() => {
                  setSickPromptOpenFor(null);
                  setSickNote("");
                }}
                disabled={busy}
                className="rounded-sm border border-sand px-md py-xs text-small text-stone hover:bg-sand/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitSick}
                disabled={busy}
                className="rounded-sm bg-terracotta px-md py-xs text-small font-medium text-warmWhite disabled:opacity-50"
              >
                {busy ? "Sending…" : "Call in sick"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function MySchedulePage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}
