"use client";

/**
 * Demo-only persona switcher. Lets a visitor flip between the three seeded
 * demo personas (admin / manager / staff) to see how CapabilityGate-gated
 * nav and pages differ by role — without a real login system to switch
 * accounts through.
 *
 * Clearly labeled as a demo control (not a real account switcher) so it
 * reads honestly rather than like a security hole.
 */

import { useEffect, useState } from "react";

import { useCurrentUser } from "@/components/AuthGate";
import { DemoPersona, listPersonas, switchPersona } from "@/lib/api";

export function PersonaSwitcher() {
  const user = useCurrentUser();
  const [personas, setPersonas] = useState<DemoPersona[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setPersonas(listPersonas());
  }, []);

  const onChange = async (personaId: string) => {
    if (personaId === user.id) return;
    setSwitching(true);
    try {
      await switchPersona(personaId);
    } finally {
      setSwitching(false);
      window.dispatchEvent(new Event("northbound:persona-changed"));
    }
  };

  if (personas.length === 0) return null;

  return (
    <label className="flex items-center gap-xs text-tiny">
      <span className="hidden uppercase tracking-widest text-clay sm:inline">Viewing as</span>
      <select
        value={user.id}
        disabled={switching}
        onChange={(e) => void onChange(e.target.value)}
        title="Demo persona switcher — not a real login. Switches which seeded user's capabilities you're viewing the app as."
        className="rounded-sm border border-sand bg-warmWhite px-sm py-xs text-tiny text-stone focus:outline-none focus:border-terracotta disabled:opacity-50"
      >
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
