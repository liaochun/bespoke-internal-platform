// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * useColumnFilters — shared hook for per-column header filtering on admin
 * data tables.
 *
 * Three filter kinds:
 *   - "text"   — substring match against the column's accessor value
 *   - "select" — checkbox list of distinct values present in the data
 *   - "number" — numeric comparison (>=, >, <=, <, =, !=, between)
 *
 * Usage:
 *   const configs: ColumnFilterConfig<Row>[] = [
 *     { id: "name", label: "Item", type: "text", accessor: (r) => r.name },
 *     { id: "status", label: "Status", type: "select", accessor: (r) => r.status },
 *     { id: "qty", label: "Qty", type: "number", accessor: (r) => r.qty },
 *   ];
 *   const { filteredRows, distinctValues, filters, setTextFilter, toggleSelectValue, setNumberFilter, clearFilter, activeCount } =
 *     useColumnFilters(rows, configs);
 *
 *   Render <FilterableTh> per column, passing the matching slice of hook state.
 *   Use `filteredRows` wherever the page currently maps over its rows array.
 */

import { useMemo, useState } from "react";

export type ColumnFilterType = "text" | "select" | "number";

export type NumberOperator = "gte" | "gt" | "lte" | "lt" | "eq" | "neq" | "between";

export type ColumnFilterConfig<T> = {
  id: string;
  label: string;
  type: ColumnFilterType;
  accessor: (row: T) => string | number | null | undefined;
};

type TextFilterState = { type: "text"; value: string };
type SelectFilterState = { type: "select"; values: Set<string> };
export type NumberFilterState = {
  type: "number";
  operator: NumberOperator;
  value: number | null;
  value2: number | null;
};
type FilterState = TextFilterState | SelectFilterState | NumberFilterState;

/**
 * Canonical numeric-comparison matcher. Exported so other filter UIs (e.g.
 * DataGrid's opt-in "number" column filterType) can reuse the exact same
 * matching semantics instead of re-deriving them.
 */
export function matchesNumber(
  raw: string | number | null | undefined,
  state: NumberFilterState,
): boolean {
  if (state.value === null) return true;
  const num = typeof raw === "number" ? raw : raw != null && raw !== "" ? Number(raw) : NaN;
  if (Number.isNaN(num)) return false;
  switch (state.operator) {
    case "gte":
      return num >= state.value;
    case "gt":
      return num > state.value;
    case "lte":
      return num <= state.value;
    case "lt":
      return num < state.value;
    case "eq":
      return num === state.value;
    case "neq":
      return num !== state.value;
    case "between": {
      if (state.value2 === null) return num >= state.value;
      const lo = Math.min(state.value, state.value2);
      const hi = Math.max(state.value, state.value2);
      return num >= lo && num <= hi;
    }
  }
}

export type UseColumnFiltersReturn<T> = {
  filteredRows: T[];
  filters: Record<string, FilterState>;
  /** Distinct string values available for each "select" column, sorted. */
  distinctValues: Record<string, string[]>;
  setTextFilter: (id: string, value: string) => void;
  toggleSelectValue: (id: string, value: string) => void;
  setSelectValues: (id: string, values: Set<string>) => void;
  setNumberFilter: (
    id: string,
    patch: Partial<Omit<NumberFilterState, "type">>,
  ) => void;
  clearFilter: (id: string) => void;
  clearAll: () => void;
  activeCount: number;
};

export function useColumnFilters<T>(
  rows: T[],
  configs: ColumnFilterConfig<T>[],
): UseColumnFiltersReturn<T> {
  const [filters, setFilters] = useState<Record<string, FilterState>>({});

  const distinctValues = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const cfg of configs) {
      if (cfg.type !== "select") continue;
      const set = new Set<string>();
      for (const row of rows) {
        const v = cfg.accessor(row);
        if (v !== null && v !== undefined && v !== "") set.add(String(v));
      }
      map[cfg.id] = [...set].sort((a, b) => a.localeCompare(b));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, configs]);

  const filteredRows = useMemo(() => {
    const activeConfigs = configs.filter((cfg) => filters[cfg.id]);
    if (activeConfigs.length === 0) return rows;
    return rows.filter((row) => {
      for (const cfg of activeConfigs) {
        const state = filters[cfg.id];
        if (!state) continue;
        const raw = cfg.accessor(row);
        if (state.type === "text") {
          const needle = state.value.trim().toLowerCase();
          if (!needle) continue;
          const hay = String(raw ?? "").toLowerCase();
          if (!hay.includes(needle)) return false;
        } else if (state.type === "number") {
          if (state.value === null) continue;
          if (!matchesNumber(raw, state)) return false;
        } else {
          if (state.values.size === 0) continue;
          if (!state.values.has(String(raw ?? ""))) return false;
        }
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, configs, filters]);

  const setTextFilter = (id: string, value: string) => {
    setFilters((prev) => {
      if (!value.trim()) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: { type: "text", value } };
    });
  };

  const toggleSelectValue = (id: string, value: string) => {
    setFilters((prev) => {
      const existing = prev[id];
      const set =
        existing?.type === "select" ? new Set(existing.values) : new Set<string>();
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }
      if (set.size === 0) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: { type: "select", values: set } };
    });
  };

  const setSelectValues = (id: string, values: Set<string>) => {
    setFilters((prev) => {
      if (values.size === 0) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: { type: "select", values } };
    });
  };

  const setNumberFilter = (
    id: string,
    patch: Partial<Omit<NumberFilterState, "type">>,
  ) => {
    setFilters((prev) => {
      const existing = prev[id];
      const base: NumberFilterState =
        existing?.type === "number"
          ? existing
          : { type: "number", operator: "gte", value: null, value2: null };
      const next: NumberFilterState = { ...base, ...patch };
      if (next.value === null) {
        if (!(id in prev)) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      }
      return { ...prev, [id]: next };
    });
  };

  const clearFilter = (id: string) => {
    setFilters((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearAll = () => setFilters({});

  return {
    filteredRows,
    filters,
    distinctValues,
    setTextFilter,
    toggleSelectValue,
    setSelectValues,
    setNumberFilter,
    clearFilter,
    clearAll,
    activeCount: Object.keys(filters).length,
  };
}
