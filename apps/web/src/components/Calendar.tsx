// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useState } from "react";

const DAY_HEADER = ["M", "T", "W", "T", "F", "S", "S"];

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function startOfWeekMon(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}

export function Calendar({
  value,
  onChange,
  initialMonth,
}: {
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  initialMonth?: Date;
}) {
  const [viewMonth, setViewMonth] = useState<Date>(
    () => initialMonth ?? startOfMonth(new Date()),
  );
  const today = ymd(new Date());

  const firstCell = startOfWeekMon(startOfMonth(viewMonth));
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(firstCell);
    d.setDate(firstCell.getDate() + i);
    cells.push(d);
  }
  // Trim trailing week if entirely outside the displayed month (keeps 5 rows when possible)
  const last = cells[cells.length - 1];
  const lastEom = endOfMonth(viewMonth);
  if (last.getTime() > lastEom.getTime() && cells[cells.length - 7].getTime() > lastEom.getTime()) {
    cells.length = 35;
  }

  const toggleDay = (d: Date) => {
    const key = ymd(d);
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const goPrev = () =>
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const goNext = () =>
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));
  const goToday = () => setViewMonth(startOfMonth(new Date()));

  return (
    <div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          className="rounded-sm border border-sand px-md py-xs text-small hover:bg-sand/20"
          aria-label="Previous month"
        >
          ←
        </button>
        <div className="flex items-center gap-sm">
          <p className="font-serif text-h3">
            {viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </p>
          <button
            type="button"
            onClick={goToday}
            className="rounded-sm border border-sand px-sm py-xs text-tiny uppercase tracking-widest text-clay hover:bg-sand/20"
          >
            Today
          </button>
        </div>
        <button
          type="button"
          onClick={goNext}
          className="rounded-sm border border-sand px-md py-xs text-small hover:bg-sand/20"
          aria-label="Next month"
        >
          →
        </button>
      </div>

      <div className="mt-md grid grid-cols-7 gap-xs text-center text-tiny uppercase tracking-widest text-clay">
        {DAY_HEADER.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div className="mt-xs grid grid-cols-7 gap-xs">
        {cells.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === viewMonth.getMonth();
          const isSelected = value.has(key);
          const isToday = key === today;
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleDay(d)}
              aria-pressed={isSelected}
              className={`aspect-square rounded-sm text-small font-mono transition-colors duration-fast ease-northbound
                ${
                  isSelected
                    ? "bg-terracotta text-warmWhite hover:opacity-90"
                    : inMonth
                      ? "bg-warmWhite text-stone hover:bg-sand/30"
                      : "bg-warmWhite text-stone/30 hover:bg-sand/20"
                }
                ${isToday && !isSelected ? "border border-terracotta" : ""}`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {value.size > 0 && (
        <div className="mt-md flex items-center justify-between text-small">
          <span className="text-stone/70">
            {value.size} day{value.size === 1 ? "" : "s"} selected
          </span>
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="text-tiny uppercase tracking-widest text-clay hover:underline"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
