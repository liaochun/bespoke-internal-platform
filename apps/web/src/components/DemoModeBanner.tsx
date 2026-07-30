"use client";

/**
 * Persistent, always-visible signal that this is a static demo: nothing here
 * is a real backend, nothing here is real business data, and the visitor can
 * always get back to a clean slate — or back to the dashboard. Rendered once
 * from the root layout so it shows up on every route — including the ones
 * that don't render <Header> (kiosk clock-in, the unauthenticated
 * shift-claim page), which otherwise have no way back to the rest of the demo.
 */

import Link from "next/link";
import { useState } from "react";

import { resetDemoData } from "@/lib/api";

export function DemoModeBanner() {
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const onReset = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setResetting(true);
    resetDemoData();
    if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <div className="fixed bottom-0 right-0 z-[999] m-md flex items-center gap-sm rounded-full border border-terracotta/40 bg-warmWhite/95 px-md py-xs shadow-lg backdrop-blur-sm">
      <span className="h-2 w-2 rounded-full bg-terracotta" aria-hidden />
      <span className="text-tiny text-stone/80">
        <strong className="font-medium text-stone">Demo Mode</strong> — data lives only in your
        browser and resets on request
      </span>
      <Link
        href="/"
        className="rounded-full border border-sand bg-warmWhite px-sm py-[3px] text-tiny font-medium text-stone hover:bg-sand/20"
      >
        ← Dashboard
      </Link>
      <button
        type="button"
        onClick={onReset}
        onBlur={() => setConfirming(false)}
        disabled={resetting}
        className="rounded-full border border-sand bg-warmWhite px-sm py-[3px] text-tiny font-medium text-stone hover:bg-sand/20 disabled:opacity-50"
      >
        {resetting ? "Resetting…" : confirming ? "Click again to confirm" : "Reset demo data"}
      </button>
    </div>
  );
}
