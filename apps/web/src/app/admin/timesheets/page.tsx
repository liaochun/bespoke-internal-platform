// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useMemo, useState } from "react";

import { AuthGate, useCurrentUser } from "@/components/AuthGate";
import { CapabilityGate } from "@/components/CapabilityGate";
import { FilterableTh } from "@/components/FilterableTh";
import { CAP, has } from "@/lib/capabilities";
import { fmtMinutes, fmtTime } from "@/lib/format";
import { useColumnFilters, type ColumnFilterConfig } from "@/lib/useColumnFilters";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { Header } from "@/components/Header";
import {
  adminCreatePunch,
  adminUpdatePunch,
  AdminUser,
  adminListUsers,
  DispatchConfig,
  DispatchRule,
  fetchDispatchConfig,
  OpenPair,
  previewTimesheet,
  TimesheetPreview,
  TimesheetRow,
  timesheetCsvUrl,
  triggerTimesheetDispatch,
  updateDispatchConfig,
} from "@/lib/api";

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (k: number) => String(k).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// fmtMinutes / fmtTime imported from @/lib/format below.

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

type SortKey = "staff" | "date" | "in" | "out" | "hours" | "location";
type SortDir = "asc" | "desc";

function SortLabel({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey | null;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="inline-flex items-center gap-[2px] hover:text-terracotta transition-colors"
    >
      {label}
      {active === sortKey ? (dir === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );
}

function Inner() {
  useDocumentTitle("Timesheets");
  const me = useCurrentUser();
  const canEditDispatch = me?.role === "super_admin";
  const canEditPunches = has(me, CAP.edit_others_punches);
  const [tab, setTab] = useState<"report" | "autoemail">("report");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [start, setStart] = useState<string>(daysAgo(13));
  const [end, setEnd] = useState<string>(todayLocal());
  const [userId, setUserId] = useState<string>("");
  const [data, setData] = useState<TimesheetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  const params = useMemo(
    () => ({ start, end, user_id: userId || undefined }),
    [start, end, userId],
  );

  const refresh = async () => {
    setError(null);
    setUsersError(null);
    setLoading(true);
    // Independent requests: the named-staff filter (adminListUsers, needs
    // view_users) is a convenience on top of the core timesheet data
    // (previewTimesheet, needs only view_timesheets/export_timesheets --
    // what every role that can reach this page already has). A role like
    // accountant that lacks view_users must still see and export its
    // timesheet data; it just loses the "filter by named person" dropdown.
    const [uResult, pResult] = await Promise.allSettled([
      adminListUsers(true),
      previewTimesheet(params),
    ]);
    if (uResult.status === "fulfilled") {
      setUsers(uResult.value);
    } else {
      setUsersError((uResult.reason as Error).message);
    }
    if (pResult.status === "fulfilled") {
      setData(pResult.value);
    } else {
      setError((pResult.reason as Error).message);
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, userId]);

  const csvHref = timesheetCsvUrl(params);

  const rowColumns: ColumnFilterConfig<TimesheetRow>[] = useMemo(
    () => [
      { id: "staff", label: "Staff", type: "select", accessor: (r) => r.staff_name },
      { id: "date", label: "Date", type: "select", accessor: (r) => r.work_date },
      { id: "in", label: "In", type: "text", accessor: (r) => fmtTime(r.clock_in) },
      { id: "out", label: "Out", type: "text", accessor: (r) => fmtTime(r.clock_out) },
      { id: "hours", label: "Hours", type: "number", accessor: (r) => Math.round((r.minutes / 60) * 100) / 100 },
      { id: "location", label: "Location", type: "select", accessor: (r) => r.location },
    ],
    [],
  );

  const {
    filteredRows,
    filters,
    distinctValues,
    setTextFilter,
    toggleSelectValue,
    setNumberFilter,
    clearFilter,
  } = useColumnFilters(data?.rows ?? [], rowColumns);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return filteredRows;
    const rows = [...filteredRows];
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "staff":
          cmp = a.staff_name.localeCompare(b.staff_name);
          break;
        case "date":
          cmp = a.work_date.localeCompare(b.work_date) || a.clock_in.localeCompare(b.clock_in);
          break;
        case "in":
          cmp = a.clock_in.localeCompare(b.clock_in);
          break;
        case "out":
          cmp = a.clock_out.localeCompare(b.clock_out);
          break;
        case "hours":
          cmp = a.minutes - b.minutes;
          break;
        case "location":
          cmp = a.location.localeCompare(b.location);
          break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return rows;
  }, [filteredRows, sortKey, sortDir]);

  const filteredMinutes = useMemo(
    () => filteredRows.reduce((sum, r) => sum + r.minutes, 0),
    [filteredRows],
  );

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-lg py-2xl space-y-2xl">
        <header>
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">Workforce</p>
          <h1 className="mt-sm font-serif text-display text-stone">Timesheets</h1>
          <p className="mt-md text-small text-stone/70">
            Hours worked from clock-in/clock-out punches. Times shown in your browser TZ; day boundaries follow {data?.timezone ?? "Toronto"}.
          </p>
        </header>

        {error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}
        {success && (
          <div className="flex items-center gap-sm rounded-md border border-success/40 bg-success/10 p-md text-small text-stone">
            <span className="text-success">✓</span>
            <span>{success}</span>
          </div>
        )}

        <div className="flex gap-xs border-b border-sand/30 pb-sm">
          <button
            type="button"
            onClick={() => setTab("report")}
            className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
              tab === "report"
                ? "bg-terracotta text-warmWhite"
                : "text-stone/60 hover:bg-sand/20"
            }`}
          >
            Timesheets
          </button>
          {canEditDispatch && (
            <button
              type="button"
              onClick={() => setTab("autoemail")}
              className={`rounded-full px-md py-xs text-tiny uppercase tracking-widest ${
                tab === "autoemail"
                  ? "bg-terracotta text-warmWhite"
                  : "text-stone/60 hover:bg-sand/20"
              }`}
            >
              Auto-email
            </button>
          )}
        </div>

        {tab === "autoemail" && canEditDispatch && <DispatchSettings />}

        {tab === "report" && (
        <>
        <section className="rounded-md border border-sand/30 bg-softCream p-lg">
          <div className="grid gap-md md:grid-cols-4">
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">From</span>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">To</span>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
              />
            </label>
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Staff</span>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
              >
                <option value="">All staff</option>
                {usersError && (
                  <option value="" disabled>
                    (Named staff filter unavailable)
                  </option>
                )}
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <a
                href={csvHref}
                download
                className={`w-full text-center rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite transition-opacity duration-fast ease-northbound hover:opacity-90 ${
                  !data || data.rows.length === 0 ? "pointer-events-none opacity-50" : ""
                }`}
              >
                Download CSV
              </a>
            </div>
          </div>

          <div className="mt-md flex flex-wrap gap-sm text-tiny uppercase tracking-widest">
            {[
              { label: "Last 7d", days: 6 },
              { label: "Last 14d", days: 13 },
              { label: "Last 30d", days: 29 },
              { label: "This week", days: -1 },
              { label: "This month", days: -2 },
              { label: "Last month", days: -3 },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const pad = (k: number) => String(k).padStart(2, "0");
                  const fmt = (d: Date) =>
                    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                  if (p.days === -1) {
                    const d = new Date();
                    const offset = (d.getDay() + 6) % 7;
                    d.setDate(d.getDate() - offset);
                    setStart(fmt(d));
                    setEnd(todayLocal());
                  } else if (p.days === -2) {
                    const now = new Date();
                    const first = new Date(now.getFullYear(), now.getMonth(), 1);
                    setStart(fmt(first));
                    setEnd(todayLocal());
                  } else if (p.days === -3) {
                    const now = new Date();
                    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    const last = new Date(now.getFullYear(), now.getMonth(), 0);
                    setStart(fmt(first));
                    setEnd(fmt(last));
                  } else {
                    setStart(daysAgo(p.days));
                    setEnd(todayLocal());
                  }
                }}
                className="rounded-full border border-sand px-md py-xs text-clay hover:border-terracotta"
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>

        {data && data.open_pairs.length > 0 && (
          <section className="rounded-md border border-warning/40 bg-warning/10 p-lg">
            <h2 className="font-serif text-h3 text-stone">
              {data.open_pairs.length} unclosed clock-in{data.open_pairs.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-xs text-small text-stone/70">
              These won&apos;t appear in the export. Close them out manually to capture the hours,
              or use the corrections queue if a staff member has requested a fix.
            </p>
            <ul className="mt-md space-y-md text-small">
              {data.open_pairs.map((o) => (
                <CloseOpenPairRow
                  key={`${o.user_id}-${o.clocked_in_at}`}
                  pair={o}
                  onClosed={async (msg) => {
                    setSuccess(msg);
                    await refresh();
                  }}
                  onError={(msg) => setError(msg)}
                />
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-md border border-sand/30 bg-softCream">
          <header className="flex flex-wrap items-baseline justify-between gap-md px-lg pt-lg">
            <h2 className="font-serif text-h2">
              {!data
                ? "Loading…"
                : filteredRows.length === data.rows.length
                  ? `${data.rows.length} entr${data.rows.length === 1 ? "y" : "ies"}`
                  : `${filteredRows.length} of ${data.rows.length} entries`}
            </h2>
            {data && (
              <p className="font-mono text-h2 text-terracotta">{fmtMinutes(filteredMinutes)}</p>
            )}
          </header>
          {loading ? (
            <p className="px-lg py-md text-small text-stone/60">Loading…</p>
          ) : !data || data.rows.length === 0 ? (
            <p className="px-lg py-md text-small text-stone/60">
              No closed clock-in/out pairs in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead className="bg-warmWhite text-tiny uppercase tracking-widest text-clay">
                  <tr>
                    <FilterableTh
                      label={<SortLabel label="Staff" sortKey="staff" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      filter={{
                        type: "select",
                        options: distinctValues.staff ?? [],
                        selected: filters.staff?.type === "select" ? filters.staff.values : new Set(),
                        onToggle: (v) => toggleSelectValue("staff", v),
                        onClear: () => clearFilter("staff"),
                      }}
                    />
                    <FilterableTh
                      label={<SortLabel label="Date" sortKey="date" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      filter={{
                        type: "select",
                        options: distinctValues.date ?? [],
                        selected: filters.date?.type === "select" ? filters.date.values : new Set(),
                        onToggle: (v) => toggleSelectValue("date", v),
                        onClear: () => clearFilter("date"),
                        formatOption: (v) => fmtDate(v),
                      }}
                    />
                    <FilterableTh
                      label={<SortLabel label="In" sortKey="in" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      filter={{
                        type: "text",
                        value: filters.in?.type === "text" ? filters.in.value : "",
                        onChange: (v) => setTextFilter("in", v),
                      }}
                    />
                    <FilterableTh
                      label={<SortLabel label="Out" sortKey="out" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      filter={{
                        type: "text",
                        value: filters.out?.type === "text" ? filters.out.value : "",
                        onChange: (v) => setTextFilter("out", v),
                      }}
                    />
                    <FilterableTh
                      label={<SortLabel label="Hours" sortKey="hours" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      align="right"
                      filter={{
                        type: "number",
                        operator: filters.hours?.type === "number" ? filters.hours.operator : "gte",
                        value: filters.hours?.type === "number" ? filters.hours.value : null,
                        value2: filters.hours?.type === "number" ? filters.hours.value2 : null,
                        onChange: (patch) => setNumberFilter("hours", patch),
                        onClear: () => clearFilter("hours"),
                      }}
                    />
                    <FilterableTh
                      label={<SortLabel label="Location" sortKey="location" active={sortKey} dir={sortDir} onSort={toggleSort} />}
                      filter={{
                        type: "select",
                        options: distinctValues.location ?? [],
                        selected: filters.location?.type === "select" ? filters.location.values : new Set(),
                        onToggle: (v) => toggleSelectValue("location", v),
                        onClear: () => clearFilter("location"),
                      }}
                    />
                    {canEditPunches && <Th />}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={canEditPunches ? 7 : 6} className="px-lg py-md text-small text-stone/60">
                        No entries match the current filters.
                      </td>
                    </tr>
                  ) : (
                    sortedRows.map((r) => (
                      <TimesheetEntryRow
                        key={`${r.clock_in_punch_id}-${r.clock_out_punch_id}`}
                        row={r}
                        canEdit={canEditPunches}
                        onSaved={async () => { await refresh(); }}
                        onError={(msg) => setError(msg)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
        </>
        )}
      </main>
    </>
  );
}

function currentMonthLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

type SendPeriodMode = "recent" | "first_half" | "second_half" | "custom";

function halfMonthRange(monthStr: string, half: "first" | "second"): { start: string; end: string } {
  const [y, m] = monthStr.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (half === "first") {
    return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-15` };
  }
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${y}-${pad(m)}-16`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TimesheetEntryRow({
  row,
  canEdit,
  onSaved,
  onError,
}: {
  row: TimesheetRow;
  canEdit: boolean;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [inAt, setInAt] = useState(toLocalInput(row.clock_in));
  const [outAt, setOutAt] = useState(toLocalInput(row.clock_out));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setInAt(toLocalInput(row.clock_in));
    setOutAt(toLocalInput(row.clock_out));
    setReason("");
    setEditing(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const inIso = new Date(inAt).toISOString();
      const outIso = new Date(outAt).toISOString();
      if (new Date(inIso) >= new Date(outIso)) {
        onError("Clock-out must be after clock-in.");
        setBusy(false);
        return;
      }
      await Promise.all([
        adminUpdatePunch(row.clock_in_punch_id, { punched_at: inIso, reason: reason || undefined }),
        adminUpdatePunch(row.clock_out_punch_id, { punched_at: outIso, reason: reason || undefined }),
      ]);
      setEditing(false);
      await onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <>
        <tr className="border-t border-sand/30 bg-sand/10">
          <Td>{row.staff_name}</Td>
          <Td>{fmtDate(row.work_date)}</Td>
          <Td>
            <input
              type="datetime-local"
              value={inAt}
              onChange={(e) => setInAt(e.target.value)}
              className="rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-tiny focus:outline-none focus:border-terracotta"
            />
          </Td>
          <Td>
            <input
              type="datetime-local"
              value={outAt}
              onChange={(e) => setOutAt(e.target.value)}
              className="rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-tiny focus:outline-none focus:border-terracotta"
            />
          </Td>
          <Td align="right" className="font-mono text-stone/40">—</Td>
          <Td className="capitalize text-stone/60">{row.location}</Td>
          <Td>
            <div className="flex gap-xs">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-sm bg-terracotta px-sm py-xs text-tiny font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="rounded-sm border border-sand px-sm py-xs text-tiny text-stone/60 hover:border-terracotta disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </Td>
        </tr>
        <tr className="border-sand/30 bg-sand/10">
          <Td colSpan={7}>
            <label className="flex items-center gap-sm text-tiny">
              <span className="uppercase tracking-widest text-clay">Reason</span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Optional note"
                className="flex-1 rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
              />
            </label>
          </Td>
        </tr>
      </>
    );
  }

  return (
    <tr className="border-t border-sand/30">
      <Td>{row.staff_name}</Td>
      <Td>{fmtDate(row.work_date)}</Td>
      <Td className="font-mono">{fmtTime(row.clock_in)}</Td>
      <Td className="font-mono">{fmtTime(row.clock_out)}</Td>
      <Td align="right" className="font-mono">{fmtMinutes(row.minutes)}</Td>
      <Td className="capitalize text-stone/60">{row.location}</Td>
      {canEdit && (
        <Td>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-tiny text-terracotta hover:underline"
          >
            Edit
          </button>
        </Td>
      )}
    </tr>
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-lg py-sm font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
function Td({
  children,
  align = "left",
  className = "",
  colSpan,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-lg py-sm align-middle ${align === "right" ? "text-right" : ""} ${className}`}
    >
      {children}
    </td>
  );
}

function CloseOpenPairRow({
  pair,
  onClosed,
  onError,
}: {
  pair: OpenPair;
  onClosed: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  // Default proposed clock-out: 8 hours after clock-in, capped to "now"
  const proposed = (() => {
    const start = new Date(pair.clocked_in_at);
    const eight = new Date(start.getTime() + 8 * 60 * 60 * 1000);
    const now = new Date();
    const target = eight < now ? eight : now;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
  })();

  const [outAt, setOutAt] = useState<string>(proposed);
  const [busy, setBusy] = useState(false);

  const onClose = async () => {
    setBusy(true);
    try {
      await adminCreatePunch({
        user_id: pair.user_id,
        punch_type: "clock_out",
        punched_at: new Date(outAt).toISOString(),
        location: pair.location,
        reason: "Closed out by manager from timesheet view",
      });
      await onClosed(`Closed out ${pair.staff_name}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-sm bg-warmWhite px-md py-md">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <p>
          <strong>{pair.staff_name}</strong>{" "}
          <span className="text-stone/60">
            — clocked in {new Date(pair.clocked_in_at).toLocaleString()}
          </span>
        </p>
        <span className="text-tiny uppercase tracking-widest text-warning capitalize">
          {pair.location}
        </span>
      </div>
      <div className="mt-md flex flex-wrap items-end gap-sm">
        <label className="block text-small">
          <span className="text-tiny uppercase tracking-widest text-clay">Clock-out time</span>
          <input
            type="datetime-local"
            value={outAt}
            onChange={(e) => setOutAt(e.target.value)}
            className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
          />
        </label>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Closing…" : "Close out"}
        </button>
      </div>
    </li>
  );
}

// Admin-editable auto-dispatch settings: who receives the semi-monthly
// timesheet email and on which two days it sends. Gated on export_timesheets.
function DispatchSettings() {
  const me = useCurrentUser();
  const canEdit = me?.role === "super_admin";

  const [cfg, setCfg] = useState<DispatchConfig | null>(null);
  const [recipientsText, setRecipientsText] = useState("");
  const [rules, setRules] = useState<DispatchRule[]>([
    { send_day: 8, period_month_offset: -1, period_start_day: 22, period_end_day: 31 },
    { send_day: 22, period_month_offset: 0, period_start_day: 8, period_end_day: 21 },
  ]);
  const [includeAccountants, setIncludeAccountants] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<SendPeriodMode>("recent");
  const [sendMonth, setSendMonth] = useState(currentMonthLocal());
  const [customStart, setCustomStart] = useState(daysAgo(13));
  const [customEnd, setCustomEnd] = useState(todayLocal());

  const updateRule = (i: number, patch: Partial<DispatchRule>) => {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const hydrate = (c: DispatchConfig) => {
    setCfg(c);
    setRecipientsText(c.recipients.join("\n"));
    if (c.rules.length === 2) setRules(c.rules);
    setIncludeAccountants(c.include_accountants);
  };

  useEffect(() => {
    if (!canEdit) return;
    void (async () => {
      try {
        hydrate(await fetchDispatchConfig());
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  if (!canEdit) return null;

  const parseRecipients = () =>
    recipientsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const onSave = async () => {
    setErr(null);
    setMsg(null);
    for (const r of rules) {
      if (r.send_day < 1 || r.send_day > 28) {
        setErr("Send day must be between 1 and 28.");
        return;
      }
      if (r.period_start_day < 1 || r.period_start_day > 31 || r.period_end_day < 1 || r.period_end_day > 31) {
        setErr("Period start/end day must be between 1 and 31.");
        return;
      }
    }
    setBusy(true);
    try {
      hydrate(
        await updateDispatchConfig({
          recipients: parseRecipients(),
          rules,
          include_accountants: includeAccountants,
        }),
      );
      setMsg("Settings saved.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSendNow = async () => {
    let params: { start?: string; end?: string } | undefined;
    let label = "the most recent completed period's";
    if (sendMode === "first_half") {
      const r = halfMonthRange(sendMonth, "first");
      params = r;
      label = `${r.start} – ${r.end}`;
    } else if (sendMode === "second_half") {
      const r = halfMonthRange(sendMonth, "second");
      params = r;
      label = `${r.start} – ${r.end}`;
    } else if (sendMode === "custom") {
      if (customStart > customEnd) {
        setErr("Custom range: from must be on or before to.");
        return;
      }
      params = { start: customStart, end: customEnd };
      label = `${customStart} – ${customEnd}`;
    }
    if (!confirm(`Send the timesheet for ${label} now?`)) return;
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await triggerTimesheetDispatch(params);
      const failed = r.failed ?? [];
      if (r.sent) {
        const partial = failed.length
          ? ` (${failed.length} failed: ${failed.join(", ")})`
          : "";
        setMsg(`Sent for ${r.period} to ${(r.recipients ?? []).length} recipient(s)${partial}.`);
      } else {
        setErr(`Not sent: ${r.reason ?? "unknown"}.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-sand/30 bg-softCream p-lg space-y-md">
      <div>
        <h2 className="font-serif text-h2">Auto-email to accountant / HR</h2>
        <p className="mt-xs text-small text-stone/60">
          The timesheet CSV is emailed automatically on the two days below (Toronto
          time). Each send covers the period since the previous one.
        </p>
      </div>

      {err && (
        <div className="rounded-sm border border-critical/40 bg-critical/10 p-sm text-small text-stone">
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-sm border border-success/40 bg-success/10 p-sm text-small text-stone">
          {msg}
        </div>
      )}

      <div className="grid gap-md md:grid-cols-2">
        <label className="block text-small">
          <span className="text-tiny uppercase tracking-widest text-clay">
            Recipients (one per line)
          </span>
          <textarea
            value={recipientsText}
            onChange={(e) => setRecipientsText(e.target.value)}
            rows={4}
            placeholder="accountant@firm.com&#10;hr@northboundops.example"
            className="mt-xs w-full rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono text-small focus:outline-none focus:border-terracotta"
          />
          <label className="mt-sm flex items-center gap-sm text-tiny text-stone/70">
            <input
              type="checkbox"
              checked={includeAccountants}
              onChange={(e) => setIncludeAccountants(e.target.checked)}
            />
            <span>Also send to every active accountant-role user</span>
          </label>
        </label>

        <div className="space-y-md">
          {rules.map((rule, i) => (
            <div
              key={i}
              className="rounded-sm border border-sand/40 bg-warmWhite p-sm space-y-xs"
            >
              <p className="text-tiny uppercase tracking-widest text-clay">
                {i === 0 ? "First email" : "Second email"}
              </p>
              <div className="flex flex-wrap items-center gap-xs text-small text-stone">
                <span className="text-stone/60">Send</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={rule.send_day}
                  onChange={(e) => updateRule(i, { send_day: Number(e.target.value) })}
                  className="w-16 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:outline-none focus:border-terracotta"
                />
                <span className="text-stone/60">of</span>
                <select
                  value={rule.period_month_offset}
                  onChange={(e) =>
                    updateRule(i, { period_month_offset: Number(e.target.value) as -1 | 0 })
                  }
                  className="rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
                >
                  <option value={-1}>previous month</option>
                  <option value={0}>this month</option>
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-xs text-small text-stone">
                <span className="text-stone/60">From</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={rule.period_start_day}
                  onChange={(e) => updateRule(i, { period_start_day: Number(e.target.value) })}
                  className="w-16 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:outline-none focus:border-terracotta"
                />
                <span className="text-stone/60">to</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={rule.period_end_day}
                  onChange={(e) => updateRule(i, { period_end_day: Number(e.target.value) })}
                  className="w-16 rounded-sm border border-sand bg-warmWhite px-sm py-xs font-mono text-small focus:outline-none focus:border-terracotta"
                />
              </div>
              <p className="text-tiny text-stone/50">
                Sends on day {rule.send_day}: covers day {rule.period_start_day}
                {" → "}
                {rule.period_end_day >= 29 ? "end of" : `day ${rule.period_end_day} of`}{" "}
                {rule.period_month_offset === -1 ? "the previous month" : "this month"}.
              </p>
            </div>
          ))}
          <p className="text-tiny text-stone/50">
            Days 1–28 for "Send on day"; 1–31 for the period (31 safely clamps to
            each month's real last day).{" "}
            {cfg?.last_sent_period
              ? `Last sent: ${cfg.last_sent_period}${cfg.last_sent_at ? ` (${new Date(cfg.last_sent_at).toLocaleString()})` : ""}.`
              : "Nothing sent yet."}
          </p>
        </div>
      </div>

      <div className="space-y-sm rounded-sm border border-sand/30 bg-warmWhite/50 p-md">
        <p className="text-tiny uppercase tracking-widest text-clay">Send now — period</p>
        <div className="flex flex-wrap items-end gap-sm">
          <label className="block text-small">
            <span className="text-tiny uppercase tracking-widest text-clay">Report</span>
            <select
              value={sendMode}
              onChange={(e) => setSendMode(e.target.value as SendPeriodMode)}
              className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm focus:outline-none focus:border-terracotta"
            >
              <option value="recent">Most recent completed period</option>
              <option value="first_half">1st – 15th</option>
              <option value="second_half">16th – end of month</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          {(sendMode === "first_half" || sendMode === "second_half") && (
            <label className="block text-small">
              <span className="text-tiny uppercase tracking-widest text-clay">Month</span>
              <input
                type="month"
                value={sendMonth}
                onChange={(e) => setSendMonth(e.target.value)}
                className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
              />
            </label>
          )}
          {sendMode === "custom" && (
            <>
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">From</span>
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
                />
              </label>
              <label className="block text-small">
                <span className="text-tiny uppercase tracking-widest text-clay">To</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="mt-xs rounded-sm border border-sand bg-warmWhite px-md py-sm font-mono focus:outline-none focus:border-terracotta"
                />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-sm">
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-sm bg-terracotta px-md py-sm text-small font-medium text-warmWhite hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button
          type="button"
          onClick={onSendNow}
          disabled={busy}
          className="rounded-sm border border-stone/30 px-md py-sm text-small text-stone hover:bg-stone/5 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send now"}
        </button>
      </div>
    </section>
  );
}

export default function TimesheetsPage() {
  return (
    <AuthGate>
      <CapabilityGate anyOf={[CAP.view_timesheets, CAP.export_timesheets]}>
        <Inner />
      </CapabilityGate>
    </AuthGate>
  );
}
