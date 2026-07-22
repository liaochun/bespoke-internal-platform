// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user) => {
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: "unauthenticated" });
          // Preserve the path + querystring so post-login bounces back here.
          const qs = search.toString();
          const here = pathname + (qs ? `?${qs}` : "");
          const isLoginPage = pathname.startsWith("/login");
          const target = isLoginPage ? "/login" : `/login?next=${encodeURIComponent(here)}`;
          router.replace(target);
        } else {
          setState({ status: "unauthenticated" });
        }
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, pathname]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-tiny uppercase tracking-widest text-clay">
          Verifying session…
        </p>
      </div>
    );
  }

  if (state.status === "unauthenticated") {
    return null;
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
