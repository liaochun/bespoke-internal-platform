// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * FilterableTh — drop-in <th> replacement that adds a per-column filter
 * popover (text search, checkbox list of distinct values, or a numeric
 * comparison), for use with the `useColumnFilters` hook.
 *
 * Usage (text column):
 *   <FilterableTh
 *     label="Item"
 *     filter={{ type: "text", value: filters.name?.value ?? "", onChange: (v) => setTextFilter("name", v) }}
 *   />
 *
 * Usage (select column):
 *   <FilterableTh
 *     label="Status"
 *     filter={{
 *       type: "select",
 *       options: distinctValues.status ?? [],
 *       selected: filters.status?.type === "select" ? filters.status.values : new Set(),
 *       onToggle: (v) => toggleSelectValue("status", v),
 *       onClear: () => clearFilter("status"),
 *     }}
 *   />
 *
 * Usage (number column):
 *   <FilterableTh
 *     label="Qty"
 *     filter={{
 *       type: "number",
 *       operator: filters.qty?.type === "number" ? filters.qty.operator : "gte",
 *       value: filters.qty?.type === "number" ? filters.qty.value : null,
 *       value2: filters.qty?.type === "number" ? filters.qty.value2 : null,
 *       onChange: (patch) => setNumberFilter("qty", patch),
 *       onClear: () => clearFilter("qty"),
 *     }}
 *   />
 *
 * Columns that shouldn't be filterable (e.g. an actions column) just omit `filter`.
 *
 * Sorting (optional, independent of `filter` — pairs with `useTableSort`):
 *   <FilterableTh
 *     label="Qty"
 *     sort={{
 *       direction: sortState?.id === "qty" ? sortState.direction : null,
 *       onToggle: () => toggleSort("qty"),
 *     }}
 *   />
 * When `sort` is present the label becomes a clickable button that cycles
 * unsorted -> asc -> desc -> unsorted, with an arrow glyph reflecting the
 * current direction. Omit `sort` for non-sortable columns.
 *
 * Drag-to-reorder (optional, independent of `filter`/`sort` — pairs with
 * `useTableColumns`):
 *   <FilterableTh
 *     label="Qty"
 *     drag={{
 *       onDragStart: onDragStart(col.id),
 *       onDragOver: onDragOver(col.id),
 *       onDrop: onDrop(col.id),
 *       onDragEnd,
 *       isDragOver: dragOverId === col.id,
 *       isDragging: draggingId === col.id,
 *     }}
 *   />
 * When `drag` is present the `<th>` itself becomes `draggable`, using the
 * same visual convention `useTableColumns`' own consumers use elsewhere
 * (reduced opacity while dragging, a terracotta left-border while another
 * column is dragged over this one). Omit `drag` for non-reorderable columns.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { NumberFilterState, NumberOperator } from "@/lib/useColumnFilters";

export type TextColumnFilter = {
  type: "text";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export type SelectColumnFilter = {
  type: "select";
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
  onSelectAll?: () => void;
  /** Optional display formatter for raw option values (e.g. codes -> labels). */
  formatOption?: (value: string) => string;
};

export type NumberColumnFilter = {
  type: "number";
  operator: NumberOperator;
  value: number | null;
  value2: number | null;
  onChange: (patch: Partial<Omit<NumberFilterState, "type">>) => void;
  onClear: () => void;
};

export type ColumnFilter = TextColumnFilter | SelectColumnFilter | NumberColumnFilter;

export type ColumnSort = {
  /** Current sort direction for this column, or `null` when not the active sort column. */
  direction: "asc" | "desc" | null;
  /** Cycles this column: unsorted -> asc -> desc -> unsorted. */
  onToggle: () => void;
};

export type ColumnDrag = {
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** True while another column is being dragged over this one. */
  isDragOver?: boolean;
  /** True while this column itself is the one being dragged. */
  isDragging?: boolean;
};

const NUMBER_OPERATORS: { value: NumberOperator; label: string }[] = [
  { value: "gte", label: "≥ (at least)" },
  { value: "gt", label: "> (more than)" },
  { value: "lte", label: "≤ (at most)" },
  { value: "lt", label: "< (less than)" },
  { value: "eq", label: "= (exactly)" },
  { value: "neq", label: "≠ (not)" },
  { value: "between", label: "between" },
];

type Props = {
  label: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  filter?: ColumnFilter;
  sort?: ColumnSort;
  drag?: ColumnDrag;
};

export function FilterableTh({
  label,
  align = "left",
  className = "",
  filter,
  sort,
  drag,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 224 });
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Position via a portal to <body> with `position: fixed`, computed from
  // the trigger button and clamped to the viewport -- otherwise an
  // `absolute`-positioned popover inside a horizontally-scrolling wide
  // table gets clipped by the table's overflow container and can render
  // partially off-screen for columns near the table's edges.
  useLayoutEffect(() => {
    if (!open) return;
    const buttonRect = buttonRef.current?.getBoundingClientRect();
    if (!buttonRect) return;
    const panelRect = popoverRef.current?.getBoundingClientRect();
    const width = panelRect?.width ?? 224;
    const height = panelRect?.height ?? 0;
    const margin = 8;
    let left = buttonRect.left;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    let top = buttonRect.bottom + 4;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, buttonRect.top - height - 4);
    }
    setPos((prev) =>
      prev.top === top && prev.left === left && prev.width === width
        ? prev
        : { top, left, width },
    );
  });

  const isActive =
    filter?.type === "text"
      ? filter.value.trim().length > 0
      : filter?.type === "number"
        ? filter.value !== null
        : (filter?.selected.size ?? 0) > 0;

  const visibleOptions =
    filter?.type === "select"
      ? filter.options.filter((o) =>
          (filter.formatOption ? filter.formatOption(o) : o)
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
      : [];

  return (
    <th
      aria-sort={
        sort?.direction === "asc"
          ? "ascending"
          : sort?.direction === "desc"
            ? "descending"
            : undefined
      }
      draggable={!!drag}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      className={`relative px-md py-sm font-medium ${
        align === "right" ? "text-right" : "text-left"
      } ${drag ? "cursor-grab select-none" : ""} ${drag?.isDragging ? "opacity-50" : ""} ${
        drag?.isDragOver ? "border-l-2 border-terracotta" : ""
      } ${className}`}
    >
      <div className={`flex items-center gap-xs ${align === "right" ? "justify-end" : ""}`}>
        {sort ? (
          <button
            type="button"
            onClick={sort.onToggle}
            aria-label={`Sort by ${typeof label === "string" ? label : "column"}`}
            className={`inline-flex items-center gap-[3px] transition-colors hover:text-terracotta ${
              sort.direction ? "text-terracotta" : ""
            }`}
          >
            <span>{label}</span>
            {sort.direction && <SortArrowIcon direction={sort.direction} />}
          </button>
        ) : (
          <span>{label}</span>
        )}
        {filter && (
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={open}
            aria-label={`Filter ${typeof label === "string" ? label : "column"}`}
            className={`shrink-0 rounded-sm p-[2px] transition-colors ${
              isActive ? "text-terracotta" : "text-stone/40 hover:text-terracotta"
            }`}
          >
            <FilterIcon filled={isActive} />
          </button>
        )}
      </div>

      {open && filter && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Filter options for ${typeof label === "string" ? label : "column"}`}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="rounded-md border border-sand/50 bg-warmWhite text-left font-normal normal-case tracking-normal text-stone shadow-lg"
        >
          {filter.type === "text" ? (
            <div className="p-sm">
              <input
                type="text"
                autoFocus
                value={filter.value}
                onChange={(e) => filter.onChange(e.target.value)}
                placeholder={filter.placeholder ?? "Contains…"}
                className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
              />
              {filter.value && (
                <button
                  type="button"
                  onClick={() => filter.onChange("")}
                  className="mt-xs w-full rounded-sm border border-sand py-[3px] text-tiny font-medium text-clay hover:bg-sand/20"
                >
                  Clear filter
                </button>
              )}
            </div>
          ) : filter.type === "number" ? (
            <div className="space-y-xs p-sm">
              <select
                value={filter.operator}
                onChange={(e) =>
                  filter.onChange({ operator: e.target.value as NumberOperator })
                }
                className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
              >
                {NUMBER_OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                autoFocus
                value={filter.value ?? ""}
                onChange={(e) =>
                  filter.onChange({
                    value: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                placeholder={filter.operator === "between" ? "From" : "Value"}
                className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
              />
              {filter.operator === "between" && (
                <input
                  type="number"
                  value={filter.value2 ?? ""}
                  onChange={(e) =>
                    filter.onChange({
                      value2: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="To"
                  className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
                />
              )}
              {filter.value !== null && (
                <button
                  type="button"
                  onClick={filter.onClear}
                  className="w-full rounded-sm border border-sand py-[3px] text-tiny font-medium text-clay hover:bg-sand/20"
                >
                  Clear filter
                </button>
              )}
            </div>
          ) : (
            <>
              {filter.options.length > 8 && (
                <div className="border-b border-sand/30 p-sm">
                  <input
                    type="text"
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search values…"
                    className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-xs text-small focus:outline-none focus:border-terracotta"
                  />
                </div>
              )}
              <ul className="max-h-64 overflow-y-auto py-xs">
                {visibleOptions.length === 0 ? (
                  <li className="px-md py-sm text-tiny text-stone/50">No values</li>
                ) : (
                  visibleOptions.map((opt) => {
                    const checked = filter.selected.has(opt);
                    const displayLabel = filter.formatOption ? filter.formatOption(opt) : opt;
                    return (
                      <li key={opt}>
                        <label className="flex cursor-pointer items-center gap-sm px-md py-xs text-small hover:bg-softCream">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => filter.onToggle(opt)}
                            className="shrink-0"
                          />
                          <span className="truncate">{displayLabel || "(blank)"}</span>
                        </label>
                      </li>
                    );
                  })
                )}
              </ul>
              <div className="flex gap-xs border-t border-sand/30 p-sm">
                {filter.onSelectAll && (
                  <button
                    type="button"
                    onClick={filter.onSelectAll}
                    className="flex-1 rounded-sm border border-sand py-[3px] text-tiny font-medium text-clay hover:bg-sand/20"
                  >
                    Select all
                  </button>
                )}
                <button
                  type="button"
                  onClick={filter.onClear}
                  disabled={filter.selected.size === 0}
                  className="flex-1 rounded-sm border border-sand py-[3px] text-tiny font-medium text-clay hover:bg-sand/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </th>
  );
}

function FilterIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M1.5 2h11l-4 5v4.5l-3 1.5V7l-4-5z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortArrowIcon({ direction }: { direction: "asc" | "desc" }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={direction === "desc" ? "rotate-180" : ""}
    >
      <path
        d="M7 2.5l4.5 6.5h-9L7 2.5z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
