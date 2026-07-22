// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

/**
 * Minimal searchable single-select. One text input, one filtered
 * dropdown, no external dep. Falls back to "no matches" when the
 * filter is too tight. Keyboard: arrow keys + enter + esc.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export type SearchOption = {
  value: string;
  label: string;
  hint?: string | null;
};

export function SearchSelect({
  value,
  options,
  placeholder = "Search…",
  disabled = false,
  onChange,
}: {
  value: string;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.value === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hoverIndex, setHoverIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const blob = `${o.label} ${o.hint ?? ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [query, options]);

  useEffect(() => {
    setHoverIndex(0);
  }, [query]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[hoverIndex];
      if (opt) pick(opt.value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="w-full rounded-sm border border-sand bg-warmWhite px-sm py-sm text-left text-small focus:outline-none focus:border-terracotta disabled:opacity-50"
      >
        {selected ? (
          <>
            <span className="text-stone">{selected.label}</span>
            {selected.hint && (
              <span className="ml-xs font-mono text-tiny text-stone/40">{selected.hint}</span>
            )}
          </>
        ) : (
          <span className="text-stone/40">— pick —</span>
        )}
      </button>

      {open && (
        <div className="absolute z-20 mt-xs w-full rounded-sm border border-sand bg-warmWhite shadow-lg">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoFocus
            placeholder={placeholder}
            className="w-full rounded-t-sm border-b border-sand bg-warmWhite px-sm py-sm text-small focus:outline-none"
          />
          <ul className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-sm py-sm text-tiny text-stone/50">No matches.</li>
            ) : (
              filtered.map((o, idx) => {
                const active = idx === hoverIndex;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      onMouseEnter={() => setHoverIndex(idx)}
                      onClick={() => pick(o.value)}
                      className={`w-full px-sm py-sm text-left text-small ${
                        active ? "bg-terracotta/10 text-stone" : "text-stone/80 hover:bg-sand/20"
                      }`}
                    >
                      <span>{o.label}</span>
                      {o.hint && (
                        <span className="ml-xs font-mono text-tiny text-stone/40">{o.hint}</span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
