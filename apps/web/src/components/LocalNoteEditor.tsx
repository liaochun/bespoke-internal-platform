// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useState } from "react";

import { fetchLocalNote, upsertLocalNote } from "@/lib/api";

interface Props {
  entityType: string;
  entityId: string;
  /** Display label for the section header. */
  label?: string;
  /** When false, render read-only (e.g. user lacks manage_inventory). */
  canEdit?: boolean;
}

/**
 * Generic editor for a polymorphic local note attached to any entity.
 * Loads on mount, saves on blur/Enter. Doesn't push to the mirror —
 * notes here are local annotations only.
 */
export function LocalNoteEditor({ entityType, entityId, label = "Local note", canEdit = true }: Props) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchLocalNote(entityType, entityId);
        if (cancelled) return;
        const text = data?.note ?? "";
        setValue(text);
        setOriginal(text);
        setUpdatedAt(data?.updated_at ?? null);
        setUpdatedBy(data?.updated_by_email ?? null);
      } catch {
        // 404 means no note yet, that's fine
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  const save = async () => {
    if (value === original) {
      setEditing(false);
      return;
    }
    setSaveState("saving");
    try {
      const r = await upsertLocalNote(entityType, entityId, value || null);
      setOriginal(value);
      setUpdatedAt(r.updated_at);
      setUpdatedBy(r.updated_by_email ?? null);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
      setEditing(false);
    } catch (e) {
      console.error(e);
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 2500);
    }
  };

  return (
    <section className="rounded-md border border-sand/30 bg-softCream p-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-md">
        <h3 className="font-serif text-h3">{label}</h3>
        <div className="flex items-baseline gap-md text-tiny">
          {saveState === "saving" && (
            <span className="text-warning">saving…</span>
          )}
          {saveState === "saved" && (
            <span className="text-success">✓ saved</span>
          )}
          {saveState === "error" && (
            <span className="text-critical">✕ save failed</span>
          )}
          {updatedAt && saveState === "idle" && (
            <span className="text-stone/60">
              updated {new Date(updatedAt).toLocaleString()}
              {updatedBy && ` by ${updatedBy}`}
            </span>
          )}
        </div>
      </div>
      {canEdit ? (
        <div className="mt-md">
          {editing ? (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setValue(original);
                  setEditing(false);
                }
                // Enter inserts a newline; Cmd/Ctrl+Enter saves
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="Add a local note (Cmd/Ctrl+Enter to save · Esc to cancel)"
              className="w-full min-h-[80px] rounded-sm border border-terracotta bg-warmWhite px-md py-sm text-small focus:outline-none focus:border-terracotta"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="block w-full rounded-sm border border-dashed border-sand bg-warmWhite/50 px-md py-sm text-left text-small text-stone hover:border-terracotta hover:bg-warmWhite"
            >
              {value ? (
                <span className="whitespace-pre-wrap">{value}</span>
              ) : (
                <span className="text-stone/50">Click to add a local note…</span>
              )}
            </button>
          )}
        </div>
      ) : (
        <p className="mt-md whitespace-pre-wrap text-small text-stone/70">
          {value || <span className="italic text-stone/40">No note yet.</span>}
        </p>
      )}
    </section>
  );
}
