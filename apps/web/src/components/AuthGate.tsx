// Adapted for the static demo build: there is no real backend/session, so
// this no longer redirects to a /login page. Instead it resolves whichever
// "demo persona" is currently selected (see the Header persona switcher),
// defaulting to the admin persona the first time the app loads in a browser.
// The `unauthenticated` state and 401-shaped ApiError path are kept so the
// surrounding shape (and any code that pattern-matches on it) still compiles
// unchanged; in practice fetchMe() only rejects if localStorage is
// unavailable entirely.
"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { ApiError, CurrentUser, fetchMe } from "@/lib/api";

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: CurrentUser }
  | { status: "unauthenticated" };

const AuthContext = createContext<AuthState>({ status: "loading" });

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function useCurrentUser(): CurrentUser {
  const auth = useAuth();
  if (auth.status !== "authenticated") {
    throw new Error("useCurrentUser called outside an AuthGate-protected tree");
  }
  return auth.user;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user) => {
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setState({ status: "unauthenticated" });
        } else {
          setState({ status: "unauthenticated" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-resolve whenever the demo persona switcher fires this event, so the
  // whole capability-gated tree re-renders under the new persona instantly.
  useEffect(() => {
    const onPersonaChange = () => {
      setState({ status: "loading" });
      fetchMe()
        .then((user) => setState({ status: "authenticated", user }))
        .catch(() => setState({ status: "unauthenticated" }));
    };
    window.addEventListener("northbound:persona-changed", onPersonaChange);
    return () => window.removeEventListener("northbound:persona-changed", onPersonaChange);
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-tiny uppercase tracking-widest text-clay">
          Loading demo…
        </p>
      </div>
    );
  }

  if (state.status === "unauthenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center px-lg text-center">
        <div>
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">Demo mode</p>
          <p className="mt-sm text-body text-stone/70">
            Couldn&apos;t load a demo persona. Try resetting the demo data below.
          </p>
        </div>
      </div>
    );
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
