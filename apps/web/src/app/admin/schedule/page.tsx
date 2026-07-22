// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { Calendar } from "@/components/Calendar";
import { Header } from "@/components/Header";
import { CAP, has } from "@/lib/capabilities";
import { fmtTime } from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { getHolidayName } from "@/lib/canadianHolidays";
import {
  AdminUser,
  adminListUsers,
  bulkCreateShifts,
  cancelShift,
  createShift,
  createShiftPreset,
  createStudioClosure,
  deleteShift,
  deleteShiftPreset,
  deleteStudioClosure,
  fetchAvailabilityForDate,
  listShiftPresets,
  listShifts,
  listStudioClosures,
  listTimeOffFiltered,
  ShiftPreset,
  ShiftWithStaff,
  StudioClosure,
  TimeOffRequest,
  updateShift,
  UserDayAvailability,
} from "@/lib/api";

const DAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 24 * 60 * 60 * 1000;

const CUSTOM_PRESET_ID = "__custom__";

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Compact YYYY-MM-DD → "May 29" used for the OOO label next to staff names.
// Parses date-only locally so a "2026-05-29" string doesn't shift back a day
// in negative-UTC zones.
function fmtDateOnly(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Render one approved-time-off range. Single-day requests show one date so
// non-consecutive May 29 + Jun 3 + Jun 9 doesn't get mashed into a fake
// "May 29 → Jun 9" range — the bug that prompted this helper.
function fmtTimeOffRange(start: string, end: string): string {
  return start === end ? fmtDateOnly(start) : `${fmtDateOnly(start)} → ${fmtDateOnly(end)}`;
}

// "YYYY-MM-DD" key for a Date in local time — date-only, no TZ shift.
function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTimeShort(t: string): string {
  // "09:30" → "9:30am"
  const [hStr, m] = t.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m}${ampm}`;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  return new Date(local).toISOString();
}

function combineDateAndTime(date: string, time: string): string {
  const d = new Date(`${date}T${time}:00`);
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}

// Total scheduled minutes across a day's non-cancelled shifts.
function totalMinutes(list: ShiftWithStaff[]): number {
  let m = 0;
  for (const s of list) {
    if (s.status === "cancelled") continue;
    m += Math.max(
      0,
      Math.round(
        (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000,
      ),
    );
  }
  return m;
}

function fmtHours(mins: number): string {
  if (mins === 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Existing scheduled/in-progress shifts for `userId` whose window overlaps
// [startIso, endIso). Drives the "you're about to override an existing
// shift" confirmation shown before creating/reassigning a shift for
// someone who's already scheduled at that time.
function conflictingShifts(
  list: ShiftWithStaff[],
  userId: string,
  startIso: string,
  endIso: string,
  excludeShiftId?: string,
): ShiftWithStaff[] {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  return list.filter((s) => {
    if (s.id === excludeShiftId) return false;
    if (s.user_id !== userId) return false;
    if (s.status === "cancelled" || s.status === "completed") return false;
    const sStart = new Date(s.starts_at).getTime();
    const sEnd = new Date(s.ends_at).getTime();
    return sStart < endMs && sEnd > startMs;
  });
}

// One line per conflicting shift: who + their original day/time — shown in
// the override-confirmation dialog so the admin knows exactly what they're
// about to replace.
function fmtConflictLine(s: ShiftWithStaff): string {
  const day = new Date(s.starts_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${s.user.full_name} — ${day}, ${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`;
}

function StatusPill({ status }: { status: ShiftWithStaff["status"] }) {
  const styles: Record<string, string> = {
    scheduled: "bg-mist/30 text-stone",
    in_progress: "bg-warning/15 text-warning",
    completed: "bg-success/15 text-success",
    missed: "bg-critical/15 text-critical",
    cancelled: "bg-stone/10 text-stone/60 line-through",
  };
  return (
    <span className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${styles[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function Inner() {
  useDocumentTitle("Schedule");
  const me = useCurrentUser();
  const router = useRouter();
  const allowed = has(me, CAP.manage_schedule);

  useEffect(() => {
    if (!allowed) router.replace("/");
  }, [allowed, router]);

  const [viewMode, setViewMode] = useState<"week" | "month" | "staff">("week");
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  // Mobile-only: index (0-6) of the day currently drilled into on the
  // week view. Desktop ignores this. Default resolved against the visible
  // week in an effect below (today if in view, else first day).
  const [mobileDayIdx, setMobileDayIdx] = useState<number>(0);
  const [monthStart, setMonthStart] = useState<Date>(() => startOfMonth(new Date()));
  // Month view: the day whose full shift list is open in the detail sheet
  // (opened by tapping a day cell or its "+N more"). Mobile-friendly sheet.
  const [monthDay, setMonthDay] = useState<Date | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [shifts, setShifts] = useState<ShiftWithStaff[]>([]);
  const [presets, setPresets] = useState<ShiftPreset[]>([]);
  // Approved time-off requests overlapping the visible fetch window. Used to
  // render the OOO badge next to staff names in the "by staff" grid. Each
  // request is kept as its own row so non-consecutive days render as
  // distinct dates (May 29, Jun 3, Jun 9) — never aggregated into a
  // single MIN(start)→MAX(end) span.
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShiftWithStaff | null>(null);
  // Controlled inputs for the edit modal — needed so we can recompute
  // "who's available for this slot" live as the manager edits time
  // and assignee.
  const [editUserId, setEditUserId] = useState<string>("");
  // When on, the assignee dropdown lists everyone (not just staff free in the
  // window) so a manager can deliberately double-book / override availability.
  const [editBypassAvail, setEditBypassAvail] = useState(false);
  const [editStarts, setEditStarts] = useState<string>("");
  const [editEnds, setEditEnds] = useState<string>("");
  const [editLocation, setEditLocation] = useState<string>("toronto");
  const [editRoleLabel, setEditRoleLabel] = useState<string>("");
  const [editNotes, setEditNotes] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // #1b32117d: when on, scheduling against a staff member's marked-unavailable
  // day prompts a confirm; when off, availability is ignored entirely.
  const [useAvailability, setUseAvailability] = useState(true);

  // Form state for the multi-add panel
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [presetId, setPresetId] = useState<string>(CUSTOM_PRESET_ID);
  const [customStart, setCustomStart] = useState("09:30");
  const [customEnd, setCustomEnd] = useState("17:30");
  const [savePresetLabel, setSavePresetLabel] = useState("");
  const [location, setLocation] = useState("toronto");
  const [roleLabel, setRoleLabel] = useState("");
  const [notes, setNotes] = useState("");

  // Sync edit-form state from `editing` whenever it opens.
  useEffect(() => {
    if (!editing) return;
    setEditUserId(editing.user_id);
    setEditBypassAvail(false);
    setEditStarts(toLocalInput(editing.starts_at));
    setEditEnds(toLocalInput(editing.ends_at));
    setEditLocation(editing.location);
    setEditRoleLabel(editing.role_label ?? "");
    setEditNotes(editing.notes ?? "");
  }, [editing]);

  // Compute which users are *available* for the current edit-form
  // start/end window. A user is unavailable if they have any non-cancelled,
  // non-completed shift overlapping the candidate window — excluding the
  // shift currently being edited (the assignee on the original shift is
  // always allowed even if "they overlap themselves").
  const availableUserIds = useMemo<Set<string> | null>(() => {
    if (!editing || !editStarts || !editEnds) return null;
    const startMs = new Date(editStarts).getTime();
    const endMs = new Date(editEnds).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
    const blocked = new Set<string>();
    for (const s of shifts) {
      if (s.id === editing.id) continue;
      if (s.status === "cancelled" || s.status === "completed") continue;
      const sStart = new Date(s.starts_at).getTime();
      const sEnd = new Date(s.ends_at).getTime();
      // Overlap if (sStart < endMs) and (sEnd > startMs).
      if (sStart < endMs && sEnd > startMs) blocked.add(s.user_id);
    }
    const ids = new Set<string>();
    for (const u of users) {
      if (!u.is_active) continue;
      if (!blocked.has(u.id)) ids.add(u.id);
    }
    // Always include the original assignee so the modal can render their
    // name even if their other shift logic somehow flags them.
    ids.add(editing.user_id);
    return ids;
  }, [editing, editStarts, editEnds, shifts, users]);

  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * DAY_MS), [weekStart]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );

  // Month grid: 6 weeks (42 cells) anchored at the Monday of the week containing the 1st.
  const monthCells = useMemo(() => {
    const first = startOfWeek(startOfMonth(monthStart));
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return d;
    });
  }, [monthStart]);

  const fetchRange = useMemo(() => {
    if (viewMode === "month") {
      const first = startOfWeek(startOfMonth(monthStart));
      const last = new Date(first);
      last.setDate(first.getDate() + 42);
      return { start: first.toISOString(), end: last.toISOString() };
    }
    // week + staff modes both use the current week range
    return { start: weekStart.toISOString(), end: weekEnd.toISOString() };
  }, [viewMode, weekStart, weekEnd, monthStart]);

  const refresh = async () => {
    setError(null);
    try {
      // Fetch all approved time-off and overlap-filter client-side. The
      // server's start_date/end_date filters are "starts on or after" /
      // "ends on or before", which would drop a multi-day request that
      // straddles the visible week — we want overlap semantics, not
      // containment. Tolerate failure (→ []) so a manager without
      // /time-off read access still sees the schedule.
      const [u, s, p, to] = await Promise.all([
        adminListUsers(),
        listShifts(fetchRange),
        listShiftPresets(),
        listTimeOffFiltered({
          status: ["approved"],
          limit: 500,
          order: "start_asc",
        }).catch(() => [] as TimeOffRequest[]),
      ]);
      setUsers(u.filter((x) => x.is_active));
      setShifts(s);
      setPresets(p);
      setTimeOff(to);
      // If the currently-selected preset was deleted (or first load), pick the first one
      if (presetId !== CUSTOM_PRESET_ID && !p.find((x) => x.id === presetId)) {
        setPresetId(p[0]?.id ?? CUSTOM_PRESET_ID);
      } else if (presetId === CUSTOM_PRESET_ID && p.length > 0 && !selectedFromUrl()) {
        // Default to first preset on initial load
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Track whether the user has touched the preset selector to avoid auto-overriding
  const [presetTouched, setPresetTouched] = useState(false);

  function selectedFromUrl() {
    return false;
  }

  useEffect(() => {
    if (!allowed) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRange.start, fetchRange.end, allowed]);

  // Background re-fetch every 90s while visible — keeps the calendar
  // current as managers leave it open during shifts. Heavier than the
  // dashboard fetch so 90s instead of 60s.
  useVisibleInterval(() => {
    if (!allowed) return;
    void refresh();
  }, 90_000);

  // On first load, pick the first DB preset by default if user hasn't picked yet
  useEffect(() => {
    if (!presetTouched && presets.length > 0 && presetId === CUSTOM_PRESET_ID) {
      setPresetId(presets[0].id);
    }
  }, [presets, presetId, presetTouched]);

  // Auto-clear success banner after a few seconds
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  // Mobile day-drilldown: when the visible week changes, default the
  // selected day to today if it falls in this week, otherwise the first
  // day (Monday). Desktop never reads mobileDayIdx so this is inert there.
  useEffect(() => {
    const todayKey = new Date().toDateString();
    const idx = days.findIndex((d) => d.toDateString() === todayKey);
    setMobileDayIdx(idx >= 0 ? idx : 0);
  }, [weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!allowed) return null;

  const toggleUser = (id: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllUsers = () => setSelectedUserIds(new Set(users.map((u) => u.id)));
  const clearUsers = () => setSelectedUserIds(new Set());

  const selectedPreset = presets.find((p) => p.id === presetId) ?? null;
  const isCustom = presetId === CUSTOM_PRESET_ID;
  const startTime = isCustom ? customStart : selectedPreset?.start_time ?? "";
  const endTime = isCustom ? customEnd : selectedPreset?.end_time ?? "";

  const datesArr = useMemo(() => Array.from(selectedDates).sort(), [selectedDates]);
  const totalShifts = datesArr.length * selectedUserIds.size;

  // Stat holidays among the selected dates — drives the warning banner.
  const holidayDates = useMemo(
    () =>
      datesArr
        .map((d) => ({ date: d, name: getHolidayName(d) }))
        .filter((x): x is { date: string; name: string } => x.name !== null),
    [datesArr],
  );

  // Studio closures management
  const [customClosures, setCustomClosures] = useState<StudioClosure[]>([]);
  const [closureDate, setClosureDate] = useState("");
  const [closureName, setClosureName] = useState("");
  const [closureBusy, setClosureBusy] = useState(false);
  const [closureError, setClosureError] = useState<string | null>(null);
  const [closureSuccess, setClosureSuccess] = useState<string | null>(null);

  const refreshClosures = async () => {
    try {
      setCustomClosures(await listStudioClosures());
    } catch {
      // non-fatal
    }
  };

  useEffect(() => {
    if (!allowed) return;
    void refreshClosures();
  }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Custom closures that overlap with the selected dates — drives the warning banner.
  const customClosureDates = useMemo(
    () => customClosures.filter((c) => datesArr.includes(c.date)),
    [customClosures, datesArr],
  );

  // Availability per selected date: date → user_id → effective availability.
  // Drives the "unavailable" tags in the staff panel and the submit warning.
  const [availByDate, setAvailByDate] = useState<Record<string, Record<string, UserDayAvailability>>>({});

  useEffect(() => {
    let stale = false;
    const missing = datesArr.filter((d) => !(d in availByDate));
    if (missing.length === 0) return;
    void (async () => {
      const fetched: Record<string, Record<string, UserDayAvailability>> = {};
      for (const d of missing) {
        try {
          const rows = await fetchAvailabilityForDate(d);
          fetched[d] = Object.fromEntries(rows.map((r) => [r.user_id, r]));
        } catch {
          // availability is advisory — a failed fetch never blocks scheduling
        }
      }
      if (!stale && Object.keys(fetched).length > 0) {
        setAvailByDate((prev) => ({ ...prev, ...fetched }));
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datesArr]);

  // Per-user availability conflicts across the selected dates + shift window.
  // Explicit "no" (weekly day off or a one-off override) → hard conflict.
  // Available but the chosen times fall outside their window → partial.
  // source="none" (never filled in) is not flagged — most staff haven't set it.
  const availConflicts = useMemo(() => {
    const out: Record<string, { date: string; kind: "off" | "partial"; window?: string }[]> = {};
    if (datesArr.length === 0) return out;
    for (const d of datesArr) {
      const byUser = availByDate[d];
      if (!byUser) continue;
      for (const [uid, a] of Object.entries(byUser)) {
        if (a.source === "none") continue;
        if (!a.is_available) {
          (out[uid] ??= []).push({ date: d, kind: "off" });
        } else if (
          startTime &&
          endTime &&
          a.start_time &&
          a.end_time &&
          (startTime < a.start_time || endTime > a.end_time)
        ) {
          (out[uid] ??= []).push({
            date: d,
            kind: "partial",
            window: `${a.start_time}–${a.end_time}`,
          });
        }
      }
    }
    return out;
  }, [datesArr, availByDate, startTime, endTime]);

  const fmtShortDate = (iso: string) => {
    const [y, m, dd] = iso.split("-").map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (datesArr.length === 0 || selectedUserIds.size === 0) {
      setError("Pick at least one day and one staff member.");
      return;
    }
    if (!startTime || !endTime || startTime >= endTime) {
      setError("Start time must be before end time.");
      return;
    }

    // Availability is advisory: warn, let the manager decide.
    const warnings: string[] = [];
    for (const uid of selectedUserIds) {
      const offs = (availConflicts[uid] ?? []).filter(
        (c) => c.kind === "off" && selectedDates.has(c.date),
      );
      if (offs.length > 0) {
        const u = users.find((x) => x.id === uid);
        warnings.push(
          `${u?.full_name ?? uid} is unavailable ${offs.map((c) => fmtShortDate(c.date)).join(", ")}`,
        );
      }
    }
    if (useAvailability && warnings.length > 0) {
      const ok = confirm(
        `Heads up — scheduling against availability:\n\n${warnings.join("\n")}\n\nCreate anyway?`,
      );
      if (!ok) return;
    }

    // Holiday/closure pay warning
    const closedDayLines = [
      ...holidayDates.map((h) => `${h.date} — ${h.name} (Stat Holiday)`),
      ...customClosureDates.map((c) => `${c.date} — ${c.name} (Studio closure)`),
    ];
    if (closedDayLines.length > 0) {
      const ok = confirm(
        `You are scheduling on a closed day:\n\n${closedDayLines.join("\n")}\n\nStaff scheduled on statutory holidays may be entitled to holiday pay. Create shifts anyway?`,
      );
      if (!ok) return;
    }

    // Existing-schedule conflicts: for each (day × person), check whether
    // they already have a shift that overlaps the window we're about to
    // create. If so, show the original shift's time and who it belongs to
    // and require an explicit confirm before overriding (cancelling) it.
    const conflictKeys = new Set<string>();
    const conflictLines: string[] = [];
    for (const date of datesArr) {
      const newStart = combineDateAndTime(date, startTime);
      const newEnd = combineDateAndTime(date, endTime);
      for (const userId of selectedUserIds) {
        const conflicts = conflictingShifts(shifts, userId, newStart, newEnd);
        if (conflicts.length > 0) {
          conflictKeys.add(`${userId}|${date}`);
          for (const c of conflicts) conflictLines.push(fmtConflictLine(c));
        }
      }
    }
    if (conflictKeys.size > 0) {
      const ok = confirm(
        `The following staff already have a shift in this window:\n\n${conflictLines.join("\n")}\n\nContinuing will override (cancel) their original shift and replace it with this new schedule. Continue?`,
      );
      if (!ok) return;
    }

    setBusy(true);

    const shiftsToCreate = datesArr.flatMap((date) =>
      Array.from(selectedUserIds).map((userId) => ({
        user_id: userId,
        starts_at: combineDateAndTime(date, startTime),
        ends_at: combineDateAndTime(date, endTime),
        location,
        role_label: roleLabel || null,
        notes: notes || null,
        override_conflicts: conflictKeys.has(`${userId}|${date}`),
      })),
    );

    try {
      const result = await bulkCreateShifts(shiftsToCreate);
      setBusy(false);
      const overrideNote = result.overridden > 0 ? ` (${result.overridden} overridden)` : "";
      if (result.skipped === 0) {
        setSuccess(`Created ${result.created} shift${result.created === 1 ? "" : "s"}${overrideNote}. Emails sent to affected staff.`);
      } else {
        setSuccess(`Created ${result.created} shift${result.created === 1 ? "" : "s"}${overrideNote} (${result.skipped} skipped due to conflicts). Emails sent to affected staff.`);
      }
      setSelectedDates(new Set());
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
    await refresh();
  };

  const onSavePreset = async () => {
    setError(null);
    if (!savePresetLabel.trim()) {
      setError("Give the preset a name first.");
      return;
    }
    if (!customStart || !customEnd || customEnd <= customStart) {
      setError("Custom hours invalid.");
      return;
    }
    try {
      const created = await createShiftPreset({
        label: savePresetLabel.trim(),
        start_time: customStart,
        end_time: customEnd,
      });
      setSavePresetLabel("");
      setPresets((prev) => [...prev, created].sort((a, b) => a.start_time.localeCompare(b.start_time)));
      setPresetId(created.id);
      setPresetTouched(true);
      setSuccess(`Saved preset "${created.label}".`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onDeletePreset = async (p: ShiftPreset) => {
    if (!confirm(`Delete preset "${p.label}"?`)) return;
    try {
      await deleteShiftPreset(p.id);
      setPresets((prev) => prev.filter((x) => x.id !== p.id));
      if (presetId === p.id) {
        setPresetId(CUSTOM_PRESET_ID);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onSaveEdit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    // Assignee already has an overlapping shift in this window — show its
    // original time and who it belongs to, and require an explicit confirm
    // before overriding (cancelling) it in favor of this edit.
    const newStart = fromLocalInput(editStarts);
    const newEnd = fromLocalInput(editEnds);
    const editConflicts = conflictingShifts(shifts, editUserId, newStart, newEnd, editing.id);
    let overrideConflicts = false;
    if (editConflicts.length > 0) {
      const lines = editConflicts.map(fmtConflictLine).join("\n");
      const ok = confirm(
        `This assignment overlaps an existing shift:\n\n${lines}\n\nContinuing will override (cancel) that shift and replace it with this one. Continue?`,
      );
      if (!ok) return;
      overrideConflicts = true;
    }
    try {
      await updateShift(editing.id, {
        user_id: editUserId,
        starts_at: newStart,
        ends_at: newEnd,
        location: editLocation,
        role_label: editRoleLabel.trim() || null,
        notes: editNotes.trim() || null,
        override_conflicts: overrideConflicts,
      });
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shiftsByDay: Record<string, ShiftWithStaff[]> = {};
  const shiftsByUserDay: Record<string, ShiftWithStaff[]> = {};
  for (const s of shifts) {
    // #c57dd659: cancelled shifts are hidden from the calendar entirely.
    if (s.status === "cancelled") continue;
    const day = new Date(s.starts_at);
    const dayKey = day.toDateString();
    (shiftsByDay[dayKey] ??= []).push(s);
    const k = `${s.user_id}|${dayKey}`;
    (shiftsByUserDay[k] ??= []).push(s);
  }
  for (const arr of Object.values(shiftsByDay)) {
    arr.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }
  for (const arr of Object.values(shiftsByUserDay)) {
    arr.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  // Approved time-off rows overlapping the visible week, grouped by user.
  // Each row stays as its own range — three non-consecutive single-day
  // approvals must render as three distinct dates, not a fake "May 29 →
  // Jun 9" span. Only used by the by-staff view.
  const weekStartKey = dateKey(days[0]);
  const weekEndKey = dateKey(days[6]);
  const timeOffByUser: Record<string, TimeOffRequest[]> = {};
  for (const t of timeOff) {
    // Overlap: request.start <= weekEnd AND request.end >= weekStart.
    if (t.start_date > weekEndKey) continue;
    if (t.end_date < weekStartKey) continue;
    (timeOffByUser[t.user_id] ??= []).push(t);
  }
  for (const arr of Object.values(timeOffByUser)) {
    arr.sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-md py-xl space-y-xl md:px-lg md:py-2xl md:space-y-2xl">
        <header className="flex items-baseline justify-between flex-wrap gap-md">
          <div>
            <p className="font-mono text-tiny uppercase tracking-widest text-clay">Workforce</p>
            <h1 className="mt-sm font-serif text-display text-stone">Schedule</h1>
          </div>
        </header>

        {error && (
          <div className="whitespace-pre-line rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}

        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <h2 className="font-serif text-h2">Add shifts</h2>
          <p className="mt-xs text-small text-stone/60">
            Pick days, pick people, pick a shift. We&apos;ll create one shift per (person × day).
          </p>
          <form onSubmit={onCreate} className="mt-lg grid gap-xl md:grid-cols-2">
            {/* Calendar */}
            <div className="rounded-md border border-sand/40 bg-warmWhite p-md">
              <p className="text-tiny uppercase tracking-widest text-clay">Days</p>
              <div className="mt-sm">
                <Calendar value={selectedDates} onChange={setSelectedDates} />
              </div>
              {(holidayDates.length > 0 || customClosureDates.length > 0) && (
                <div className="mt-sm rounded-sm border border-warning/40 bg-warning/10 px-sm py-sm">
                  <p className="text-tiny font-medium uppercase tracking-widest text-warning">
                    {holidayDates.length > 0 && customClosureDates.length === 0
                      ? `⚠ Stat Holiday${holidayDates.length > 1 ? "s" : ""}`
                      : holidayDates.length === 0 && customClosureDates.length > 0
                        ? "⚠ Studio closed"
                        : "⚠ Stat holidays & closures"}
                  </p>
                  <ul className="mt-xs space-y-xs">
                    {holidayDates.map(({ date, name }) => (
                      <li key={date} className="text-tiny text-stone/80">
                        {date} — {name} · <span className="text-warning/70">Stat Holiday</span>
                      </li>
                    ))}
                    {customClosureDates.map((c) => (
                      <li key={c.id} className="text-tiny text-stone/80">
                        {c.date} — {c.name} · <span className="text-warning/70">Closed</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Staff */}
            <div className="flex flex-col rounded-md border border-sand/40 bg-warmWhite p-md">
              <div className="flex items-baseline justify-between">
                <p className="text-tiny uppercase tracking-widest text-clay">Staff</p>
                <div className="flex gap-md text-tiny uppercase tracking-widest text-clay">
                  <button type="button" onClick={selectAllUsers} className="hover:underline">All</button>
                  <button type="button" onClick={clearUsers} className="hover:underline">None</button>
                </div>
              </div>
              <ul className="mt-sm min-h-0 flex-1 space-y-xs overflow-y-auto">
                {users.map((u) => {
                  const checked = selectedUserIds.has(u.id);
                  const conflicts = availConflicts[u.id] ?? [];
                  const offDates = conflicts.filter((c) => c.kind === "off");
                  const partial = conflicts.find((c) => c.kind === "partial");
                  return (
                    <li key={u.id}>
                      <label className="flex cursor-pointer items-center gap-sm rounded-sm px-sm py-xs hover:bg-sand/20">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleUser(u.id)}
                          className="accent-terracotta"
                        />
                        <span className="min-w-0 text-small">
                          {u.full_name}{" "}
                          <span className="text-stone/50">({u.email})</span>
                          {offDates.length > 0 && (
                            <span className="ml-sm whitespace-nowrap rounded-full bg-terracotta/10 px-sm py-px font-mono text-tiny text-terracotta">
                              off {offDates.map((c) => fmtShortDate(c.date)).join(", ")}
                            </span>
                          )}
                          {offDates.length === 0 && partial && (
                            <span className="ml-sm whitespace-nowrap rounded-full bg-warning/10 px-sm py-px font-mono text-tiny text-warning">
                              avail {partial.window}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {users.length === 0 && (
                  <li className="text-small text-stone/60">No active users.</li>
                )}
              </ul>
              {selectedUserIds.size > 0 && (
                <p className="mt-sm text-tiny text-stone/60">
                  {selectedUserIds.size} selected
                </p>
              )}
            </div>

            {/* Shift presets */}
            <div className="md:col-span-2 rounded-md border border-sand/40 bg-warmWhite p-md">
              <p className="text-tiny uppercase tracking-widest text-clay">Shift</p>
              <div className="mt-sm flex flex-wrap gap-sm">
                {presets.map((p) => {
                  const active = presetId === p.id;
                  return (
                    <span
                      key={p.id}
                      className={`flex items-stretch overflow-hidden rounded-full border transition-colors duration-fast ease-northbound ${
                        active
                          ? "border-terracotta bg-terracotta text-warmWhite"
                          : "border-sand bg-warmWhite text-stone hover:border-terracotta/60"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setPresetId(p.id);
                          setPresetTouched(true);
                        }}
                        className="px-md py-sm text-small"
                      >
                        {p.label}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeletePreset(p)}
                        aria-label={`Delete preset ${p.label}`}
                        className={`px-sm text-small border-l ${
                          active ? "border-warmWhite/30 hover:bg-warmWhite/15" : "border-sand hover:bg-critical/10 hover:text-critical"
                        }`}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setPresetId(CUSTOM_PRESET_ID);
                    setPresetTouched(true);
                  }}
                  className={`rounded-full border px-md py-sm text-small transition-colors duration-fast ease-northbound ${
                    isCustom
                      ? "border-terracotta bg-terracotta text-warmWhite"
                      : "border-sand bg-warmWhite text-stone hover:border-terracotta/60"
                  }`}
                >
                  Custom hours
                </button>
              </div>

              {isCustom && (
                <div className="mt-md space-y-md">
                  <div className="grid gap-md md:grid-cols-4">
                    <label className="block text-small">
                      <span className="text-tiny uppercase tracking-widest text-clay">Starts</span>
                      <input
                        type="time"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        required
                        className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
                      />
                    </label>
                    <label className="block text-small">
                      <span className="text-tiny uppercase tracking-widest text-clay">Ends</span>
                      <input
                        type="time"
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        required
                        className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
                      />
                    </label>
                    <label className="block text-small md:col-span-2">
                      <span className="text-tiny uppercase tracking-widest text-clay">
                        Save these hours as a preset (optional)
                      </span>
                      <div className="mt-xs flex gap-sm">
                        <input
                          type="text"
                          placeholder='e.g. "Late · 12pm – 8pm"'
                          value={savePresetLabel}
                          onChange={(e) => setSavePresetLabel(e.target.value)}
                          maxLength={64}
                          className="flex-1 rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                        />
                        <button
                          type="button"
                          onClick={onSavePreset}
                          disabled={!savePresetLabel.trim()}
                          className="rounded-sm border border-sand px-md py-sm text-small hover:bg-sand/20 disabled:opacity-50"
                        >
                          Save
                        </button>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {!isCustom && selectedPreset && (
                <p className="mt-sm text-small text-stone/60">
                  {fmtTimeShort(selectedPreset.start_time)} – {fmtTimeShort(selectedPreset.end_time)}
                </p>
              )}
            </div>

            {/* Location / role / notes */}
            <div className="md:col-span-2 grid gap-md md:grid-cols-4">
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">Location</span>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                >
                  <option value="toronto">Toronto</option>
                  <option value="wavecrest">Wavecrest</option>
                </select>
              </label>
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">Role</span>
                <input
                  value={roleLabel}
                  onChange={(e) => setRoleLabel(e.target.value)}
                  placeholder="optional"
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                />
              </label>
              <label className="block text-small md:col-span-2">
                <span className="text-tiny uppercase tracking-widest text-clay">Notes</span>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="optional"
                  className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                />
              </label>
            </div>

            <div className="md:col-span-2 space-y-md">
              {success && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-sm rounded-md border border-success/40 bg-success/10 p-md text-small text-stone"
                >
                  <span aria-hidden className="text-success">✓</span>
                  <span>{success}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-sm">
                <p className="text-small text-stone/60">
                  {totalShifts > 0
                    ? `Will create ${totalShifts} shift${totalShifts === 1 ? "" : "s"}`
                    : "Pick days and people."}
                </p>
                <div className="flex items-center gap-sm">
                  <button
                    type="button"
                    onClick={() => setUseAvailability((v) => !v)}
                    title={
                      useAvailability
                        ? "Availability is checked — scheduling someone on a day off will ask you to confirm."
                        : "Availability is ignored — no warnings when scheduling against it."
                    }
                    className={`rounded-sm border px-md py-sm text-tiny uppercase tracking-widest ${
                      useAvailability
                        ? "border-terracotta bg-terracotta/10 text-terracotta"
                        : "border-sand text-stone/50 hover:bg-sand/20"
                    }`}
                  >
                    Use staff availability: {useAvailability ? "On" : "Off"}
                  </button>
                  <button
                    type="submit"
                    disabled={busy || totalShifts === 0}
                  className="rounded-sm bg-terracotta px-lg py-sm text-small font-medium text-warmWhite transition-opacity duration-fast ease-northbound hover:opacity-90 disabled:opacity-50"
                >
                  {busy
                    ? "Creating…"
                    : totalShifts > 0
                      ? `Add ${totalShifts} shift${totalShifts === 1 ? "" : "s"}`
                      : "Add shifts"}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </section>

        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <h2 className="font-serif text-h2">Studio closures</h2>
          <p className="mt-xs text-small text-stone/60">
            Days added here trigger warnings when scheduling shifts on those dates.
          </p>
          <div className="mt-lg flex flex-wrap items-end gap-md">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Date</span>
              <input
                type="date"
                value={closureDate}
                onChange={(e) => setClosureDate(e.target.value)}
                className="mt-xs block rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="flex-1 block text-small min-w-48">
              <span className="text-tiny uppercase tracking-widest text-clay">Name</span>
              <input
                type="text"
                value={closureName}
                onChange={(e) => setClosureName(e.target.value)}
                placeholder='e.g. "Staff training day"'
                maxLength={255}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
              />
            </label>
            <button
              type="button"
              disabled={closureBusy || !closureDate || !closureName.trim()}
              onClick={async () => {
                setClosureError(null);
                setClosureSuccess(null);
                setClosureBusy(true);
                try {
                  await createStudioClosure({ date: closureDate, name: closureName.trim() });
                  setClosureDate("");
                  setClosureName("");
                  setClosureSuccess("Closure added.");
                  await refreshClosures();
                } catch (e) {
                  setClosureError((e as Error).message || "Failed to add closure.");
                } finally {
                  setClosureBusy(false);
                }
              }}
              className="rounded-sm bg-terracotta px-lg py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
            >
              {closureBusy ? "Adding…" : "Add closure"}
            </button>
          </div>
          {closureError && (
            <div className="mt-md rounded-sm border border-critical/40 bg-critical/10 p-md text-small text-stone">
              {closureError}
            </div>
          )}
          {closureSuccess && (
            <div className="mt-md rounded-sm border border-success/40 bg-success/10 p-md text-small text-stone">
              {closureSuccess}
            </div>
          )}
          {customClosures.length > 0 ? (
            <ul className="mt-lg divide-y divide-sand/20 rounded-md border border-sand/30 bg-warmWhite">
              {customClosures.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-md px-md py-sm">
                  <div>
                    <span className="font-mono text-small text-stone">{c.date}</span>
                    <span className="ml-md text-small text-stone">{c.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Remove "${c.name}" (${c.date})?`)) return;
                      try {
                        await deleteStudioClosure(c.id);
                        await refreshClosures();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    className="text-tiny text-critical hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-md text-small text-stone/40">No custom closures added yet.</p>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-md">
          <div className="flex overflow-hidden rounded-full border border-sand">
            {(["week", "month", "staff"] as const).map((m) => {
              const active = viewMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={`px-md py-xs text-small capitalize ${
                    active ? "bg-terracotta text-warmWhite" : "text-stone hover:bg-sand/20"
                  }`}
                >
                  {m === "staff" ? "By staff" : m}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              if (viewMode === "month") {
                setMonthStart(
                  new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1),
                );
              } else {
                setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS));
              }
            }}
            className="rounded-sm border border-sand px-md py-xs text-small hover:bg-sand/20"
          >
            ← Prev
          </button>
          <span className="font-mono text-small text-stone/70">
            {viewMode === "month"
              ? monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })
              : `${fmtDay(days[0])} → ${fmtDay(days[6])}`}
          </span>
          <button
            type="button"
            onClick={() => {
              if (viewMode === "month") {
                setMonthStart(
                  new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1),
                );
              } else {
                setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS));
              }
            }}
            className="rounded-sm border border-sand px-md py-xs text-small hover:bg-sand/20"
          >
            Next →
          </button>
          <button
            type="button"
            onClick={() => {
              setWeekStart(startOfWeek(new Date()));
              setMonthStart(startOfMonth(new Date()));
            }}
            className="rounded-sm border border-sand px-md py-xs text-small hover:bg-sand/20"
          >
            Today
          </button>
        </div>

        {viewMode === "staff" ? (
          <StaffGrid
            users={users}
            days={days}
            shiftsByUserDay={shiftsByUserDay}
            timeOffByUser={timeOffByUser}
            onShiftClick={(s) => setEditing(s)}
            onCellClick={async (userId, day) => {
              if (!startTime || !endTime || startTime >= endTime) {
                setError(
                  "Pick a preset (or set valid Custom hours) above before quick-adding.",
                );
                return;
              }
              const dateStr = (() => {
                const pad = (n: number) => String(n).padStart(2, "0");
                return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
              })();
              const newStart = combineDateAndTime(dateStr, startTime);
              const newEnd = combineDateAndTime(dateStr, endTime);
              const conflicts = conflictingShifts(shifts, userId, newStart, newEnd);
              let overrideConflicts = false;
              if (conflicts.length > 0) {
                const lines = conflicts.map(fmtConflictLine).join("\n");
                const ok = confirm(
                  `This person already has a shift in this window:\n\n${lines}\n\nContinuing will override (cancel) that shift and replace it with this one. Continue?`,
                );
                if (!ok) return;
                overrideConflicts = true;
              }
              try {
                await createShift({
                  user_id: userId,
                  starts_at: newStart,
                  ends_at: newEnd,
                  location,
                  role_label: roleLabel || null,
                  notes: notes || null,
                  override_conflicts: overrideConflicts,
                });
                setSuccess("Shift added.");
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        ) : viewMode === "week" ? (
          <>
          {/* Mobile-only day drilldown. Hidden at md+ where the 7-col grid
              below takes over. Tap a weekday chip to focus that day's shifts
              as a full-width list reusing the same card markup + handlers. */}
          <section className="md:hidden">
            <div className="-mx-md overflow-x-auto px-md">
              <div className="flex gap-sm">
                {days.map((d, i) => {
                  const list = shiftsByDay[d.toDateString()] ?? [];
                  const activeCount = list.filter((s) => s.status !== "cancelled").length;
                  const selected = i === mobileDayIdx;
                  const isToday = d.toDateString() === new Date().toDateString();
                  return (
                    <button
                      key={d.toISOString()}
                      type="button"
                      onClick={() => setMobileDayIdx(i)}
                      className={`flex min-w-16 flex-col items-center rounded-md border px-md py-sm transition-colors duration-fast ease-northbound ${
                        selected
                          ? "border-terracotta bg-terracotta text-warmWhite"
                          : "border-sand bg-softCream text-stone hover:border-terracotta/60"
                      }`}
                    >
                      <span className="font-mono text-tiny uppercase tracking-widest">
                        {DAY_LABEL[i]}
                      </span>
                      <span className={`mt-xs font-serif text-h2 ${isToday && !selected ? "text-terracotta" : ""}`}>
                        {d.getDate()}
                      </span>
                      {activeCount > 0 && (
                        <span
                          className={`mt-xs h-1.5 w-1.5 rounded-full ${
                            selected ? "bg-warmWhite" : "bg-terracotta"
                          }`}
                          aria-hidden
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {(() => {
              const d = days[mobileDayIdx] ?? days[0];
              const list = shiftsByDay[d.toDateString()] ?? [];
              const activeCount = list.filter((s) => s.status !== "cancelled").length;
              const totalMins = totalMinutes(list);
              const pad = (n: number) => String(n).padStart(2, "0");
              const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
              return (
                <div className="mt-md rounded-md border border-sand/30 bg-softCream p-md">
                  <div className="flex items-baseline justify-between gap-xs">
                    <p className="font-serif text-h2 text-stone">{fmtDay(d)}</p>
                    {activeCount > 0 && (
                      <p className="font-mono text-tiny text-stone/60">
                        {activeCount}× · {fmtHours(totalMins)}
                      </p>
                    )}
                  </div>
                  {list.length === 0 ? (
                    <p className="mt-sm text-small text-stone/40">No shifts scheduled.</p>
                  ) : (
                    <ul className="mt-sm space-y-sm">
                      {list.map((s) => (
                        <li key={s.id} className="rounded-sm border border-sand/40 bg-warmWhite p-sm">
                          <p className="text-small text-stone">
                            {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                          </p>
                          <Link
                            href={`/admin/staff/${s.user_id}`}
                            className="mt-xs block text-small font-medium text-stone hover:text-terracotta hover:underline"
                          >
                            {s.user.full_name}
                          </Link>
                          {s.role_label && (
                            <p className="mt-xs text-tiny text-stone/60">{s.role_label}</p>
                          )}
                          <p className="mt-xs text-tiny text-stone/40 capitalize">{s.location}</p>
                          <div className="mt-sm flex flex-wrap items-center justify-between gap-xs">
                            <StatusPill status={s.status} />
                            {s.status !== "cancelled" && (
                              <span className="flex gap-sm text-tiny">
                                <button
                                  type="button"
                                  onClick={() => setEditing(s)}
                                  className="text-clay hover:underline"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!confirm("Cancel this shift?")) return;
                                    try {
                                      await cancelShift(s.id);
                                      await refresh();
                                    } catch (e) {
                                      setError((e as Error).message);
                                    }
                                  }}
                                  className="text-critical hover:underline"
                                >
                                  Cancel
                                </button>
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      // Reuse the existing multi-add create flow: preselect
                      // this day in the form and scroll up to it. No fork of
                      // the data layer — onCreate handles the rest.
                      setSelectedDates(new Set([dateStr]));
                      if (typeof window !== "undefined") {
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }
                    }}
                    className="mt-md block w-full rounded-sm border border-dashed border-sand/60 px-md py-sm text-small text-stone/60 hover:border-terracotta/60 hover:text-terracotta"
                  >
                    + Add shift on {fmtDay(d)}
                  </button>
                </div>
              );
            })()}
          </section>

          <section className="hidden gap-md md:grid md:grid-cols-7">
            {days.map((d, i) => {
              const list = shiftsByDay[d.toDateString()] ?? [];
              const activeCount = list.filter((s) => s.status !== "cancelled").length;
              const totalMins = totalMinutes(list);
              return (
                <div key={d.toISOString()} className="rounded-md border border-sand/30 bg-softCream p-md">
                  <div className="flex items-baseline justify-between gap-xs">
                    <p className="font-mono text-tiny uppercase tracking-widest text-clay">
                      {DAY_LABEL[i]} · {d.getDate()}
                    </p>
                    {activeCount > 0 && (
                      <p className="font-mono text-tiny text-stone/60">
                        {activeCount}× · {fmtHours(totalMins)}
                      </p>
                    )}
                  </div>
                  {list.length === 0 ? (
                    <p className="mt-sm text-tiny text-stone/40">—</p>
                  ) : (
                    <ul className="mt-sm space-y-sm">
                      {list.map((s) => (
                        <li key={s.id} className="rounded-sm border border-sand/40 bg-warmWhite p-sm">
                          <p className="text-small text-stone">
                            {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                          </p>
                          <Link
                            href={`/admin/staff/${s.user_id}`}
                            className="mt-xs block text-small font-medium text-stone hover:text-terracotta hover:underline"
                          >
                            {s.user.full_name}
                          </Link>
                          {s.role_label && (
                            <p className="mt-xs text-tiny text-stone/60">{s.role_label}</p>
                          )}
                          <p className="mt-xs text-tiny text-stone/40 capitalize">{s.location}</p>
                          <div className="mt-sm flex flex-wrap items-center justify-between gap-xs">
                            <StatusPill status={s.status} />
                            {s.status !== "cancelled" && (
                              <span className="flex gap-sm text-tiny">
                                <button
                                  type="button"
                                  onClick={() => setEditing(s)}
                                  className="text-clay hover:underline"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!confirm("Cancel this shift?")) return;
                                    try {
                                      await cancelShift(s.id);
                                      await refresh();
                                    } catch (e) {
                                      setError((e as Error).message);
                                    }
                                  }}
                                  className="text-critical hover:underline"
                                >
                                  Cancel
                                </button>
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>
          </>
        ) : (
          <section>
            <div className="grid grid-cols-7 gap-xs text-center text-tiny uppercase tracking-widest text-clay">
              {DAY_LABEL.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="mt-xs grid grid-cols-7 gap-xs">
              {monthCells.map((d) => {
                const list = shiftsByDay[d.toDateString()] ?? [];
                const inMonth = d.getMonth() === monthStart.getMonth();
                const isToday = d.toDateString() === new Date().toDateString();
                const visible = list.slice(0, 4);
                const hidden = list.length - visible.length;
                return (
                  <div
                    key={d.toISOString()}
                    className={`min-h-28 rounded-sm border p-sm transition-colors ${
                      inMonth ? "border-sand/40 bg-softCream" : "border-sand/20 bg-softCream/40"
                    } ${isToday ? "border-terracotta" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => setMonthDay(d)}
                      className={`font-mono text-tiny hover:underline ${
                        inMonth ? "text-stone" : "text-stone/40"
                      } ${isToday ? "text-terracotta" : ""}`}
                      title="View everyone scheduled this day"
                    >
                      {d.getDate()}
                    </button>
                    {visible.length > 0 && (
                      <ul className="mt-xs space-y-xs">
                        {visible.map((s) => {
                          const isCancelled = s.status === "cancelled";
                          return (
                            <li key={s.id}>
                              <button
                                type="button"
                                onClick={() => setEditing(s)}
                                className={`block w-full truncate rounded-sm bg-warmWhite px-xs py-xs text-left text-tiny hover:bg-sand/30 ${
                                  isCancelled ? "text-stone/40 line-through" : "text-stone"
                                }`}
                                title={`${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)} · ${s.user.full_name}${
                                  s.role_label ? " · " + s.role_label : ""
                                }`}
                              >
                                <span className="font-mono text-clay">{fmtTime(s.starts_at)}</span>{" "}
                                {s.user.full_name.split(" ")[0]}
                                {s.status === "completed" && (
                                  <span className="ml-xs font-mono text-success opacity-70">✓</span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                        {hidden > 0 && (
                          <li>
                            <button
                              type="button"
                              onClick={() => setMonthDay(d)}
                              className="w-full rounded-sm px-xs py-xs text-left text-tiny text-clay hover:bg-sand/30 hover:underline"
                            >
                              +{hidden} more
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {monthDay && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-end justify-center bg-stone/40 sm:items-center sm:px-lg"
            onClick={() => setMonthDay(null)}
          >
            <div
              className="max-h-[85vh] w-full overflow-y-auto rounded-t-lg border border-sand/30 bg-softCream p-lg shadow-lg sm:max-w-md sm:rounded-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline justify-between gap-md">
                <h2 className="font-serif text-h2 text-stone">{fmtDay(monthDay)}</h2>
                <button
                  type="button"
                  onClick={() => setMonthDay(null)}
                  className="text-tiny uppercase tracking-widest text-stone/60 hover:text-stone"
                >
                  Close
                </button>
              </div>
              {(() => {
                const list = shiftsByDay[monthDay.toDateString()] ?? [];
                if (list.length === 0) {
                  return <p className="mt-md text-small text-stone/40">No shifts scheduled.</p>;
                }
                return (
                  <ul className="mt-md space-y-sm">
                    {list.map((s) => {
                      const isCancelled = s.status === "cancelled";
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setEditing(s)}
                            className={`flex w-full items-center justify-between gap-md rounded-sm border border-sand/40 bg-warmWhite px-md py-sm text-left transition-colors duration-fast ease-northbound hover:bg-sand/20 ${
                              isCancelled ? "opacity-60" : ""
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <span
                                className={`text-small ${
                                  isCancelled ? "text-stone/40 line-through" : "text-stone"
                                }`}
                              >
                                {s.user.full_name}
                                {s.role_label && (
                                  <span className="text-stone/50"> · {s.role_label}</span>
                                )}
                              </span>
                              {!isCancelled && s.status !== "scheduled" && (
                                <span className={`ml-sm rounded-full px-xs py-px font-mono text-tiny uppercase tracking-widest ${
                                  s.status === "completed"
                                    ? "bg-success/15 text-success"
                                    : "bg-mist/30 text-stone/60"
                                }`}>
                                  {s.status}
                                </span>
                              )}
                            </div>
                            <span className="whitespace-nowrap font-mono text-tiny text-clay">
                              {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
          </div>
        )}

        {editing && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-stone/40 px-lg"
            onClick={() => setEditing(null)}
          >
            <div
              className="w-full max-w-md rounded-lg border border-sand/30 bg-softCream p-lg shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="font-serif text-h2">Edit shift</h2>
              <p className="mt-xs text-small text-stone/60">
                Originally assigned to {editing.user.full_name}
              </p>
              <form onSubmit={onSaveEdit} className="mt-md space-y-md">
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">Starts</span>
                  <input
                    type="datetime-local"
                    value={editStarts}
                    onChange={(e) => setEditStarts(e.target.value)}
                    required
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">Ends</span>
                  <input
                    type="datetime-local"
                    value={editEnds}
                    onChange={(e) => setEditEnds(e.target.value)}
                    required
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">
                    Assigned to
                  </span>
                  <select
                    value={editUserId}
                    onChange={(e) => setEditUserId(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  >
                    {users
                      .filter(
                        (u) =>
                          u.is_active &&
                          (editBypassAvail ||
                            availableUserIds === null ||
                            availableUserIds.has(u.id)),
                      )
                      .sort((a, b) => a.full_name.localeCompare(b.full_name))
                      .map((u) => {
                        const busy =
                          availableUserIds !== null && !availableUserIds.has(u.id);
                        return (
                          <option key={u.id} value={u.id}>
                            {u.full_name}
                            {u.id === editing.user_id ? " · current" : ""}
                            {busy ? " · unavailable" : ""}
                          </option>
                        );
                      })}
                  </select>
                  <label className="mt-sm flex items-center gap-sm text-tiny text-stone/70">
                    <input
                      type="checkbox"
                      checked={editBypassAvail}
                      onChange={(e) => setEditBypassAvail(e.target.checked)}
                    />
                    <span>Show all staff (override availability)</span>
                  </label>
                  <span className="mt-xs block text-tiny text-stone/60">
                    {editBypassAvail
                      ? "Listing everyone. Picking an unavailable staff member will ask you to confirm."
                      : "Only staff free during this window are listed. Adjust the time above or tick the box to override."}
                  </span>
                </label>
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">Location</span>
                  <select
                    value={editLocation}
                    onChange={(e) => setEditLocation(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  >
                    <option value="toronto">Toronto</option>
                    <option value="wavecrest">Wavecrest</option>
                  </select>
                </label>
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">Role</span>
                  <input
                    value={editRoleLabel}
                    onChange={(e) => setEditRoleLabel(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <label className="block text-small">
                  <span className="text-tiny uppercase tracking-widest text-clay">Notes</span>
                  <input
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
                  />
                </label>
                <div className="flex items-center justify-between gap-sm">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!editing) return;
                      if (!confirm(`Delete this shift permanently?\n\n${editing.user.full_name} · ${fmtTime(editing.starts_at)}–${fmtTime(editing.ends_at)}\n\nUse "Cancel" on the card if you want to keep a record.`)) return;
                      try {
                        await deleteShift(editing.id);
                        setEditing(null);
                        setSuccess("Shift deleted.");
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    className="text-small text-critical hover:underline"
                  >
                    Delete shift
                  </button>
                  <div className="flex gap-sm">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-sm border border-sand px-md py-sm text-small hover:bg-sand/20"
                    >
                      Close
                    </button>
                    <button
                      type="submit"
                      className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function StaffGrid({
  users,
  days,
  shiftsByUserDay,
  timeOffByUser,
  onShiftClick,
  onCellClick,
}: {
  users: AdminUser[];
  days: Date[];
  shiftsByUserDay: Record<string, ShiftWithStaff[]>;
  timeOffByUser: Record<string, TimeOffRequest[]>;
  onShiftClick: (s: ShiftWithStaff) => void;
  onCellClick: (userId: string, day: Date) => void;
}) {
  if (users.length === 0) {
    return (
      <div className="rounded-md border border-sand/30 bg-softCream p-lg text-center text-small text-stone/60">
        No active staff to schedule.
      </div>
    );
  }
  const todayKey = new Date().toDateString();
  return (
    <div className="overflow-x-auto rounded-md border border-sand/30 bg-softCream">
      <table className="w-full border-separate border-spacing-0 text-small">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-softCream px-md py-sm text-left text-tiny uppercase tracking-widest text-clay border-b border-sand/30">
              Staff
            </th>
            {days.map((d, i) => {
              const isToday = d.toDateString() === todayKey;
              return (
                <th
                  key={d.toISOString()}
                  className={`min-w-32 px-md py-sm text-left text-tiny uppercase tracking-widest border-b border-sand/30 ${
                    isToday ? "bg-terracotta/5 text-terracotta" : "bg-softCream text-clay"
                  }`}
                >
                  {DAY_LABEL[i]} · {d.getDate()}
                </th>
              );
            })}
            <th className="px-md py-sm text-right text-tiny uppercase tracking-widest text-clay border-b border-sand/30 bg-softCream">
              Wk total
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u, rowIdx) => {
            const weekShifts = days.flatMap(
              (d) => shiftsByUserDay[`${u.id}|${d.toDateString()}`] ?? [],
            );
            const weekMins = totalMinutes(weekShifts);
            return (
            <tr key={u.id} className={rowIdx % 2 === 0 ? "" : "bg-warmWhite/40"}>
              <th
                scope="row"
                className="sticky left-0 z-10 bg-inherit px-md py-sm text-left align-top border-b border-sand/20"
              >
                <Link
                  href={`/admin/staff/${u.id}`}
                  className="block font-medium text-stone hover:text-terracotta hover:underline"
                >
                  {u.full_name}
                </Link>
                <span className="text-tiny text-stone/50">{u.email}</span>
                {(() => {
                  // OOO ranges overlapping this visible week, listed
                  // individually. Critical: do NOT collapse non-consecutive
                  // requests into a single "min-start → max-end" span.
                  const ranges = timeOffByUser[u.id] ?? [];
                  if (ranges.length === 0) return null;
                  return (
                    <span
                      className="mt-xs block text-tiny text-stone/60"
                      title={ranges
                        .map((r) => fmtTimeOffRange(r.start_date, r.end_date))
                        .join(", ")}
                    >
                      OOO{" "}
                      {ranges
                        .map((r) => fmtTimeOffRange(r.start_date, r.end_date))
                        .join(", ")}
                    </span>
                  );
                })()}
              </th>
              {days.map((d) => {
                const dayKey = d.toDateString();
                const cellShifts = shiftsByUserDay[`${u.id}|${dayKey}`] ?? [];
                return (
                  <td
                    key={d.toISOString()}
                    className="border-b border-sand/20 align-top p-xs"
                  >
                    {cellShifts.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => onCellClick(u.id, d)}
                        className="group flex h-full min-h-12 w-full items-center justify-center rounded-sm border border-dashed border-sand/40 bg-warmWhite/30 text-tiny text-stone/30 hover:border-terracotta/60 hover:bg-warmWhite hover:text-terracotta"
                        aria-label={`Add shift for ${u.full_name} on ${dayKey}`}
                      >
                        <span className="opacity-0 group-hover:opacity-100">+ add</span>
                      </button>
                    ) : (
                      <div className="space-y-xs">
                        {cellShifts.map((s) => {
                          const cancelled = s.status === "cancelled";
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => onShiftClick(s)}
                              title={`${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}${
                                s.role_label ? " · " + s.role_label : ""
                              }${s.notes ? "\n" + s.notes : ""}`}
                              className={`block w-full rounded-sm bg-warmWhite px-sm py-xs text-left text-tiny hover:bg-sand/30 ${
                                cancelled ? "text-stone/40 line-through" : "text-stone"
                              }`}
                            >
                              <span className="font-mono text-clay">{fmtTime(s.starts_at)}</span>
                              <span className="ml-xs">–</span>
                              <span className="ml-xs font-mono text-stone/60">{fmtTime(s.ends_at)}</span>
                              {s.role_label && (
                                <div className="mt-xs text-stone/60">{s.role_label}</div>
                              )}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => onCellClick(u.id, d)}
                          className="block w-full rounded-sm border border-dashed border-sand/40 px-sm py-xs text-tiny text-stone/40 hover:border-terracotta/60 hover:text-terracotta"
                        >
                          +
                        </button>
                      </div>
                    )}
                  </td>
                );
              })}
              <td className="border-b border-sand/20 px-md py-sm text-right align-top font-mono text-tiny text-stone/70">
                {weekMins === 0 ? "—" : fmtHours(weekMins)}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function SchedulePage() {
  return (
    <AuthGate>
      <Inner />
    </AuthGate>
  );
}
