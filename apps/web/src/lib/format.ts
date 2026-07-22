// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
/**
 * Shared formatters used across the app.
 *
 * 25+ pages had ad-hoc `fmtDate` / `fmtTime` / `fmtDateTime` helpers with
 * subtle behavior differences. Single source so a formatting tweak (e.g.
 * always show year past Dec 1) lands everywhere.
 *
 * All helpers tolerate null / undefined and return the en-dash placeholder
 * `"—"` in that case, matching the UI's "no value" convention.
 */

const PLACEHOLDER = "—";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return PLACEHOLDER;
  return new Date(iso).toLocaleDateString();
}

export function fmtDateLong(iso: string | null | undefined): string {
  if (!iso) return PLACEHOLDER;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return PLACEHOLDER;
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return PLACEHOLDER;
  return new Date(iso).toLocaleString();
}

export function fmtDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return PLACEHOLDER;
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Round a duration in milliseconds to "Xh Ym" / "Xh" / "Ym" / "0m". */
export function fmtDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Format minutes the same way fmtDuration does. */
export function fmtMinutes(total: number): string {
  if (total <= 0) return "0h";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Elapsed since a starting timestamp, e.g. "3h 14m" — empty if invalid. */
export function fmtElapsed(fromIso: string | null | undefined): string {
  if (!fromIso) return "";
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "";
  const total = Math.floor(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** "$1,234" / "$1,234.50" / "—". Currency prefix configurable. */
export function fmtMoney(
  v: number | null | undefined,
  options: { dp?: number; prefix?: string } = {},
): string {
  if (v === null || v === undefined) return PLACEHOLDER;
  const { dp = 0, prefix = "$" } = options;
  return `${prefix}${v.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

/** Number with optional decimal places. NULL → en-dash. */
export function fmtNum(
  v: number | null | undefined,
  dp = 0,
): string {
  if (v === null || v === undefined) return PLACEHOLDER;
  return Number(v).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * Relative day label: "Today" / "Tomorrow" / weekday name within 7d /
 * "Mon, Mar 5" beyond a week. Used by schedule-style lists where the
 * absolute date is less important than the user's mental position
 * relative to today.
 */
export function fmtRelativeDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
