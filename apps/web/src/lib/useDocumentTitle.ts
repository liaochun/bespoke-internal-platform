// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect } from "react";

const SUFFIX = " · Northbound Ops";

/**
 * Set the browser tab title to `<title> · Northbound Ops` for the lifetime of
 * the calling component. Restores the previous title on unmount so a
 * navigation back to a page without an override doesn't strand the old
 * label.
 *
 * Client-component shim because all our admin pages are "use client" —
 * Next.js's `metadata` / `generateMetadata` exports only work from
 * Server Components or layouts.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title}${SUFFIX}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
