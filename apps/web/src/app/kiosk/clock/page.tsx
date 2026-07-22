// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Kiosk clock page — public, no Google login required.
 *
 * Action-first flow (matches how staff actually think — "I'm starting"
 * or "I'm leaving" first, identifying themselves second):
 *
 *   1. Employee scans a wall-mounted QR (encodes /kiosk/clock?location=toronto)
 *   2. Landing screen shows 4 big action buttons:
 *        Clock IN / Clock OUT  (primary, side-by-side)
 *        Start break / End break  (secondary, smaller row)
 *   3. They tap the action they want
 *   4. PIN screen — phone + PIN, with the chosen action shown at top
 *   5. On submit: /kiosk/auth runs PIN check; if it succeeds we get the
 *      employee's name + last-punch status as a side effect.
 *      - If the chosen action makes sense given current status (or status
 *        is unknown), we go straight to a /kiosk/punch call.
 *      - If there's a conflict (e.g. staff tapped "Clock IN" but they're
 *        already clocked in), we show a brief confirm step so they can
 *        either continue anyway or back out and pick the right action.
 *   6. Success screen — tap-friendly confirmation, auto-resets after ~4s
 *   7. Idle timeout: 60s of no interaction returns the page to step 2
 *
 * The kiosk token returned by /kiosk/auth is held only in component state.
 * No localStorage for tokens — if the staffer walks away, the next QR scan
 * starts a fresh session.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  kioskAuth,
  kioskPunch,
  pairKioskDevice,
  KioskAuthResponse,
  KioskPunchResponse,
  KioskStatus,
  PunchType,
} from "@/lib/api";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

const PUNCH_LABEL: Record<PunchType, string> = {
  clock_in: "Clock IN",
  clock_out: "Clock OUT",
  break_start: "Start break",
  break_end: "End break",
};

const SUCCESS_RESET_MS = 4_000; // show "✓ Clocked OUT" for 4s
const IDLE_RESET_MS = 60_000;   // reset to action picker if no taps for 60s

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtElapsed(fromIso: string | null): string {
  if (!fromIso) return "";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Stable per-browser device identifier. Generated on first visit and
 * persisted to localStorage. Sent with every kiosk auth + punch so admins
 * can audit "is one device logging in many staff?" patterns.
 */
const DEVICE_ID_KEY = "northbound_kiosk_device_id";

function getOrCreateDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let id = window.localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
      window.localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Decide whether the chosen action conflicts with the current punch state.
 * E.g. clicking "Clock IN" while already clocked in = conflict.
 *
 * Returning a string surfaces the conflict reason to the UI so we can show
 * a tailored prompt; returning null means "go ahead, fire the punch."
 */
function conflictReason(action: PunchType, status: KioskStatus): string | null {
  if (action === "clock_in" && status.state === "clocked_in") {
    return "You're already clocked IN.";
  }
  if (action === "clock_in" && status.state === "on_break") {
    return "You're on a break — End break first, or continue with Clock IN anyway.";
  }
  if (action === "clock_out" && status.state === "clocked_out") {
    return "You're already clocked OUT.";
  }
  if (action === "clock_out" && status.state === "on_break") {
    return "You're on a break — End break first, or Clock OUT will end your shift.";
  }
  if (action === "break_start" && status.state !== "clocked_in") {
    return "Breaks only make sense while you're clocked in.";
  }
  if (action === "break_end" && status.state !== "on_break") {
    return "You don't have an open break to end.";
  }
  return null;
}

type Phase = "action" | "auth" | "confirm" | "success";

function KioskInner() {
  useDocumentTitle("Kiosk · clock in/out");
  const search = useSearchParams();
  const location = (search.get("location") || "toronto").toLowerCase();

  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    setDeviceId(getOrCreateDeviceId());
  }, []);

  // Single phase enum drives which screen renders. Cleaner than juggling
  // a half-dozen booleans for "is logged in / pending / done."
  const [phase, setPhase] = useState<Phase>("action");
  const [chosenAction, setChosenAction] = useState<PunchType | null>(null);

  // Auth-form field — PIN-only. Phone was dropped; PINs are unique
  // across staff so the PIN itself is enough to identify someone.
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After auth — token + status returned by /kiosk/auth
  const [session, setSession] = useState<KioskAuthResponse | null>(null);
  // After punch — server response
  const [success, setSuccess] = useState<KioskPunchResponse | null>(null);

  // Device pairing — managers use this once per physical kiosk tablet.
  // Requires the manager's own ops-dashboard session cookie to already be
  // present in this browser; the backend (not this button) enforces that.
  const [pairing, setPairing] = useState(false);
  const [pairMsg, setPairMsg] = useState<string | null>(null);

  // Tick the elapsed-time line once a minute
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Idle reset — any tap/keypress resets the timer
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetAll = useCallback(() => {
    setPhase("action");
    setChosenAction(null);
    setPin("");
    setSession(null);
    setSuccess(null);
    setError(null);
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  const bumpIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (phase === "action") return;
    idleTimer.current = setTimeout(resetAll, IDLE_RESET_MS);
  }, [phase, resetAll]);

  useEffect(() => {
    bumpIdle();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [bumpIdle]);

  // ── Action handlers ──────────────────────────────────────────────────

  const onPickAction = (action: PunchType) => {
    setChosenAction(action);
    setError(null);
    setPhase("auth");
  };

  // Helper: fire the punch using a known-good token. Sets success state
  // and schedules an auto-reset.
  const fireAndCelebrate = useCallback(
    async (token: string, action: PunchType) => {
      const res = await kioskPunch(token, {
        punch_type: action,
        location,
        device_id: deviceId,
      });
      setSuccess(res);
      setPhase("success");
      setTimeout(resetAll, SUCCESS_RESET_MS);
    },
    [deviceId, location, resetAll],
  );

  function kioskErrorMsg(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 429) return "Too many attempts. Please wait a few minutes before trying again.";
      if (err.status === 401 || err.status === 403) return "Invalid phone number or PIN.";
      if (err.status === 400) {
        try {
          const detail = (JSON.parse(err.message) as { detail?: string }).detail;
          if (detail) return detail;
        } catch {
          // ignore
        }
        return "Check your entry and try again.";
      }
    }
    return "Something went wrong. Please try again.";
  }

  const onAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosenAction) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await kioskAuth(pin.trim(), deviceId);
      setSession(res);

      // Compare chosen action to the user's current punch state.
      // If they line up, just punch. If not, show a confirm screen so
      // staff can fix a mistake (or proceed knowingly).
      const conflict = conflictReason(chosenAction, res.status);
      if (conflict) {
        setPhase("confirm");
      } else {
        await fireAndCelebrate(res.token, chosenAction);
      }
    } catch (err) {
      setError(kioskErrorMsg(err));
      // Lockout (429) — wipe PIN since they have to wait anyway
      if (err instanceof ApiError && err.status === 429) {
        setPin("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onConfirmContinue = async () => {
    if (!session || !chosenAction) return;
    setSubmitting(true);
    setError(null);
    try {
      await fireAndCelebrate(session.token, chosenAction);
    } catch (err) {
      setError(kioskErrorMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Managers only: signed in on this browser (via the regular ops-dashboard
  // login) and physically at the kiosk tablet. Pairs this device by minting
  // a signed, HttpOnly cookie — see POST /kiosk/admin/devices/pair.
  const onPairDevice = async () => {
    setPairing(true);
    setPairMsg(null);
    try {
      await pairKioskDevice();
      setPairMsg("Device paired. This tablet is now the central kiosk.");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setPairMsg("Managers only — sign in to the ops dashboard on this device first.");
      } else {
        setPairMsg("Pairing failed. Please try again.");
      }
    } finally {
      setPairing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-warmWhite px-md py-xl md:px-lg"
      onClick={bumpIdle}
      onKeyDown={bumpIdle}
    >
      <div className="w-full max-w-md rounded-lg border border-sand/30 bg-softCream p-2xl shadow-md">
        <header className="mb-lg">
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">
            {location.toUpperCase()} · time clock
          </p>
          <h1 className="mt-sm font-serif text-display text-stone">Northbound Ops</h1>
        </header>

        {error && (
          <div className="mb-md rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        {phase === "action" && (
          <ActionPicker onPick={onPickAction} lastStatus={success?.status ?? session?.status} />
        )}

        {phase === "auth" && chosenAction && (
          <AuthForm
            chosenAction={chosenAction}
            pin={pin}
            onPin={setPin}
            submitting={submitting}
            onSubmit={onAuthSubmit}
            onBack={resetAll}
          />
        )}

        {phase === "confirm" && session && chosenAction && (
          <ConfirmStep
            chosenAction={chosenAction}
            session={session}
            submitting={submitting}
            onContinue={onConfirmContinue}
            onPickDifferent={() => {
              // Keep the auth session — they just want a different action.
              // Auth is short-lived (5 min) so the token is still valid.
              setPhase("action");
              setChosenAction(null);
              setError(null);
            }}
          />
        )}

        {phase === "success" && success && (
          <SuccessCard punch={success} onDone={resetAll} />
        )}

        {phase === "action" && (
          <div className="mt-lg border-t border-sand/30 pt-sm text-center">
            <button
              type="button"
              onClick={onPairDevice}
              disabled={pairing}
              className="text-tiny text-stone/40 underline decoration-dotted hover:text-clay disabled:opacity-50"
            >
              {pairing ? "Pairing…" : "Pair this device (managers only)"}
            </button>
            {pairMsg && <p className="mt-xs text-tiny text-stone/60">{pairMsg}</p>}
          </div>
        )}
      </div>
    </main>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function ActionPicker({
  onPick,
  lastStatus,
}: {
  onPick: (a: PunchType) => void;
  lastStatus?: KioskStatus | null;
}) {
  return (
    <>
      <p className="mb-md text-small text-stone/70">What would you like to do?</p>
      <div className="grid grid-cols-2 gap-md">
        <BigButton label="Clock IN" tone="primary" onClick={() => onPick("clock_in")} />
        <BigButton label="Clock OUT" tone="dark" onClick={() => onPick("clock_out")} />
      </div>
      {/* Break buttons — shown always so staff can end auto-started breaks */}
      <div className="mt-sm grid grid-cols-2 gap-sm">
        <BigButton label="Start break" tone="muted" onClick={() => onPick("break_start")} />
        <BigButton label="End break" tone="muted" onClick={() => onPick("break_end")} />
      </div>
      {lastStatus?.state === "on_break" && lastStatus.break_started_at && (
        <OnBreakBanner
          breakStartedAt={lastStatus.break_started_at}
          plannedMinutes={lastStatus.break_planned_minutes ?? null}
          onEndBreak={() => onPick("break_end")}
        />
      )}
    </>
  );
}

function OnBreakBanner({
  breakStartedAt,
  plannedMinutes,
  onEndBreak,
}: {
  breakStartedAt: string;
  plannedMinutes: number | null;
  onEndBreak: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const startMs = new Date(breakStartedAt).getTime();
  const elapsedMs = Math.max(0, now - startMs);
  const elapsedMin = Math.floor(elapsedMs / 60_000);

  const isLate = plannedMinutes !== null && elapsedMin > plannedMinutes;
  const remainingMin =
    plannedMinutes !== null ? Math.max(0, plannedMinutes - elapsedMin) : null;

  const icon = new Date(breakStartedAt).getHours() >= 14 ? "☕" : "🍽️";
  const breakLabel = new Date(breakStartedAt).getHours() >= 14 ? "Afternoon break" : "Lunch break";

  return (
    <div
      className={`mt-md rounded-md border p-md ${
        isLate
          ? "border-critical/40 bg-critical/10"
          : "border-terracotta/30 bg-terracotta/5"
      }`}
    >
      <p className="text-tiny uppercase tracking-widest text-clay">
        {icon} {breakLabel} in progress
      </p>
      <p className="mt-xs text-body font-medium text-stone">
        {elapsedMin}m elapsed
        {remainingMin !== null && !isLate && (
          <span className="ml-sm text-stone/60 text-small">· {remainingMin}m left</span>
        )}
        {isLate && (
          <span className="ml-sm text-critical text-small font-normal">
            · {elapsedMin - (plannedMinutes ?? 0)}m over
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={onEndBreak}
        className="mt-sm w-full rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90"
      >
        End break — clock back in
      </button>
    </div>
  );
}

function AuthForm({
  chosenAction,
  pin,
  onPin,
  submitting,
  onSubmit,
  onBack,
}: {
  chosenAction: PunchType;
  pin: string;
  onPin: (s: string) => void;
  submitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-md">
      <button
        type="button"
        onClick={onBack}
        className="text-tiny uppercase tracking-widest text-clay hover:text-terracotta"
      >
        ← Pick a different action
      </button>

      <div className="rounded-sm border border-terracotta/40 bg-terracotta/5 p-md">
        <p className="text-tiny uppercase tracking-widest text-clay">You&apos;re about to</p>
        <p className="mt-xs font-serif text-h2 text-terracotta">{PUNCH_LABEL[chosenAction]}</p>
        <p className="mt-xs text-tiny text-stone/60">
          Enter your PIN to confirm. Nothing is recorded until you submit.
        </p>
      </div>

      <label className="block">
        <span className="text-tiny uppercase tracking-widest text-clay">PIN</span>
        <input
          type="password"
          inputMode="numeric"
          pattern="\d*"
          autoComplete="one-time-code"
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="••••"
          minLength={4}
          maxLength={6}
          required
          autoFocus
          disabled={submitting}
          className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-md text-h3 tracking-[0.5em] text-center focus:outline-none focus:border-terracotta"
        />
      </label>

      <button
        type="submit"
        disabled={submitting || pin.length < 4}
        className="w-full rounded-sm bg-terracotta px-md py-lg text-h3 font-medium text-warmWhite transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "Working…" : PUNCH_LABEL[chosenAction]}
      </button>

      <p className="text-tiny text-stone/50">
        Don&apos;t have a PIN? Ask your manager to set one up.
      </p>
    </form>
  );
}

function ConfirmStep({
  chosenAction,
  session,
  submitting,
  onContinue,
  onPickDifferent,
}: {
  chosenAction: PunchType;
  session: KioskAuthResponse;
  submitting: boolean;
  onContinue: () => void;
  onPickDifferent: () => void;
}) {
  const reason = conflictReason(chosenAction, session.status);
  return (
    <div className="space-y-md">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-md">
        <p className="text-tiny uppercase tracking-widest text-clay">Hi, {session.user.full_name.split(" ")[0]}</p>
        <p className="mt-xs text-body text-stone">{reason}</p>
        <CurrentStatusLine status={session.status} />
      </div>
      <button
        type="button"
        onClick={onContinue}
        disabled={submitting}
        className="w-full rounded-sm bg-terracotta px-md py-lg text-h3 font-medium text-warmWhite transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "Working…" : `Continue with ${PUNCH_LABEL[chosenAction]}`}
      </button>
      <button
        type="button"
        onClick={onPickDifferent}
        disabled={submitting}
        className="w-full rounded-sm border border-sand bg-warmWhite px-md py-md text-small text-stone hover:bg-sand/20 disabled:opacity-50"
      >
        Pick a different action
      </button>
    </div>
  );
}

function SuccessCard({ punch, onDone }: { punch: KioskPunchResponse; onDone: () => void }) {
  return (
    <div className="rounded-md border border-success/40 bg-success/10 p-lg text-center">
      <p className="text-display text-success">✓</p>
      <h2 className="mt-sm font-serif text-h2 text-stone">{PUNCH_LABEL[punch.punch_type]}</h2>
      <p className="mt-xs text-body text-stone/70">
        {punch.user.full_name} · {fmtTime(punch.punched_at)}
      </p>
      <button
        type="button"
        onClick={onDone}
        className="mt-lg rounded-sm border border-sand bg-warmWhite px-md py-sm text-small text-stone hover:bg-sand/20"
      >
        Done
      </button>
    </div>
  );
}

function CurrentStatusLine({ status }: { status: KioskStatus }) {
  if (status.state === "clocked_in") {
    return (
      <p className="mt-xs text-small text-stone/70">
        Clocked in {status.last_punch_at ? `at ${fmtTime(status.last_punch_at)}` : ""}
        {status.last_punch_at && (
          <span className="text-stone/50"> · {fmtElapsed(status.last_punch_at)} elapsed</span>
        )}
      </p>
    );
  }
  if (status.state === "on_break") {
    return (
      <p className="mt-xs text-small text-stone/70">
        On break since {fmtTime(status.last_punch_at)}
      </p>
    );
  }
  return (
    <p className="mt-xs text-small text-stone/70">
      {status.last_punch_at
        ? `Last clocked out at ${fmtTime(status.last_punch_at)}`
        : "No punches on record yet."}
    </p>
  );
}

function BigButton({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: "primary" | "dark" | "muted";
  onClick: () => void;
}) {
  const cls =
    tone === "primary"
      ? "bg-terracotta text-warmWhite hover:opacity-90"
      : tone === "dark"
        ? "bg-stone text-warmWhite hover:opacity-90"
        : "border border-sand bg-warmWhite text-stone hover:bg-sand/20";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm px-md py-lg text-h3 font-medium transition-opacity ${cls}`}
    >
      {label}
    </button>
  );
}

export default function KioskClockPage() {
  return (
    <Suspense fallback={null}>
      <KioskInner />
    </Suspense>
  );
}
