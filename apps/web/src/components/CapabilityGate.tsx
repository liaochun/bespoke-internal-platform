// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useCurrentUser } from "@/components/AuthGate";
import { has } from "@/lib/capabilities";

/**
 * Renders children only if the current user has at least one of the given capabilities.
 * Otherwise redirects to "/" and shows a 403 stub while the redirect runs.
 */
export function CapabilityGate({
  anyOf,
  children,
}: {
  anyOf: string[];
  children: React.ReactNode;
}) {
  const user = useCurrentUser();
  const router = useRouter();
  const allowed = anyOf.some((c) => has(user, c));

  useEffect(() => {
    if (!allowed) router.replace("/");
  }, [allowed, router]);

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl px-lg py-2xl">
        <p className="font-mono text-tiny uppercase tracking-widest text-clay">403</p>
        <h1 className="mt-sm font-serif text-h1">Not authorized</h1>
        <p className="mt-md text-body text-stone/70">Redirecting…</p>
      </div>
    );
  }
  return <>{children}</>;
}
