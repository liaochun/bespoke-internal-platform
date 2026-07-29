// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { ApiError, claimShift, ClaimPreview, previewClaim } from "@/lib/api";
import { fmtDateTimeShort, fmtDuration, fmtTime } from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

function Inner() {
  useDocumentTitle("Claim shift");
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const router = useRouter();

  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    previewClaim(token)
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [token]);

  const onClaim = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimShift(token);
      setSuccess(result.message);
      window.setTimeout(() => {
        router.replace("/me/schedule");
      }, 3000);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <main className="mx-auto max-w-2xl px-lg py-2xl">
        <header className="mb-lg">
          <p className="font-mono text-tiny uppercase tracking-widest text-clay">
            Northbound Ops · Workforce
          </p>
          <h1 className="mt-sm font-serif text-display text-stone">Claim this shift</h1>
        </header>

        {!token && !error && (
          <div className="rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            No claim token provided. Use the link from your shift-offer email.
          </div>
        )}

        {error && (
          <div className="mb-lg rounded-md border border-critical/40 bg-critical/10 p-md text-small text-stone">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-lg rounded-md border border-positive/40 bg-positive/10 p-md text-small text-stone">
            {success} Redirecting to your schedule…
          </div>
        )}

        {token && !preview && !error && (
          <div className="h-32 animate-pulse rounded-md border border-sand/30 bg-softCream/60" />
        )}

        {preview && !success && (
          <div className="rounded-md border border-sand/30 bg-softCream p-lg">
            <p className="font-mono text-body text-stone">
              {new Date(preview.shift.starts_at).toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </p>
            <p className="mt-xs font-mono text-h2 text-stone">
              {fmtTime(preview.shift.starts_at)} → {fmtTime(preview.shift.ends_at)}
            </p>
            <p className="mt-xs text-small text-stone/70 capitalize">
              {preview.shift.location}
              {preview.shift.role_label ? ` · ${preview.shift.role_label}` : ""} ·{" "}
              {fmtDuration(preview.shift.starts_at, preview.shift.ends_at)}
            </p>
            <p className="mt-md text-tiny text-stone/60">
              Offer expires {fmtDateTimeShort(preview.expires_at)} — first to claim wins.
            </p>

            {preview.cancelled && (
              <p className="mt-md rounded-sm bg-critical/10 px-md py-sm text-small text-stone">
                This offer has been cancelled.
              </p>
            )}
            {preview.claimed && !preview.claim_is_yours && (
              <p className="mt-md rounded-sm bg-critical/10 px-md py-sm text-small text-stone">
                Someone else has already claimed this shift.
              </p>
            )}
            {preview.claim_is_yours && (
              <p className="mt-md rounded-sm bg-positive/10 px-md py-sm text-small text-stone">
                You've already claimed this shift. It's on your schedule.
              </p>
            )}

            {!preview.cancelled && !preview.claimed && (
              <button
                type="button"
                onClick={onClaim}
                disabled={busy}
                className="mt-lg w-full rounded-sm bg-terracotta px-md py-sm font-medium text-warmWhite disabled:opacity-50"
              >
                {busy ? "Claiming…" : "Claim this shift"}
              </button>
            )}
          </div>
        )}
      </main>
    </>
  );
}

export default function ClaimShiftPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
