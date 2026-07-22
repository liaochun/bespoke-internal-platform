// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchMyTimeOff,
  listAllTimeOff,
  listCorrectionsAdmin,
  listDisciplineActions,
  listMyCorrections,
  listSickCalls,
  listTimeOffModificationsPending,
  type CurrentUser,
} from "@/lib/api";
import { CAP, clocksIn, has } from "@/lib/capabilities";
import { useVisibleInterval } from "@/lib/useVisibleInterval";

const POLL_MS = 60_000;

export type BadgeCategory =
  | "time_off"
  | "punch_corrections"
  | "my_time_off"
  | "my_punch_corrections";

const LS_KEYS: Record<BadgeCategory, string> = {
  // Manager queues — no last_seen needed (just raw pending count).
  time_off: "northbound:last_seen:time_off",
  punch_corrections: "northbound:last_seen:punch_corrections",
  // Staff own-request views — track when staff last looked at their list,
  // so we can flag pending→approved/denied transitions since that visit.
  my_time_off: "northbound:last_seen:my_time_off",
  my_punch_corrections: "northbound:last_seen:my_punch_corrections",
};

function readLastSeen(category: BadgeCategory): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(LS_KEYS[category]);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function writeLastSeen(category: BadgeCategory, ts: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_KEYS[category], String(ts));
}

export type NotificationBadges = {
  // Manager-side: raw pending counts.
  pendingTimeOff: number;
  pendingCorrections: number;
  pendingDisciplineActions: number;
  // Sick-call shifts in pending_review OR filling for managers.
  pendingSickCalls: number;
  // Staff-side: own requests whose status flipped from pending since last visit,
  // OR (if none changed) the current pending count — whichever is non-zero.
  myTimeOffUpdates: number;
  myCorrectionUpdates: number;
  markSeen: (category: BadgeCategory) => void;
};

/**
 * Polls the API every 60s (while tab is visible) for queue counts that should
 * surface as red badges in the nav. Counts are only fetched for the categories
 * the user is eligible for:
 *   - Manager queues: gated on manage_schedule / review_corrections caps.
 *   - Personal queues: gated on clocksIn(user), since accountants etc. don't
 *     have time punches or time-off to track.
 *
 * "Recently updated" for personal requests = items whose reviewer decided
 * (status flipped pending→approved/denied) AFTER the last_seen timestamp.
 * markSeen() bumps last_seen to now, which is wired to nav-link clicks so the
 * badge clears the moment the user actually opens the page.
 */
export function useNotificationBadges(user: CurrentUser): NotificationBadges {
  const canSeeTimeOffQueue = has(user, CAP.manage_schedule);
  const canSeeCorrectionsQueue = has(user, CAP.review_corrections);
  const canSeeDisciplineQueue = has(user, CAP.manage_users);
  const hasPersonalQueues = clocksIn(user);

  const [pendingTimeOff, setPendingTimeOff] = useState(0);
  const [pendingCorrections, setPendingCorrections] = useState(0);
  const [pendingDisciplineActions, setPendingDisciplineActions] = useState(0);
  const [pendingSickCalls, setPendingSickCalls] = useState(0);
  const [myTimeOffUpdates, setMyTimeOffUpdates] = useState(0);
  const [myCorrectionUpdates, setMyCorrectionUpdates] = useState(0);

  // Re-read last_seen on each computation. Stored as a ref so markSeen
  // can recompute without triggering an effect-rebuild loop.
  const lastSeenRef = useRef({
    my_time_off: 0,
    my_punch_corrections: 0,
  });

  useEffect(() => {
    lastSeenRef.current.my_time_off = readLastSeen("my_time_off");
    lastSeenRef.current.my_punch_corrections = readLastSeen("my_punch_corrections");
  }, []);

  const refresh = useCallback(async () => {
    // Manager: pending time off. Includes both fresh requests (status
    // "pending") and modification requests against already-approved time off
    // (status stays "approved" with pending_modification=true, so they need
    // their own query to surface in the badge).
    if (canSeeTimeOffQueue) {
      try {
        const [rows, modifications] = await Promise.all([
          listAllTimeOff("pending"),
          listTimeOffModificationsPending(),
        ]);
        setPendingTimeOff(rows.length + modifications.length);
      } catch {
        // Silent — network blips shouldn't blow up the header.
      }
      try {
        // Pending sick calls = open queue + open offers (both require manager
        // attention).
        const [pending, filling] = await Promise.all([
          listSickCalls({ status: "pending_review" }),
          listSickCalls({ status: "filling" }),
        ]);
        setPendingSickCalls(pending.length + filling.length);
      } catch {
        /* silent */
      }
    }
    // Manager: pending punch corrections.
    if (canSeeCorrectionsQueue) {
      try {
        const rows = await listCorrectionsAdmin("pending");
        setPendingCorrections(rows.length);
      } catch {
        /* silent */
      }
    }
    // Manager: pending discipline actions (awaiting_approval not already
    // approved by the current user).
    if (canSeeDisciplineQueue) {
      try {
        const rows = await listDisciplineActions({ status: "awaiting_approval" });
        const filtered = rows.filter((r) => {
          if (r.proposed_by_user_id === user.id) return false;
          return !r.approvals.some((a) => a.approver_user_id === user.id);
        });
        setPendingDisciplineActions(filtered.length);
      } catch {
        /* silent */
      }
    }
    // Staff: my time off — count items reviewed after last_seen,
    // fall back to current pending count if no updates.
    if (hasPersonalQueues) {
      try {
        const rows = await fetchMyTimeOff();
        const lastSeen = lastSeenRef.current.my_time_off;
        const updated = rows.filter((r) => {
          if (!r.reviewed_at) return false;
          if (r.status !== "approved" && r.status !== "denied") return false;
          return new Date(r.reviewed_at).getTime() > lastSeen;
        }).length;
        const pending = rows.filter((r) => r.status === "pending").length;
        setMyTimeOffUpdates(updated > 0 ? updated : pending);
      } catch {
        /* silent */
      }
      // Staff: my punch corrections — same rules.
      try {
        const rows = await listMyCorrections();
        const lastSeen = lastSeenRef.current.my_punch_corrections;
        const updated = rows.filter((r) => {
          if (!r.reviewed_at) return false;
          if (r.status !== "approved" && r.status !== "denied") return false;
          return new Date(r.reviewed_at).getTime() > lastSeen;
        }).length;
        const pending = rows.filter((r) => r.status === "pending").length;
        setMyCorrectionUpdates(updated > 0 ? updated : pending);
      } catch {
        /* silent */
      }
    }
  }, [
    canSeeTimeOffQueue,
    canSeeCorrectionsQueue,
    canSeeDisciplineQueue,
    hasPersonalQueues,
    user.id,
  ]);

  // Initial fetch
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while visible
  useVisibleInterval(() => {
    void refresh();
  }, POLL_MS);

  const markSeen = useCallback(
    (category: BadgeCategory) => {
      const now = Date.now();
      writeLastSeen(category, now);
      if (category === "my_time_off") {
        lastSeenRef.current.my_time_off = now;
        setMyTimeOffUpdates(0);
      } else if (category === "my_punch_corrections") {
        lastSeenRef.current.my_punch_corrections = now;
        setMyCorrectionUpdates(0);
      }
      // Manager categories: pending counts come from the queue itself, not
      // last_seen. Clearing happens organically when the manager approves the
      // request, which drops the next poll's pending count.
    },
    [],
  );

  return {
    pendingTimeOff,
    pendingCorrections,
    pendingDisciplineActions,
    pendingSickCalls,
    myTimeOffUpdates,
    myCorrectionUpdates,
    markSeen,
  };
}
