// Static demo build of the Northbound Ops client API.
//
// This file used to `fetch()` a real FastAPI backend. There is no backend in
// this deployment target (Cloudflare Pages static export) — every function
// below instead reads/writes an in-browser "database" persisted to
// localStorage (see lib/demoStore.ts, seeded on first visit by
// lib/demoSeed.ts). Function names, signatures, and exported types are kept
// as close as possible to the original so the page components that import
// from "@/lib/api" don't need to change.
//
// Every function still returns a Promise and adds a small artificial delay
// so the UI's existing loading states feel like a real network round trip.

import { CAPABILITY_CATALOG, PERSONA_KEYS } from "./demoSeed";
import {
  Db,
  DemoRole,
  delay,
  getCurrentPersonaId,
  getDb,
  mutateDb,
  nowIso,
  resetDb as resetDemoDb,
  setCurrentPersonaId,
  uid,
} from "./demoStore";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── Auth / nav chrome ──────────────────────────────────────────────────

export type Role = DemoRole;

export type CurrentUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  user_type: "internal" | "external";
  is_active: boolean;
  capabilities: string[];
};

function toCurrentUser(db: Db, userId: string): CurrentUser | null {
  const u = db.users.find((x) => x.id === userId);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    user_type: u.user_type,
    is_active: u.is_active,
    capabilities: u.capabilities,
  };
}

/**
 * Demo auth: there is no real session. `fetchMe` resolves to whichever
 * persona is currently selected (see the Header persona switcher), defaulting
 * to the admin persona the very first time the app loads in a browser. It
 * never rejects with a 401 in normal operation — that path is kept only so
 * AuthGate's existing error-handling shape still compiles/works untouched.
 */
export const fetchMe = async (): Promise<CurrentUser> => {
  const db = getDb();
  let personaId = getCurrentPersonaId();
  if (!personaId || !db.users.some((u) => u.id === personaId)) {
    personaId = PERSONA_KEYS.admin;
    setCurrentPersonaId(personaId);
  }
  const user = toCurrentUser(db, personaId);
  if (!user) {
    throw new ApiError(401, "No demo persona selected.");
  }
  return delay(user);
};

export const logout = () => delay({ status: "ok" });

// ─── Demo persona switcher (new — not present in the real API) ─────────

export type DemoPersona = { id: string; full_name: string; role: Role; label: string };

/** The 3 personas exposed in the Header's "Demo persona" switcher. */
export const listPersonas = (): DemoPersona[] => {
  const db = getDb();
  const ids = [PERSONA_KEYS.admin, PERSONA_KEYS.manager, PERSONA_KEYS.staff];
  return ids
    .map((id) => db.users.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({
      id: u.id,
      full_name: u.full_name,
      role: u.role,
      label: `${u.full_name} — ${u.role.replace("_", " ")}`,
    }));
};

export const getCurrentPersonaIdPublic = (): string => getCurrentPersonaId() ?? PERSONA_KEYS.admin;

export const switchPersona = async (personaId: string): Promise<CurrentUser> => {
  setCurrentPersonaId(personaId);
  const db = getDb();
  const user = toCurrentUser(db, personaId);
  if (!user) throw new ApiError(404, "Unknown persona.");
  return delay(user);
};

/** Clears all demo data + persona selection. Caller reloads the page. */
export const resetDemoData = (): void => resetDemoDb();

export type NavLayoutSection = "workforce" | "inventory" | "admin" | "me";
export type NavLayout = { sections: Partial<Record<NavLayoutSection, string[]>> };
export const fetchNavLayout = async (): Promise<NavLayout> => {
  const db = getDb();
  return delay({ sections: (db.navLayout as Partial<Record<NavLayoutSection, string[]>>) ?? {} });
};

export type GlobalSearchHit = {
  entity_type: string;
  id: string;
  primary: string;
  secondary: string | null;
  tertiary: string | null;
};
export type GlobalSearchResponse = {
  query: string;
  hits: GlobalSearchHit[];
  counts_by_type: Record<string, number>;
};
export const globalSearch = async (q: string): Promise<GlobalSearchResponse> => {
  const db = getDb();
  const needle = q.trim().toLowerCase();
  const hits: GlobalSearchHit[] = [];
  if (needle) {
    for (const item of db.masterItems) {
      if (item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle)) {
        hits.push({ entity_type: "master_item", id: item.id, primary: item.name, secondary: item.sku, tertiary: null });
      }
    }
    for (const c of db.customers) {
      const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
      if (name.toLowerCase().includes(needle) || (c.email ?? "").toLowerCase().includes(needle)) {
        hits.push({ entity_type: "customer", id: c.id, primary: name || (c.email ?? ""), secondary: c.email, tertiary: null });
      }
    }
  }
  const counts_by_type: Record<string, number> = {};
  for (const h of hits) counts_by_type[h.entity_type] = (counts_by_type[h.entity_type] ?? 0) + 1;
  return delay({ query: q, hits: hits.slice(0, 40), counts_by_type });
};

// ─── Shifts + the sick-call / first-to-claim workflow ──────────────────

export type ShiftStatus = "scheduled" | "in_progress" | "completed" | "missed" | "cancelled";

export type Shift = {
  id: string;
  user_id: string;
  location: string;
  role_label: string | null;
  starts_at: string;
  ends_at: string;
  status: ShiftStatus;
  notes: string | null;
  sick_called_at: string | null;
  sick_call_note: string | null;
  sick_call_status: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftWithStaff = Shift & {
  user: { id: string; full_name: string; email: string };
};

export type ShiftCreateInput = {
  user_id: string;
  starts_at: string;
  ends_at: string;
  location?: string;
  role_label?: string | null;
  notes?: string | null;
  override_conflicts?: boolean;
};
export type ShiftUpdateInput = Partial<ShiftCreateInput> & { status?: ShiftStatus };

function userMini(db: Db, userId: string) {
  const u = db.users.find((x) => x.id === userId);
  return { id: u?.id ?? userId, full_name: u?.full_name ?? "Unknown", email: u?.email ?? "" };
}

function toShiftWithStaff(db: Db, s: Db["shifts"][number]): ShiftWithStaff {
  return {
    id: s.id,
    user_id: s.user_id,
    location: s.location,
    role_label: s.role_label,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    status: s.status,
    notes: s.notes,
    sick_called_at: s.sick_called_at,
    sick_call_note: s.sick_call_note,
    sick_call_status: s.sick_call_status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    user: userMini(db, s.user_id),
  };
}

export const listShifts = async (params?: { start?: string; end?: string; user_id?: string }): Promise<ShiftWithStaff[]> => {
  const db = getDb();
  let rows = db.shifts;
  if (params?.user_id) rows = rows.filter((s) => s.user_id === params.user_id);
  if (params?.start) rows = rows.filter((s) => s.ends_at >= params.start!);
  if (params?.end) rows = rows.filter((s) => s.starts_at <= params.end!);
  return delay(rows.map((s) => toShiftWithStaff(db, s)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
};

export const createShift = async (body: ShiftCreateInput): Promise<ShiftWithStaff> =>
  delay(
    mutateDb((db) => {
      const now = nowIso();
      const shift = {
        id: uid("shift"),
        user_id: body.user_id,
        location: body.location ?? "toronto",
        role_label: body.role_label ?? null,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        status: "scheduled" as ShiftStatus,
        notes: body.notes ?? null,
        sick_called_at: null,
        sick_call_note: null,
        sick_call_status: null,
        called_in_by_user_id: null,
        created_at: now,
        updated_at: now,
      };
      db.shifts.push(shift);
      return toShiftWithStaff(db, shift);
    }),
  );

export const bulkCreateShifts = async (
  shifts: ShiftCreateInput[],
): Promise<{ created: number; skipped: number; overridden: number }> =>
  delay(
    mutateDb((db) => {
      let overridden = 0;
      for (const body of shifts) {
        if (body.override_conflicts) {
          for (const s of db.shifts) {
            if (
              s.user_id === body.user_id &&
              s.status !== "cancelled" &&
              s.status !== "completed" &&
              s.starts_at < body.ends_at &&
              s.ends_at > body.starts_at
            ) {
              s.status = "cancelled";
              overridden += 1;
            }
          }
        }
        const now = nowIso();
        db.shifts.push({
          id: uid("shift"),
          user_id: body.user_id,
          location: body.location ?? "toronto",
          role_label: body.role_label ?? null,
          starts_at: body.starts_at,
          ends_at: body.ends_at,
          status: "scheduled",
          notes: body.notes ?? null,
          sick_called_at: null,
          sick_call_note: null,
          sick_call_status: null,
          called_in_by_user_id: null,
          created_at: now,
          updated_at: now,
        });
      }
      return { created: shifts.length, skipped: 0, overridden };
    }),
  );

export const updateShift = async (id: string, body: ShiftUpdateInput): Promise<ShiftWithStaff> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === id);
      if (!s) throw new ApiError(404, "Shift not found.");
      if (body.override_conflicts) {
        for (const other of db.shifts) {
          if (
            other.id !== id &&
            other.user_id === (body.user_id ?? s.user_id) &&
            other.status !== "cancelled" &&
            other.status !== "completed" &&
            other.starts_at < (body.ends_at ?? s.ends_at) &&
            other.ends_at > (body.starts_at ?? s.starts_at)
          ) {
            other.status = "cancelled";
          }
        }
      }
      Object.assign(s, {
        user_id: body.user_id ?? s.user_id,
        starts_at: body.starts_at ?? s.starts_at,
        ends_at: body.ends_at ?? s.ends_at,
        location: body.location ?? s.location,
        role_label: body.role_label !== undefined ? body.role_label : s.role_label,
        notes: body.notes !== undefined ? body.notes : s.notes,
        status: body.status ?? s.status,
        updated_at: nowIso(),
      });
      return toShiftWithStaff(db, s);
    }),
  );

export const deleteShift = async (id: string): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      db.shifts = db.shifts.filter((s) => s.id !== id);
      return undefined;
    }),
  );

export const cancelShift = async (id: string): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === id);
      if (s) s.status = "cancelled";
      return undefined;
    }),
  );

export const fetchMyShifts = async (days = 14, back = 0): Promise<Shift[]> => {
  const db = getDb();
  const personaId = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
  const now = Date.now();
  const start = now - back * 86_400_000;
  const end = start + days * 86_400_000;
  const rows = db.shifts
    .filter((s) => s.user_id === personaId)
    .filter((s) => new Date(s.ends_at).getTime() >= start && new Date(s.starts_at).getTime() <= end)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return delay(rows.map((s) => ({ ...s })));
};

export type SickCallStatus = "pending_review" | "dismissed" | "filling" | "filled";

export type SickCall = ShiftWithStaff & {
  sick_call_status: SickCallStatus | null;
  called_in_by: { id: string; full_name: string; email: string } | null;
};

export type ClaimCandidate = {
  id: string;
  user_id: string;
  user: { id: string; full_name: string; email: string };
  emailed_at: string;
  notified_filled_at: string | null;
};

export type ClaimOffer = {
  id: string;
  shift_id: string;
  opened_by_user_id: string;
  opened_at: string;
  expires_at: string;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  candidates: ClaimCandidate[];
};

export type ClaimPreview = {
  shift: Shift;
  expires_at: string;
  claimed: boolean;
  cancelled: boolean;
  claim_is_yours: boolean;
};

function toSickCall(db: Db, s: Db["shifts"][number]): SickCall {
  const base = toShiftWithStaff(db, s);
  return {
    ...base,
    sick_call_status: s.sick_call_status,
    called_in_by: s.called_in_by_user_id ? userMini(db, s.called_in_by_user_id) : null,
  };
}

function toClaimOffer(db: Db, o: Db["claimOffers"][number]): ClaimOffer {
  return {
    id: o.id,
    shift_id: o.shift_id,
    opened_by_user_id: o.opened_by_user_id,
    opened_at: o.opened_at,
    expires_at: o.expires_at,
    claimed_by_user_id: o.claimed_by_user_id,
    claimed_at: o.claimed_at,
    cancelled_at: o.cancelled_at,
    cancel_reason: o.cancel_reason,
    candidates: o.candidate_user_ids.map((uidStr, i) => ({
      id: `${o.id}-c${i}`,
      user_id: uidStr,
      user: userMini(db, uidStr),
      emailed_at: o.opened_at,
      notified_filled_at: o.claimed_at,
    })),
  };
}

// Staff: self-report calling in sick on an upcoming scheduled shift.
export const callInSick = async (shiftId: string, note?: string): Promise<SickCall> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === shiftId);
      if (!s) throw new ApiError(404, "Shift not found.");
      s.status = "cancelled";
      s.sick_called_at = nowIso();
      s.sick_call_note = note ?? null;
      s.sick_call_status = "pending_review";
      s.called_in_by_user_id = s.user_id;
      return toSickCall(db, s);
    }),
  );

// Manager: record a sick call on a staff member's behalf.
export const adminMarkShiftSick = async (shiftId: string, note?: string): Promise<SickCall> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === shiftId);
      if (!s) throw new ApiError(404, "Shift not found.");
      const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
      s.status = "cancelled";
      s.sick_called_at = nowIso();
      s.sick_call_note = note ?? null;
      s.sick_call_status = "pending_review";
      s.called_in_by_user_id = persona;
      return toSickCall(db, s);
    }),
  );

export const listSickCalls = async (params?: {
  status?: SickCallStatus;
  user_id?: string;
  from_date?: string;
  to_date?: string;
  sort_by?: "date_desc" | "date_asc" | "staff_name";
}): Promise<SickCall[]> => {
  const db = getDb();
  let rows = db.shifts.filter((s) => s.sick_call_status !== null);
  if (params?.status) rows = rows.filter((s) => s.sick_call_status === params.status);
  if (params?.user_id) rows = rows.filter((s) => s.user_id === params.user_id);
  if (params?.from_date) rows = rows.filter((s) => (s.sick_called_at ?? s.created_at) >= params.from_date!);
  if (params?.to_date) rows = rows.filter((s) => (s.sick_called_at ?? s.created_at) <= params.to_date!);
  const calls = rows.map((s) => toSickCall(db, s));
  const sortBy = params?.sort_by ?? "date_desc";
  calls.sort((a, b) => {
    if (sortBy === "staff_name") return a.user.full_name.localeCompare(b.user.full_name);
    const av = a.sick_called_at ?? a.created_at;
    const bv = b.sick_called_at ?? b.created_at;
    return sortBy === "date_asc" ? av.localeCompare(bv) : bv.localeCompare(av);
  });
  return delay(calls);
};

export const listStaffUpcomingShifts = async (userId: string): Promise<Shift[]> => {
  const db = getDb();
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;
  const rows = db.shifts
    .filter((s) => s.user_id === userId && s.status !== "cancelled")
    .filter((s) => new Date(s.starts_at).getTime() >= weekAgo)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return delay(rows.map((s) => ({ ...s })));
};

export const dismissSickCall = async (shiftId: string, note?: string): Promise<SickCall> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === shiftId);
      if (!s) throw new ApiError(404, "Shift not found.");
      s.sick_call_status = "dismissed";
      if (note) s.sick_call_note = note;
      return toSickCall(db, s);
    }),
  );

// Opens the shift up to every eligible, available, unscheduled candidate.
export const openClaimOffer = async (shiftId: string): Promise<{ offer: ClaimOffer; candidate_count: number }> =>
  delay(
    mutateDb((db) => {
      const s = db.shifts.find((x) => x.id === shiftId);
      if (!s) throw new ApiError(404, "Shift not found.");
      s.sick_call_status = "filling";
      const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
      const candidates = db.users
        .filter((u) => u.id !== s.user_id && u.role !== "accountant" && u.is_active)
        .slice(0, 5);
      const offer = {
        id: uid("offer"),
        shift_id: s.id,
        opened_by_user_id: persona,
        opened_at: nowIso(),
        expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        claimed_by_user_id: null,
        claimed_at: null,
        cancelled_at: null,
        cancel_reason: null,
        candidate_user_ids: candidates.map((c) => c.id),
        claim_token: uid("token"),
      };
      db.claimOffers.push(offer);
      return { offer: toClaimOffer(db, offer), candidate_count: candidates.length };
    }),
  );

export const getClaimOffer = async (shiftId: string): Promise<ClaimOffer> => {
  const db = getDb();
  const offer = [...db.claimOffers].reverse().find((o) => o.shift_id === shiftId);
  if (!offer) throw new ApiError(404, "No offer for this shift.");
  return delay(toClaimOffer(db, offer));
};

export const cancelClaimOffer = async (shiftId: string, reason?: string): Promise<ClaimOffer> =>
  delay(
    mutateDb((db) => {
      const offer = [...db.claimOffers].reverse().find((o) => o.shift_id === shiftId && !o.cancelled_at && !o.claimed_at);
      if (!offer) throw new ApiError(404, "No open offer for this shift.");
      offer.cancelled_at = nowIso();
      offer.cancel_reason = reason ?? null;
      const s = db.shifts.find((x) => x.id === shiftId);
      if (s) s.sick_call_status = "pending_review";
      return toClaimOffer(db, offer);
    }),
  );

// Unauthenticated (the claim_token is the credential) — backs /shifts/claim?token=....
export const previewClaim = async (token: string): Promise<ClaimPreview> => {
  const db = getDb();
  const offer = db.claimOffers.find((o) => o.claim_token === token);
  if (!offer) throw new ApiError(404, "This claim link is invalid or has expired.");
  const s = db.shifts.find((x) => x.id === offer.shift_id);
  if (!s) throw new ApiError(404, "Shift not found.");
  const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
  return delay({
    shift: { ...s },
    expires_at: offer.expires_at,
    claimed: !!offer.claimed_at,
    cancelled: !!offer.cancelled_at,
    claim_is_yours: offer.claimed_by_user_id === persona,
  });
};

export const claimShift = async (token: string): Promise<{ shift: Shift; message: string }> =>
  delay(
    mutateDb((db) => {
      const offer = db.claimOffers.find((o) => o.claim_token === token);
      if (!offer) throw new ApiError(404, "This claim link is invalid or has expired.");
      if (offer.cancelled_at) throw new ApiError(410, "This offer has been cancelled.");
      if (offer.claimed_at) throw new ApiError(409, "Someone else already claimed this shift.");
      const original = db.shifts.find((x) => x.id === offer.shift_id);
      if (!original) throw new ApiError(404, "Shift not found.");
      const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
      offer.claimed_by_user_id = persona;
      offer.claimed_at = nowIso();
      original.sick_call_status = "filled";
      const now = nowIso();
      const newShift = {
        id: uid("shift"),
        user_id: persona,
        location: original.location,
        role_label: original.role_label,
        starts_at: original.starts_at,
        ends_at: original.ends_at,
        status: "scheduled" as ShiftStatus,
        notes: "Picked up via sub offer.",
        sick_called_at: null,
        sick_call_note: null,
        sick_call_status: null,
        called_in_by_user_id: null,
        created_at: now,
        updated_at: now,
      };
      db.shifts.push(newShift);
      return { shift: { ...newShift }, message: "Shift claimed — it's on your schedule now." };
    }),
  );

export type SubHistoryEntry = {
  shift_id: string;
  shift_starts_at: string;
  shift_ends_at: string;
  shift_location: string | null;
  shift_role_label: string | null;
  sick_user: { id: string; full_name: string; email: string };
  opened_by: { id: string; full_name: string; email: string };
  opened_at: string;
  expires_at: string;
  candidates: { id: string; full_name: string; email: string }[];
  claimed_by: { id: string; full_name: string; email: string } | null;
  claimed_at: string | null;
  cancelled: boolean;
};

export const getOfferHistory = async (params?: { limit?: number; offset?: number }): Promise<SubHistoryEntry[]> => {
  const db = getDb();
  const rows = [...db.claimOffers].reverse().map((o) => {
    const shift = db.shifts.find((s) => s.id === o.shift_id);
    return {
      shift_id: o.shift_id,
      shift_starts_at: shift?.starts_at ?? o.opened_at,
      shift_ends_at: shift?.ends_at ?? o.opened_at,
      shift_location: shift?.location ?? null,
      shift_role_label: shift?.role_label ?? null,
      sick_user: userMini(db, shift?.called_in_by_user_id ?? shift?.user_id ?? ""),
      opened_by: userMini(db, o.opened_by_user_id),
      opened_at: o.opened_at,
      expires_at: o.expires_at,
      candidates: o.candidate_user_ids.map((c) => userMini(db, c)),
      claimed_by: o.claimed_by_user_id ? userMini(db, o.claimed_by_user_id) : null,
      claimed_at: o.claimed_at,
      cancelled: !!o.cancelled_at,
    };
  });
  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? 50;
  return delay(rows.slice(offset, offset + limit));
};

export type SubLeaderboardEntry = {
  user: { id: string; full_name: string; email: string };
  times_contacted: number;
  shifts_claimed: number;
};
export const getSubLeaderboard = async (): Promise<SubLeaderboardEntry[]> => {
  const db = getDb();
  const contacted = new Map<string, number>();
  const claimed = new Map<string, number>();
  for (const o of db.claimOffers) {
    for (const c of o.candidate_user_ids) contacted.set(c, (contacted.get(c) ?? 0) + 1);
    if (o.claimed_by_user_id) claimed.set(o.claimed_by_user_id, (claimed.get(o.claimed_by_user_id) ?? 0) + 1);
  }
  const ids = new Set([...contacted.keys(), ...claimed.keys()]);
  const rows = [...ids].map((id) => ({
    user: userMini(db, id),
    times_contacted: contacted.get(id) ?? 0,
    shifts_claimed: claimed.get(id) ?? 0,
  }));
  rows.sort((a, b) => b.shifts_claimed - a.shifts_claimed);
  return delay(rows);
};

// ─── Inventory dashboard ─────────────────────────────────────────────────

export type InventoryDashboardLowStockRow = {
  id: string;
  sku: string;
  name: string;
  on_hand: number;
  master_item_name: string | null;
  master_item_id: string | null;
  master_item_sku: string | null;
  variant_name: string | null;
  stock_available_toronto: number | null;
  stock_available_wavecrest: number | null;
  daily_burn_combined: number | null;
  weeks_combined: number | null;
};

export type DashboardTransaction = {
  id: string;
  master_item_name: string | null;
  occurred_at: string;
  quantity: number | null;
  warehouse: string | null;
  status: string | null;
  scanned_by: string | null;
  notes: string | null;
};

export type DashboardProductionRun = {
  id: string;
  master_item_name: string | null;
  name: string | null;
  run_date: string;
  status: string | null;
  production_target_calculated: number | null;
  finished_product: number | null;
};

export type DashboardTransfer = {
  id: string;
  master_item_name: string | null;
  master_item_id: string | null;
  name: string | null;
  quantity: number | null;
  from_warehouse: string | null;
  to_warehouse: string | null;
  status: string | null;
  transfer_date: string | null;
  estimated_stock_in_date: string | null;
  days_in_transit: number | null;
  overdue: boolean;
};

export type DashboardOpenOrderRow = {
  order_id: string | null;
  order_number: number | null;
  customer_email: string | null;
  fulfillment_status: string | null;
  line_item_count: number;
  order_total_usd: number | null;
  age_days: number | null;
};

export type DashboardOpenOrdersSummary = {
  total_open: number;
  oldest_age_days: number | null;
  aging_3_to_7d: number;
  aging_over_7d: number;
  top: DashboardOpenOrderRow[];
};

export type AtRiskCustomer = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  total_clv: number | null;
  churn_probability: number | null;
  risk_score: number;
  historic_order_count: number | null;
  last_order_date: string | null;
  expected_next_order: string | null;
};

export type InventoryDashboard = {
  stats: {
    total_variants: number;
    linked_variants: number;
    critical_count: number;
    warning_count: number;
    healthy_count: number;
    untracked_count: number;
  };
  low_stock: InventoryDashboardLowStockRow[];
  recent_production_runs: DashboardProductionRun[];
  recent_incoming: DashboardTransaction[];
  recent_outgoing: DashboardTransaction[];
  transfers_in_flight: DashboardTransfer[];
  open_orders: DashboardOpenOrdersSummary | null;
  at_risk_customers: AtRiskCustomer[];
};

function weeksLeft(item: Db["masterItems"][number]): number | null {
  const velocity = parseFloat(item.weekly_velocity_toronto) + parseFloat(item.weekly_velocity_wavecrest);
  if (!velocity) return null;
  return item.on_hand / velocity;
}

export const fetchInventoryDashboard = async (): Promise<InventoryDashboard> => {
  const db = getDb();
  const products = db.masterItems.filter((i) => i.item_type === "product");
  const lowStock = products.filter((i) => i.low_stock);
  const recentRuns = [...db.productionRuns].sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date)).slice(0, 5);
  const finishedById = new Map(db.masterItems.map((i) => [i.id, i]));
  return delay({
    stats: {
      total_variants: products.length,
      linked_variants: products.length,
      critical_count: lowStock.length,
      warning_count: Math.max(0, products.length - lowStock.length - 3),
      healthy_count: Math.min(3, products.length),
      untracked_count: 0,
    },
    low_stock: lowStock.map((i) => {
      const toronto = i.stock_by_location.find((s) => s.location === "toronto")?.quantity ?? null;
      const wave = i.stock_by_location.find((s) => s.location === "wavecrest_usa")?.quantity ?? null;
      const burn = parseFloat(i.weekly_velocity_toronto) + parseFloat(i.weekly_velocity_wavecrest);
      return {
        id: i.id,
        sku: i.sku,
        name: i.name,
        on_hand: i.on_hand,
        master_item_name: i.name,
        master_item_id: i.id,
        master_item_sku: i.sku,
        variant_name: i.name,
        stock_available_toronto: toronto,
        stock_available_wavecrest: wave,
        daily_burn_combined: burn / 7,
        weeks_combined: weeksLeft(i),
      };
    }),
    recent_production_runs: recentRuns.map((r) => ({
      id: r.id,
      master_item_name: finishedById.get(r.finished_item_id)?.name ?? null,
      name: finishedById.get(r.finished_item_id)?.name ?? null,
      run_date: r.scheduled_date,
      status: r.status,
      production_target_calculated: r.target_qty,
      finished_product: r.completed_qty,
    })),
    recent_incoming: recentRuns.slice(0, 3).map((r) => ({
      id: uid("txn"),
      master_item_name: finishedById.get(r.finished_item_id)?.name ?? null,
      occurred_at: r.completed_at ?? r.scheduled_date,
      quantity: r.completed_qty,
      warehouse: "toronto",
      status: "received",
      scanned_by: null,
      notes: null,
    })),
    recent_outgoing: db.orderLines.slice(0, 3).map((o) => ({
      id: o.id,
      master_item_name: o.line_item_name,
      occurred_at: o.created_at_shopify,
      quantity: o.quantity,
      warehouse: "toronto",
      status: o.order_fulfillment_status,
      scanned_by: null,
      notes: null,
    })),
    transfers_in_flight: db.transfersV2
      .filter((t) => t.status !== "received")
      .map((t) => ({
        id: t.id,
        master_item_name: t.master_item_name,
        master_item_id: null,
        name: null,
        quantity: t.quantity,
        from_warehouse: t.from_warehouse,
        to_warehouse: t.to_warehouse,
        status: t.status,
        transfer_date: nowIso(),
        estimated_stock_in_date: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        days_in_transit: 2,
        overdue: false,
      })),
    open_orders: {
      total_open: db.orderLines.filter((o) => o.order_fulfillment_status === "unfulfilled").length,
      oldest_age_days: 4,
      aging_3_to_7d: 1,
      aging_over_7d: 0,
      top: db.orderLines
        .filter((o) => o.order_fulfillment_status === "unfulfilled")
        .slice(0, 5)
        .map((o) => ({
          order_id: o.order_id,
          order_number: o.order_number,
          customer_email: db.customers.find((c) => c.id === o.customer_id)?.email ?? null,
          fulfillment_status: o.order_fulfillment_status,
          line_item_count: 1,
          order_total_usd: o.line_item_subtotal,
          age_days: 4,
        })),
    },
    at_risk_customers: db.customers
      .filter((c) => (c.churn_probability ?? 0) >= 0.5)
      .map((c) => ({
        id: c.id,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        total_clv: c.total_clv,
        churn_probability: c.churn_probability,
        risk_score: Math.round((c.total_clv ?? 0) * (c.churn_probability ?? 0)),
        historic_order_count: c.historic_order_count,
        last_order_date: c.last_order_date,
        expected_next_order: c.expected_next_order,
      })),
  });
};

export type ProductionPlanRow = {
  product_master_item_id: string;
  product_name: string;
  limiting_ingredient_name: string | null;
  max_producible: number | null;
  limiting_grams_per_bag: number | null;
  limiting_ingredient_available: number | null;
  bom_line_count: number;
};

export const fetchProductionPlanning = async (): Promise<ProductionPlanRow[]> => {
  const db = getDb();
  const rows = db.recipes.map((r) => {
    const ingredientLines = r.lines.filter((l) => l.component_item_type === "ingredient");
    let worst: { name: string; perBag: number; available: number; max: number } | null = null;
    for (const line of ingredientLines) {
      const stock = db.masterItems.find((i) => i.id === line.component_item_id);
      const available = stock?.on_hand ?? 0;
      const max = line.qty_per_unit > 0 ? Math.floor(available / line.qty_per_unit) : Infinity;
      if (!worst || max < worst.max) {
        worst = { name: line.component_name, perBag: line.qty_per_unit, available, max };
      }
    }
    return {
      product_master_item_id: r.finished_item_id,
      product_name: r.finished_name,
      limiting_ingredient_name: worst?.name ?? null,
      max_producible: worst ? worst.max : null,
      limiting_grams_per_bag: worst?.perBag ?? null,
      limiting_ingredient_available: worst?.available ?? null,
      bom_line_count: r.lines.length,
    };
  });
  return delay(rows);
};

export type RevenueWindow = { days: number; revenue: number; unique_orders: number; unique_customers: number; aov: number | null };
export type RevenueDashboard = {
  windows: RevenueWindow[];
  daily_series_90d: { date: string; revenue: number; line_items: number }[];
  top_skus_90d: { sku: string | null; item_name: string | null; quantity: number; line_items: number; revenue: number }[];
  top_customers_90d: {
    customer_id: string | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    revenue_in_window: number;
    orders_in_window: number;
    total_clv: number | null;
    churn_probability: number | null;
  }[];
  channel_breakdown_90d: { channel: string | null; revenue: number; unique_orders: number; line_items: number }[];
};

export const fetchRevenueDashboard = async (): Promise<RevenueDashboard> => {
  const db = getDb();
  const series: { date: string; revenue: number; line_items: number }[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const base = 400 + Math.sin(i / 6) * 150 + (i % 7 === 0 ? 250 : 0);
    series.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      revenue: Math.max(50, Math.round(base + Math.random() * 100)),
      line_items: 8 + Math.round(Math.random() * 20),
    });
  }
  const windowRevenue = (days: number) => series.slice(-days).reduce((acc, s) => acc + s.revenue, 0);
  const bySku = new Map<string, { item_name: string | null; quantity: number; line_items: number; revenue: number }>();
  for (const o of db.orderLines) {
    const key = o.sku ?? o.line_item_name;
    const cur = bySku.get(key) ?? { item_name: o.line_item_name, quantity: 0, line_items: 0, revenue: 0 };
    cur.quantity += o.quantity;
    cur.line_items += 1;
    cur.revenue += o.line_item_subtotal;
    bySku.set(key, cur);
  }
  const topSkus = [...bySku.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)
    .map(([sku, v]) => ({ sku, item_name: v.item_name, quantity: v.quantity, line_items: v.line_items, revenue: v.revenue }));

  const byCustomer = new Map<string, { revenue: number; orders: number }>();
  for (const o of db.orderLines) {
    const cur = byCustomer.get(o.customer_id) ?? { revenue: 0, orders: 0 };
    cur.revenue += o.line_item_subtotal;
    cur.orders += 1;
    byCustomer.set(o.customer_id, cur);
  }
  const topCustomers = [...byCustomer.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)
    .map(([cid, v]) => {
      const c = db.customers.find((x) => x.id === cid);
      return {
        customer_id: cid,
        email: c?.email ?? null,
        first_name: c?.first_name ?? null,
        last_name: c?.last_name ?? null,
        revenue_in_window: v.revenue,
        orders_in_window: v.orders,
        total_clv: c?.total_clv ?? null,
        churn_probability: c?.churn_probability ?? null,
      };
    });

  return delay({
    windows: [7, 30, 90].map((days) => ({
      days,
      revenue: windowRevenue(days),
      unique_orders: Math.round(windowRevenue(days) / 55),
      unique_customers: Math.round(windowRevenue(days) / 140),
      aov: 55,
    })),
    daily_series_90d: series,
    top_skus_90d: topSkus,
    top_customers_90d: topCustomers,
    channel_breakdown_90d: [
      { channel: "Online Store", revenue: windowRevenue(90) * 0.72, unique_orders: 140, line_items: 210 },
      { channel: "POS", revenue: windowRevenue(90) * 0.28, unique_orders: 60, line_items: 80 },
    ],
  });
};

export type BuyListRow = {
  ingredient_master_item_id: string;
  ingredient_name: string;
  supplier_name: string | null;
  weeks_of_stock_remaining: number | null;
  suggested_units_to_buy: number | null;
  purchase_unit: string | null;
  suggested_total_cost: number | null;
};
export const fetchBuyList = async (_params?: { only_short?: boolean }): Promise<BuyListRow[]> => {
  const db = getDb();
  const rows = db.masterItems
    .filter((i) => i.item_type !== "product" && i.low_stock)
    .map((i) => ({
      ingredient_master_item_id: i.id,
      ingredient_name: i.name,
      supplier_name: "Ontario Bulk Supply Co.",
      weeks_of_stock_remaining: 0.5 + Math.random() * 1.5,
      suggested_units_to_buy: 500,
      purchase_unit: i.measurement_unit,
      suggested_total_cost: 220 + Math.random() * 200,
    }));
  return delay(rows);
};

export type AirtableStatus = {
  configured: boolean;
  auto_sync_enabled: boolean;
  last_sync_by_table: Record<string, string | null>;
};
export const fetchAirtableStatus = async (): Promise<AirtableStatus> => {
  const keys = ["master_items", "variants", "transactions", "transfers", "production_runs", "suppliers_ingredients", "bom_lines", "orders", "wholesale_pricing"];
  const last_sync_by_table: Record<string, string | null> = {};
  for (const k of keys) last_sync_by_table[k] = new Date(Date.now() - 20 * 60_000).toISOString();
  return delay({ configured: true, auto_sync_enabled: true, last_sync_by_table });
};

export type AirtableSyncErrorRow = { id: string; operation: string | null; error_cause: string | null; resolved: boolean; created_at: string };
export const listAirtableSyncErrors = async (_params?: { only_unresolved?: boolean; limit?: number }): Promise<AirtableSyncErrorRow[]> => delay([]);

export type WebhookEvent = { id: string; source: string; topic: string; status: string; received_at: string };
export const listWebhookEvents = async (params?: { limit?: number }): Promise<WebhookEvent[]> => {
  const db = getDb();
  return delay(db.webhookEvents.slice(0, params?.limit ?? 6));
};

export type Recommendation = { id: string; action: "make" | "order"; item_name: string };
export const fetchRecommendations = async (_location: string, _includeAll: boolean): Promise<Recommendation[]> => {
  const db = getDb();
  const low = db.masterItems.filter((i) => i.low_stock);
  return delay(
    low.map((i) => ({ id: i.id, action: i.item_type === "product" ? "make" : "order", item_name: i.name } as Recommendation)),
  );
};

export type TransferV2 = { id: string; master_item_name: string; quantity: number; from_warehouse: string; to_warehouse: string; status: "planned" | "in_transit" | "received" };
export const listTransfersV2 = async (): Promise<TransferV2[]> => {
  const db = getDb();
  return delay(db.transfersV2.map((t) => ({ ...t })));
};

// ─── Local notes (polymorphic annotations) ───────────────────────────────

export type LocalNote = { note: string | null; updated_at: string; updated_by_email: string };
export const fetchLocalNote = async (entityType: string, entityId: string): Promise<LocalNote | null> => {
  const db = getDb();
  return delay(db.localNotes[`${entityType}:${entityId}`] ?? null);
};
export const upsertLocalNote = async (entityType: string, entityId: string, note: string | null): Promise<LocalNote> =>
  delay(
    mutateDb((db) => {
      const me = toCurrentUser(db, getCurrentPersonaId() ?? PERSONA_KEYS.admin);
      const rec: LocalNote = { note, updated_at: nowIso(), updated_by_email: me?.email ?? "demo@northboundops.example" };
      db.localNotes[`${entityType}:${entityId}`] = rec;
      return rec;
    }),
  );

// ─── Customers ────────────────────────────────────────────────────────────

export type CustomerDetail = Db["customers"][number];
export type CustomerOrderLine = Db["orderLines"][number];
export type CustomerDetailResponse = {
  customer: CustomerDetail;
  orders: CustomerOrderLine[];
  orders_in_db: number;
  revenue_in_db: number;
};
export const fetchCustomerDetail = async (customerId: string): Promise<CustomerDetailResponse> => {
  const db = getDb();
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) throw new ApiError(404, "Customer not found.");
  const orders = db.orderLines.filter((o) => o.customer_id === customerId);
  return delay({
    customer,
    orders,
    orders_in_db: orders.length,
    revenue_in_db: orders.reduce((acc, o) => acc + o.line_item_subtotal, 0),
  });
};

// ─── Production scheduling ──────────────────────────────────────────────

export type ProductionRunStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type ProductionRunType = "finished" | "bagged_sealed_only";
export type ProductionRunStaff = { user_id: string; full_name: string; hours: number; shift_hours: number | null };

export type ProductionRun = {
  id: string;
  finished_item_id: string;
  recipe_id: string | null;
  scheduled_date: string;
  status: ProductionRunStatus;
  run_type: ProductionRunType;
  staff_count_planned: number;
  hours_planned: number;
  target_qty: number | null;
  completed_qty: number | null;
  completed_at: string | null;
  bagged_at: string | null;
  sealed_at: string | null;
  bag_minutes: number | null;
  seal_minutes: number | null;
  bag_seal_staff_count: number | null;
  include_bag_seal_hours: boolean;
  packaging_minutes: number | null;
  include_packaging_hours: boolean;
  packaging_staff_count: number | null;
  qc_errors: string | null;
  baths_per_hour_per_person: number | null;
  ledger_committed: boolean;
  notes: string | null;
  staff: ProductionRunStaff[];
  hours_total: number;
  rate: number;
};

function computeRate(item_id: string, db: Db): number {
  return db.productionRates.find((r) => r.item_id === item_id)?.rate ?? 55;
}

function toProductionRun(db: Db, r: Db["productionRuns"][number]): ProductionRun {
  const hours_total = r.staff.reduce((acc, s) => acc + s.hours, 0) || r.staff_count_planned * r.hours_planned;
  return {
    id: r.id,
    finished_item_id: r.finished_item_id,
    recipe_id: r.recipe_id,
    scheduled_date: r.scheduled_date,
    status: r.status,
    run_type: r.run_type,
    staff_count_planned: r.staff_count_planned,
    hours_planned: r.hours_planned,
    target_qty: r.target_qty,
    completed_qty: r.completed_qty,
    completed_at: r.completed_at,
    bagged_at: r.bagged_at,
    sealed_at: r.sealed_at,
    bag_minutes: r.bag_minutes,
    seal_minutes: r.seal_minutes,
    bag_seal_staff_count: r.bag_seal_staff_count,
    include_bag_seal_hours: r.include_bag_seal_hours,
    packaging_minutes: r.packaging_minutes,
    include_packaging_hours: r.include_packaging_hours,
    packaging_staff_count: r.packaging_staff_count,
    qc_errors: r.qc_errors,
    baths_per_hour_per_person: r.baths_per_hour_per_person,
    ledger_committed: r.ledger_committed,
    notes: r.notes,
    staff: r.staff.map((s) => ({
      user_id: s.user_id,
      full_name: db.users.find((u) => u.id === s.user_id)?.full_name ?? "Unknown",
      hours: s.hours,
      shift_hours: s.shift_hours,
    })),
    hours_total,
    rate: r.baths_per_hour_per_person ?? computeRate(r.finished_item_id, db),
  };
}

export const listProductionRuns = async (params?: { status?: ProductionRunStatus; from_date?: string; to_date?: string }): Promise<ProductionRun[]> => {
  const db = getDb();
  let rows = db.productionRuns;
  if (params?.status) rows = rows.filter((r) => r.status === params.status);
  if (params?.from_date) rows = rows.filter((r) => r.scheduled_date >= params.from_date!);
  if (params?.to_date) rows = rows.filter((r) => r.scheduled_date <= params.to_date!);
  return delay(rows.map((r) => toProductionRun(db, r)).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date)));
};

export const fetchProductionRun = async (id: string): Promise<ProductionRun> => {
  const db = getDb();
  const r = db.productionRuns.find((x) => x.id === id);
  if (!r) throw new ApiError(404, "Production run not found.");
  return delay(toProductionRun(db, r));
};

export const createProductionRun = async (body: {
  finished_item_id: string;
  scheduled_date: string;
  run_type?: ProductionRunType;
  staff_count_planned?: number;
  hours_planned?: number;
  notes?: string | null;
}): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const recipe = db.recipes.find((rc) => rc.finished_item_id === body.finished_item_id) ?? null;
      const run: Db["productionRuns"][number] = {
        id: uid("run"),
        finished_item_id: body.finished_item_id,
        recipe_id: recipe?.id ?? null,
        scheduled_date: body.scheduled_date,
        status: "planned",
        run_type: body.run_type ?? "finished",
        staff_count_planned: body.staff_count_planned ?? 2,
        hours_planned: body.hours_planned ?? 8,
        target_qty: (body.staff_count_planned ?? 2) * (body.hours_planned ?? 8) * computeRate(body.finished_item_id, db),
        completed_qty: null,
        completed_at: null,
        bagged_at: null,
        sealed_at: null,
        bag_minutes: null,
        seal_minutes: null,
        bag_seal_staff_count: null,
        include_bag_seal_hours: false,
        packaging_minutes: null,
        include_packaging_hours: false,
        packaging_staff_count: null,
        qc_errors: null,
        baths_per_hour_per_person: null,
        notes: body.notes ?? null,
        staff: [],
        ledger_committed: false,
      };
      db.productionRuns.push(run);
      return toProductionRun(db, run);
    }),
  );

export const updateProductionRun = async (
  id: string,
  body: Partial<{
    scheduled_date: string;
    staff_count_planned: number;
    hours_planned: number;
    notes: string | null;
    status: ProductionRunStatus;
    run_type: ProductionRunType;
    recipe_id: string;
    finished_item_id: string;
    baths_per_hour_per_person: number | null;
    qc_errors: string | null;
    packaging_minutes: number | null;
    include_packaging_hours: boolean;
    packaging_staff_count: number | null;
    bag_seal_staff_count: number | null;
    include_bag_seal_hours: boolean;
  }>,
): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      Object.assign(r, body);
      if (body.staff_count_planned !== undefined || body.hours_planned !== undefined) {
        r.target_qty = r.staff_count_planned * r.hours_planned * computeRate(r.finished_item_id, db);
      }
      return toProductionRun(db, r);
    }),
  );

export const deleteProductionRun = async (id: string, _force?: boolean): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      db.productionRuns = db.productionRuns.filter((r) => r.id !== id);
      return undefined;
    }),
  );

export const rescheduleProductionRun = async (id: string): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      let next = new Date(Date.now() + 86_400_000);
      while (next.getDay() === 0 || next.getDay() === 6) next = new Date(next.getTime() + 86_400_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      r.scheduled_date = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
      return toProductionRun(db, r);
    }),
  );

export const completeProductionRun = async (
  id: string,
  body: { completed_qty: number; location_code?: string },
): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      r.status = "completed";
      r.completed_qty = body.completed_qty;
      r.completed_at = nowIso();
      r.ledger_committed = true;
      const item = db.masterItems.find((i) => i.id === r.finished_item_id);
      if (item) item.on_hand += body.completed_qty;
      return toProductionRun(db, r);
    }),
  );

export const adjustProductionRunQty = async (id: string, body: { new_completed_qty: number }): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      const delta = body.new_completed_qty - (r.completed_qty ?? 0);
      r.completed_qty = body.new_completed_qty;
      const item = db.masterItems.find((i) => i.id === r.finished_item_id);
      if (item) item.on_hand += delta;
      return toProductionRun(db, r);
    }),
  );

export const correctProductionRunItem = async (id: string, newItemId: string): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      r.finished_item_id = newItemId;
      r.recipe_id = db.recipes.find((rc) => rc.finished_item_id === newItemId)?.id ?? null;
      return toProductionRun(db, r);
    }),
  );

export const markProductionRunBagged = async (id: string, minutes?: number): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      r.bagged_at = nowIso();
      if (minutes !== undefined) r.bag_minutes = minutes;
      return toProductionRun(db, r);
    }),
  );

export const markProductionRunSealed = async (id: string, minutes?: number): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === id);
      if (!r) throw new ApiError(404, "Production run not found.");
      r.sealed_at = nowIso();
      if (minutes !== undefined) r.seal_minutes = minutes;
      return toProductionRun(db, r);
    }),
  );

export const setProductionRunStaff = async (
  runId: string,
  body: { user_id: string; hours: number; shift_hours?: number | null },
): Promise<ProductionRun> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === runId);
      if (!r) throw new ApiError(404, "Production run not found.");
      const existing = r.staff.find((s) => s.user_id === body.user_id);
      if (existing) {
        existing.hours = body.hours;
        existing.shift_hours = body.shift_hours ?? existing.shift_hours;
      } else {
        r.staff.push({ user_id: body.user_id, hours: body.hours, shift_hours: body.shift_hours ?? null });
      }
      return toProductionRun(db, r);
    }),
  );

export const removeProductionRunStaff = async (runId: string, userId: string): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      const r = db.productionRuns.find((x) => x.id === runId);
      if (r) r.staff = r.staff.filter((s) => s.user_id !== userId);
      return undefined;
    }),
  );

export type BomPreflightComponent = {
  item_id: string;
  ingredient_id: string;
  name: string;
  sku: string | null;
  item_type: string;
  qty_required: number;
  on_hand: number;
  shortfall: number;
  measurement_unit: string | null;
};
export type BomPreflightReport = {
  finished_item_id: string;
  finished_sku: string;
  finished_name: string;
  recipe_id: string | null;
  target_qty: number;
  location_code: string;
  can_produce: boolean;
  missing_recipe: boolean;
  components: BomPreflightComponent[];
};

export const getBomPreflight = async (finishedItemId: string, targetQty: number): Promise<BomPreflightReport> => {
  const db = getDb();
  const finished = db.masterItems.find((i) => i.id === finishedItemId);
  const recipe = db.recipes.find((r) => r.finished_item_id === finishedItemId);
  if (!finished) throw new ApiError(404, "Item not found.");
  if (!recipe) {
    return delay({
      finished_item_id: finishedItemId,
      finished_sku: finished.sku,
      finished_name: finished.name,
      recipe_id: null,
      target_qty: targetQty,
      location_code: "toronto",
      can_produce: false,
      missing_recipe: true,
      components: [],
    });
  }
  const components = recipe.lines.map((line) => {
    const stock = db.masterItems.find((i) => i.id === line.component_item_id);
    const required = line.qty_per_unit * targetQty;
    const on_hand = stock?.on_hand ?? 0;
    return {
      item_id: line.component_item_id,
      ingredient_id: line.component_item_id,
      name: line.component_name,
      sku: line.component_sku,
      item_type: line.component_item_type,
      qty_required: required,
      on_hand,
      shortfall: Math.max(0, required - on_hand),
      measurement_unit: line.measurement_unit,
    };
  });
  return delay({
    finished_item_id: finishedItemId,
    finished_sku: finished.sku,
    finished_name: finished.name,
    recipe_id: recipe.id,
    target_qty: targetQty,
    location_code: "toronto",
    can_produce: components.every((c) => c.shortfall === 0),
    missing_recipe: false,
    components,
  });
};

export type ScheduledStaffOnDate = {
  user_id: string;
  full_name: string;
  hours: number;
  starts_at: string;
  ends_at: string;
  shift_id: string;
  role_label: string | null;
  location: string;
  is_production: boolean;
};
export const listScheduledOn = async (isoDate: string): Promise<ScheduledStaffOnDate[]> => {
  const db = getDb();
  const dayShifts = db.shifts.filter((s) => s.starts_at.startsWith(isoDate) && s.status !== "cancelled");
  const productionUserIds = new Set(
    db.productionRuns.filter((r) => r.scheduled_date === isoDate).flatMap((r) => r.staff.map((s) => s.user_id)),
  );
  return delay(
    dayShifts.map((s) => {
      const hours = Math.max(0, (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 3_600_000);
      return {
        user_id: s.user_id,
        full_name: db.users.find((u) => u.id === s.user_id)?.full_name ?? "Unknown",
        hours: Math.round(hours * 100) / 100,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        shift_id: s.id,
        role_label: s.role_label,
        location: s.location,
        is_production: productionUserIds.has(s.user_id),
      };
    }),
  );
};

// ─── Dynamic production rates ────────────────────────────────────────────

export type ProductionRateRow = {
  item_id: string;
  name: string;
  sku: string;
  rate: number | null;
  avg_hit_rate: number | null;
  runs_considered: number;
  in_band: boolean;
  band_lo: number;
  band_hi: number;
  hide_from_rates_table: boolean;
};

export const listProductionRates = async (showHidden?: boolean): Promise<ProductionRateRow[]> => {
  const db = getDb();
  const rows = db.productionRates
    .filter((r) => showHidden || !r.hidden)
    .map((r) => {
      const item = db.masterItems.find((i) => i.id === r.item_id);
      const avg = r.history.length ? r.history.reduce((a, b) => a + b, 0) / r.history.length : null;
      return {
        item_id: r.item_id,
        name: item?.name ?? "Unknown",
        sku: item?.sku ?? "",
        rate: r.rate,
        avg_hit_rate: avg,
        runs_considered: r.history.length,
        in_band: avg !== null && avg >= 0.9 && avg <= 1.0,
        band_lo: 0.9,
        band_hi: 1.0,
        hide_from_rates_table: r.hidden,
      };
    });
  return delay(rows);
};

export const getRateHistoryWindow = async (): Promise<{ window: number }> => delay({ window: getDb().rateHistoryWindow });
export const setRateHistoryWindow = async (n: number): Promise<{ window: number }> =>
  delay(mutateDb((db) => { db.rateHistoryWindow = n; return { window: n }; }));

export const recomputeRate = async (
  itemId: string,
): Promise<{ skipped?: string; new_rate?: number | null; old_rate?: number | null; avg_hit_rate?: number | null }> =>
  delay(
    mutateDb((db) => {
      const rate = db.productionRates.find((r) => r.item_id === itemId);
      if (!rate || rate.history.length === 0) return { skipped: "Not enough run history yet." };
      const avg = rate.history.reduce((a, b) => a + b, 0) / rate.history.length;
      const old_rate = rate.rate;
      if (avg < 0.9 || avg > 1.0) {
        rate.rate = Math.round((rate.rate ?? 55) * avg);
      }
      return { new_rate: rate.rate, old_rate, avg_hit_rate: avg };
    }),
  );

export const resetRateToBaseline = async (itemId: string): Promise<{ finished_name: string; new_rate: number | null }> =>
  delay(
    mutateDb((db) => {
      const rate = db.productionRates.find((r) => r.item_id === itemId);
      const item = db.masterItems.find((i) => i.id === itemId);
      if (rate) {
        rate.rate = 55;
        rate.history = [];
      }
      return { finished_name: item?.name ?? "Item", new_rate: rate?.rate ?? null };
    }),
  );

export const hideProductionRate = async (itemId: string, hidden: boolean): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      const rate = db.productionRates.find((r) => r.item_id === itemId);
      if (rate) rate.hidden = hidden;
      return undefined;
    }),
  );

export type NoHistoryReportRow = {
  item_id: string;
  sku: string | null;
  name: string;
  status: string;
  airtable_run_count: number;
  airtable_completed_count: number;
  airtable_total_finished_product: number;
  first_airtable_run_date: string | null;
  last_airtable_run_date: string | null;
  has_airtable_evidence: boolean;
};
export type NoHistoryReport = {
  total_finished_items: number;
  items_missing_native_history: number;
  items_missing_with_airtable_evidence: number;
  rows: NoHistoryReportRow[];
};
export const getProductionNoHistoryReport = async (): Promise<NoHistoryReport> => {
  const db = getDb();
  const finished = db.masterItems.filter((i) => i.item_type === "product");
  const withRuns = new Set(db.productionRuns.map((r) => r.finished_item_id));
  const missing = finished.filter((i) => !withRuns.has(i.id));
  return delay({
    total_finished_items: finished.length,
    items_missing_native_history: missing.length,
    items_missing_with_airtable_evidence: 0,
    rows: missing.map((i) => ({
      item_id: i.id,
      sku: i.sku,
      name: i.name,
      status: "no runs",
      airtable_run_count: 0,
      airtable_completed_count: 0,
      airtable_total_finished_product: 0,
      first_airtable_run_date: null,
      last_airtable_run_date: null,
      has_airtable_evidence: false,
    })),
  });
};

// Sync/drift-style operations against the (nonexistent) third-party systems —
// there's nothing real to reconcile against in the demo, so these just
// report "already in sync."
export const syncAirtableProductionRuns = async (): Promise<{ created: number; updated: number }> => delay({ created: 0, updated: 0 });
export const pushProductionRunsToAirtable = async (): Promise<{ pushed: number; skipped: number; errors: number }> =>
  delay({ pushed: 0, skipped: getDb().productionRuns.length, errors: 0 });

// ─── Inventory items + recipes ───────────────────────────────────────────

export type MasterItemWithStock = {
  id: string;
  sku: string;
  name: string;
  item_type: string;
  subcategory_at: string | null;
  stock_by_location: { location: string; quantity: number }[];
  weekly_velocity_toronto: string;
  weekly_velocity_wavecrest: string;
  measurement_unit: string | null;
};

export const listInventoryItems = async (params?: { item_type?: string; has_recipe?: boolean }): Promise<MasterItemWithStock[]> => {
  const db = getDb();
  let rows = db.masterItems;
  if (params?.item_type) rows = rows.filter((i) => i.item_type === params.item_type);
  if (params?.has_recipe) rows = rows.filter((i) => i.has_recipe);
  return delay(
    rows.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      item_type: i.item_type,
      subcategory_at: i.subcategory_at,
      stock_by_location: i.stock_by_location,
      weekly_velocity_toronto: i.weekly_velocity_toronto,
      weekly_velocity_wavecrest: i.weekly_velocity_wavecrest,
      measurement_unit: i.measurement_unit,
    })),
  );
};

export type RecipeSummary = { id: string; name: string | null; finished_item_id: string; finished_name: string };
export const listRecipes = async (onlyActive = true): Promise<RecipeSummary[]> => {
  const db = getDb();
  const rows = db.recipes.filter((r) => (onlyActive ? r.is_active : true));
  return delay(rows.map((r) => ({ id: r.id, name: r.name, finished_item_id: r.finished_item_id, finished_name: r.finished_name })));
};

export type RecipeLine = {
  id: string;
  component_sku: string;
  component_name: string;
  component_item_type: string;
  qty_per_unit: number;
  measurement_unit: string | null;
};
export type Recipe = { id: string; finished_item_id: string; name: string | null; lines: RecipeLine[] };
export const fetchRecipeByFinished = async (finishedItemId: string): Promise<Recipe> => {
  const db = getDb();
  const r = db.recipes.find((rc) => rc.finished_item_id === finishedItemId);
  if (!r) throw new ApiError(404, "No recipe for this item.");
  return delay({ id: r.id, finished_item_id: r.finished_item_id, name: r.name, lines: r.lines });
};

// ─── Kiosk clock-in ──────────────────────────────────────────────────────

export type PunchType = "clock_in" | "clock_out" | "break_start" | "break_end";
export type KioskState = "clocked_in" | "clocked_out" | "on_break";
export type KioskUserMini = { id: string; full_name: string };
export type KioskStatus = {
  state: KioskState;
  last_punch_at: string | null;
  last_punch_type: PunchType | null;
  last_location: string | null;
  break_started_at: string | null;
  break_planned_minutes: number | null;
};
export type KioskAuthResponse = { token: string; expires_in_seconds: number; user: KioskUserMini; status: KioskStatus };
export type KioskPunchResponse = { punch_type: PunchType; punched_at: string; user: KioskUserMini; status: KioskStatus };

function kioskStatusFor(db: Db, userId: string): KioskStatus {
  const punches = db.punches.filter((p) => p.user_id === userId).sort((a, b) => a.punched_at.localeCompare(b.punched_at));
  const last = punches[punches.length - 1];
  if (!last) return { state: "clocked_out", last_punch_at: null, last_punch_type: null, last_location: null, break_started_at: null, break_planned_minutes: null };
  const state: KioskState = last.punch_type === "clock_in" ? "clocked_in" : last.punch_type === "break_start" ? "on_break" : "clocked_out";
  return {
    state,
    last_punch_at: last.punched_at,
    last_punch_type: last.punch_type,
    last_location: last.location,
    break_started_at: last.punch_type === "break_start" ? last.punched_at : null,
    break_planned_minutes: last.punch_type === "break_start" ? 30 : null,
  };
}

// Shared-device PIN auth — issues a short-lived token, not a full session.
export const kioskAuth = async (pin: string, _device_id?: string | null): Promise<KioskAuthResponse> => {
  const db = getDb();
  const user = db.users.find((u) => u.has_pin && u.pin === pin);
  if (!user) throw new ApiError(401, "Invalid PIN.");
  return delay({
    token: uid("kiosktoken"),
    expires_in_seconds: 300,
    user: { id: user.id, full_name: user.full_name },
    status: kioskStatusFor(db, user.id),
  });
};

// The demo has no real kiosk-token session store; we look the acting user up
// by matching against whoever most recently authed (kept in module memory).
let lastKioskUserId: string | null = null;

export const kioskPunch = async (
  _token: string,
  opts: { punch_type?: PunchType; location?: string; device_id?: string | null } = {},
): Promise<KioskPunchResponse> =>
  delay(
    mutateDb((db) => {
      const userId = lastKioskUserId ?? db.users[0].id;
      const punch_type = opts.punch_type ?? "clock_in";
      db.punches.push({
        id: uid("punch"),
        user_id: userId,
        punch_type,
        punched_at: nowIso(),
        location: opts.location ?? "toronto",
        device_id: opts.device_id ?? null,
        reason: null,
      });
      const user = db.users.find((u) => u.id === userId)!;
      return {
        punch_type,
        punched_at: nowIso(),
        user: { id: user.id, full_name: user.full_name },
        status: kioskStatusFor(db, userId),
      };
    }),
  );

export const pairKioskDevice = async (): Promise<{ status: string }> => delay({ status: "paired" });

// ─── Timesheets ──────────────────────────────────────────────────────────

export type TimesheetRow = {
  user_id: string;
  staff_name: string;
  work_date: string;
  clock_in: string;
  clock_out: string;
  minutes: number;
  location: string;
  clock_in_punch_id: string;
  clock_out_punch_id: string;
};
export type OpenPair = { user_id: string; staff_name: string; clocked_in_at: string; location: string };
export type TimesheetPreview = {
  timezone: string;
  range_start: string;
  range_end: string;
  rows: TimesheetRow[];
  total_minutes: number;
  open_pairs: OpenPair[];
};

type DemoPunchLike = Db["punches"][number];

export const previewTimesheet = async (params: { start?: string; end?: string; user_id?: string }): Promise<TimesheetPreview> => {
  const db = getDb();
  let punches = [...db.punches].sort((a, b) => a.punched_at.localeCompare(b.punched_at));
  if (params.user_id) punches = punches.filter((p) => p.user_id === params.user_id);
  if (params.start) punches = punches.filter((p) => p.punched_at >= params.start!);
  if (params.end) punches = punches.filter((p) => p.punched_at <= `${params.end}T23:59:59.999Z`);

  const byUser = new Map<string, DemoPunchLike[]>();
  for (const p of punches) {
    if (p.punch_type !== "clock_in" && p.punch_type !== "clock_out") continue;
    (byUser.get(p.user_id) ?? byUser.set(p.user_id, []).get(p.user_id)!).push(p);
  }

  const rows: TimesheetRow[] = [];
  const open_pairs: OpenPair[] = [];
  for (const [userId, list] of byUser) {
    const user = db.users.find((u) => u.id === userId);
    let openIn: DemoPunchLike | null = null;
    for (const p of list) {
      if (p.punch_type === "clock_in") {
        if (openIn) {
          open_pairs.push({ user_id: userId, staff_name: user?.full_name ?? "Unknown", clocked_in_at: openIn.punched_at, location: openIn.location });
        }
        openIn = p;
      } else if (p.punch_type === "clock_out" && openIn) {
        const minutes = Math.round((new Date(p.punched_at).getTime() - new Date(openIn.punched_at).getTime()) / 60_000);
        rows.push({
          user_id: userId,
          staff_name: user?.full_name ?? "Unknown",
          work_date: openIn.punched_at.slice(0, 10),
          clock_in: openIn.punched_at,
          clock_out: p.punched_at,
          minutes,
          location: openIn.location,
          clock_in_punch_id: openIn.id,
          clock_out_punch_id: p.id,
        });
        openIn = null;
      }
    }
    if (openIn) {
      open_pairs.push({ user_id: userId, staff_name: user?.full_name ?? "Unknown", clocked_in_at: openIn.punched_at, location: openIn.location });
    }
  }
  rows.sort((a, b) => b.work_date.localeCompare(a.work_date));
  return delay({
    timezone: "America/Toronto",
    range_start: params.start ?? "",
    range_end: params.end ?? "",
    rows,
    total_minutes: rows.reduce((acc, r) => acc + r.minutes, 0),
    open_pairs,
  });
};

/** Builds a CSV `data:` URL client-side — there's no server to download from. */
export const timesheetCsvUrl = (params: { start?: string; end?: string; user_id?: string }): string => {
  const db = getDb();
  let punches = [...db.punches];
  if (params.user_id) punches = punches.filter((p) => p.user_id === params.user_id);
  const header = "staff_name,work_date,clock_in,clock_out,minutes,location\n";
  // Best-effort synchronous CSV rebuild mirroring previewTimesheet's pairing logic.
  const byUser = new Map<string, DemoPunchLike[]>();
  for (const p of punches.sort((a, b) => a.punched_at.localeCompare(b.punched_at))) {
    if (p.punch_type !== "clock_in" && p.punch_type !== "clock_out") continue;
    (byUser.get(p.user_id) ?? byUser.set(p.user_id, []).get(p.user_id)!).push(p);
  }
  const lines: string[] = [];
  for (const [userId, list] of byUser) {
    const user = db.users.find((u) => u.id === userId);
    let openIn: DemoPunchLike | null = null;
    for (const p of list) {
      if (p.punch_type === "clock_in") {
        openIn = p;
      } else if (p.punch_type === "clock_out" && openIn) {
        const minutes = Math.round((new Date(p.punched_at).getTime() - new Date(openIn.punched_at).getTime()) / 60_000);
        lines.push(`${user?.full_name ?? "Unknown"},${openIn.punched_at.slice(0, 10)},${openIn.punched_at},${p.punched_at},${minutes},${openIn.location}`);
        openIn = null;
      }
    }
  }
  const csv = header + lines.join("\n");
  if (typeof window === "undefined") return "data:text/csv,";
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
};

export const adminCreatePunch = async (body: {
  user_id: string;
  punch_type: PunchType;
  punched_at: string;
  location?: string;
  reason?: string;
}): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      db.punches.push({
        id: uid("punch"),
        user_id: body.user_id,
        punch_type: body.punch_type,
        punched_at: body.punched_at,
        location: body.location ?? "toronto",
        device_id: null,
        reason: body.reason ?? null,
      });
      return undefined;
    }),
  );

export const adminUpdatePunch = async (punchId: string, body: { punched_at?: string; reason?: string }): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      const p = db.punches.find((x) => x.id === punchId);
      if (p) {
        if (body.punched_at) p.punched_at = body.punched_at;
        if (body.reason) p.reason = body.reason;
      }
      return undefined;
    }),
  );

export type DispatchRule = { send_day: number; period_month_offset: -1 | 0; period_start_day: number; period_end_day: number };
export type DispatchConfig = {
  recipients: string[];
  rules: DispatchRule[];
  include_accountants: boolean;
  last_sent_period: string | null;
  last_sent_at: string | null;
};
export const fetchDispatchConfig = async (): Promise<DispatchConfig> => delay({ ...getDb().dispatchConfig });
export const updateDispatchConfig = async (body: Partial<DispatchConfig>): Promise<DispatchConfig> =>
  delay(mutateDb((db) => { db.dispatchConfig = { ...db.dispatchConfig, ...body }; return { ...db.dispatchConfig }; }));

export const triggerTimesheetDispatch = async (
  params?: { start?: string; end?: string },
): Promise<{ sent: boolean; period?: string; recipients?: string[]; failed?: string[]; reason?: string }> =>
  delay(
    mutateDb((db) => {
      const period = params?.start && params?.end ? `${params.start} – ${params.end}` : "the most recent completed period";
      db.dispatchConfig.last_sent_period = period;
      db.dispatchConfig.last_sent_at = nowIso();
      return { sent: true, period, recipients: db.dispatchConfig.recipients, failed: [] };
    }),
  );

// ─── Time off / availability / corrections / discipline ──────────────────

export type TimeOffRequest = {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  status: "pending" | "approved" | "denied";
  reason: string | null;
  reviewed_at: string | null;
  pending_modification?: boolean;
};
export const listTimeOffFiltered = async (params?: { status?: string[]; limit?: number; order?: string }): Promise<TimeOffRequest[]> => {
  const db = getDb();
  let rows = db.timeOffRequests;
  if (params?.status?.length) rows = rows.filter((r) => params.status!.includes(r.status));
  rows = [...rows].sort((a, b) => a.start_date.localeCompare(b.start_date));
  return delay(rows.slice(0, params?.limit ?? 200));
};
export const listAllTimeOff = async (status?: string): Promise<TimeOffRequest[]> => {
  const db = getDb();
  const rows = status ? db.timeOffRequests.filter((r) => r.status === status) : db.timeOffRequests;
  return delay(rows);
};
export const fetchMyTimeOff = async (): Promise<TimeOffRequest[]> => {
  const db = getDb();
  const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
  return delay(db.timeOffRequests.filter((r) => r.user_id === persona));
};
export const listTimeOffModificationsPending = async (): Promise<TimeOffRequest[]> => {
  const db = getDb();
  return delay(db.timeOffRequests.filter((r) => r.pending_modification));
};

export type UserDayAvailability = {
  user_id: string;
  is_available: boolean;
  start_time: string | null;
  end_time: string | null;
  source: "none" | "weekly" | "override";
};
export const fetchAvailabilityForDate = async (_date: string): Promise<UserDayAvailability[]> => delay([]);

export type PunchCorrectionWithUsers = {
  id: string;
  user_id: string;
  status: "pending" | "approved" | "denied";
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
};
export const listCorrectionsAdmin = async (status?: string): Promise<PunchCorrectionWithUsers[]> => {
  const db = getDb();
  const rows = status ? db.corrections.filter((c) => c.status === status) : db.corrections;
  return delay(rows);
};
export const listMyCorrections = async (): Promise<PunchCorrectionWithUsers[]> => {
  const db = getDb();
  const persona = getCurrentPersonaId() ?? PERSONA_KEYS.admin;
  return delay(db.corrections.filter((c) => c.user_id === persona));
};

export type DisciplineAction = {
  id: string;
  user_id: string;
  status: "awaiting_approval" | "approved" | "denied";
  proposed_by_user_id: string;
  approvals: { approver_user_id: string; approved_at: string }[];
  created_at: string;
};
export const listDisciplineActions = async (params?: { status?: string }): Promise<DisciplineAction[]> => {
  const db = getDb();
  const rows = params?.status ? db.disciplineActions.filter((d) => d.status === params.status) : db.disciplineActions;
  return delay(rows);
};

// ─── Shift presets / studio closures ──────────────────────────────────────

export type ShiftPreset = { id: string; label: string; start_time: string; end_time: string };
export const listShiftPresets = async (): Promise<ShiftPreset[]> => delay(getDb().shiftPresets);
export const createShiftPreset = async (body: { label: string; start_time: string; end_time: string }): Promise<ShiftPreset> =>
  delay(
    mutateDb((db) => {
      const p = { id: uid("preset"), ...body };
      db.shiftPresets.push(p);
      return p;
    }),
  );
export const deleteShiftPreset = async (id: string): Promise<undefined> =>
  delay(mutateDb((db) => { db.shiftPresets = db.shiftPresets.filter((p) => p.id !== id); return undefined; }));

export type StudioClosure = { id: string; date: string; name: string };
export const listStudioClosures = async (): Promise<StudioClosure[]> => delay(getDb().studioClosures);
export const createStudioClosure = async (body: { date: string; name: string }): Promise<StudioClosure> =>
  delay(
    mutateDb((db) => {
      const c = { id: uid("closure"), ...body };
      db.studioClosures.push(c);
      return c;
    }),
  );
export const deleteStudioClosure = async (id: string): Promise<undefined> =>
  delay(mutateDb((db) => { db.studioClosures = db.studioClosures.filter((c) => c.id !== id); return undefined; }));

// ─── Roles & capabilities (capability-based RBAC admin) ─────────────────

export type CapabilityInfo = { id: string; key: string; label: string; description: string; category: string; group: string };
export type CapabilityCatalog = {
  capabilities: CapabilityInfo[];
  role_defaults: Record<Role, string[]>;
};
export const fetchCapabilityCatalog = async (): Promise<CapabilityCatalog> => {
  const db = getDb();
  const role_defaults: Record<string, string[]> = {};
  for (const r of db.roles) role_defaults[r.key] = r.canonical_capabilities;
  return delay({
    capabilities: CAPABILITY_CATALOG.map((c) => ({ id: c.id, key: c.id, label: c.label, description: c.description, category: c.category, group: c.category })),
    role_defaults,
  });
};

export type RoleDefinition = {
  key: string;
  label: string;
  description: string | null;
  is_built_in: boolean;
  default_capabilities: string[];
  canonical_capabilities: string[];
};
export const listRoles = async (): Promise<RoleDefinition[]> => delay(getDb().roles.map((r) => ({ ...r })));
export const fetchRole = async (key: string): Promise<RoleDefinition> => {
  const db = getDb();
  const r = db.roles.find((x) => x.key === key);
  if (!r) throw new ApiError(404, "Role not found.");
  return delay({ ...r });
};
export const updateRole = async (
  key: string,
  body: { label?: string; description?: string | null; default_capabilities?: string[] },
): Promise<RoleDefinition> =>
  delay(
    mutateDb((db) => {
      const r = db.roles.find((x) => x.key === key);
      if (!r) throw new ApiError(404, "Role not found.");
      if (body.label !== undefined) r.label = body.label;
      if (body.description !== undefined) r.description = body.description;
      if (body.default_capabilities !== undefined) r.default_capabilities = body.default_capabilities;
      return { ...r };
    }),
  );
export const createRole = async (body: { key: string; label: string; description?: string | null; based_on?: string | null }): Promise<RoleDefinition> =>
  delay(
    mutateDb((db) => {
      const basedOn = body.based_on ? db.roles.find((r) => r.key === body.based_on) : null;
      const role: RoleDefinition = {
        key: body.key,
        label: body.label,
        description: body.description ?? null,
        is_built_in: false,
        default_capabilities: basedOn ? [...basedOn.default_capabilities] : [],
        canonical_capabilities: basedOn ? [...basedOn.default_capabilities] : [],
      };
      db.roles.push(role);
      return { ...role };
    }),
  );
export const deleteRole = async (key: string): Promise<undefined> =>
  delay(mutateDb((db) => { db.roles = db.roles.filter((r) => r.key !== key); return undefined; }));
export const resetRoleToCanonical = async (key: string): Promise<RoleDefinition> =>
  delay(
    mutateDb((db) => {
      const r = db.roles.find((x) => x.key === key);
      if (!r) throw new ApiError(404, "Role not found.");
      r.default_capabilities = [...r.canonical_capabilities];
      return { ...r };
    }),
  );
export const resetRoleToFactory = async (key: string): Promise<RoleDefinition> =>
  delay(
    mutateDb((db) => {
      const r = db.roles.find((x) => x.key === key);
      if (!r) throw new ApiError(404, "Role not found.");
      const factory = ROLE_DEFAULTS_FALLBACK[key] ?? [];
      r.default_capabilities = [...factory];
      r.canonical_capabilities = [...factory];
      return { ...r };
    }),
  );
export const saveRoleAsCanonical = async (key: string): Promise<RoleDefinition> =>
  delay(
    mutateDb((db) => {
      const r = db.roles.find((x) => x.key === key);
      if (!r) throw new ApiError(404, "Role not found.");
      r.canonical_capabilities = [...r.default_capabilities];
      return { ...r };
    }),
  );

const ROLE_DEFAULTS_FALLBACK: Record<string, string[]> = {
  super_admin: CAPABILITY_CATALOG.map((c) => c.id),
  admin: CAPABILITY_CATALOG.map((c) => c.id),
  manager: ["manage_schedule", "review_corrections", "edit_others_punches", "print_qr", "view_timesheets", "export_timesheets", "view_users", "view_inventory", "manage_inventory", "edit_recipes", "manage_production_runs", "view_discipline_documents"],
  assistant_manager: ["manage_schedule", "review_corrections", "print_qr", "view_timesheets", "view_inventory", "view_discipline_documents"],
  accountant: ["view_timesheets", "export_timesheets", "approve_reconciliations", "view_users"],
  staff: [],
};

// ─── Users admin ─────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  user_type: "internal" | "external";
  is_active: boolean;
  is_terminated?: boolean;
  terminated_at: string | null;
  phone_e164: string | null;
  has_pin: boolean;
  ec_name?: string | null;
  ec_relationship?: string | null;
  ec_phone?: string | null;
  ec_notes?: string | null;
};

function toAdminUser(u: Db["users"][number]): AdminUser {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    user_type: u.user_type,
    is_active: u.is_active,
    is_terminated: u.is_terminated,
    terminated_at: u.terminated_at,
    phone_e164: u.phone_e164,
    has_pin: u.has_pin,
    ec_name: u.ec_name,
    ec_relationship: u.ec_relationship,
    ec_phone: u.ec_phone,
    ec_notes: u.ec_notes,
  };
}

export const adminListUsers = async (includeTerminated?: boolean): Promise<AdminUser[]> => {
  const db = getDb();
  const rows = includeTerminated ? db.users : db.users.filter((u) => !u.terminated_at);
  return delay(rows.map(toAdminUser));
};

export const adminUpdateUser = async (id: string, data: { full_name?: string }): Promise<AdminUser> =>
  delay(
    mutateDb((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "User not found.");
      if (data.full_name) u.full_name = data.full_name;
      return toAdminUser(u);
    }),
  );

export const adminUpdateRole = async (id: string, role: Role): Promise<AdminUser> =>
  delay(
    mutateDb((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "User not found.");
      u.role = role;
      const def = db.roles.find((r) => r.key === role);
      u.capabilities = def ? [...def.default_capabilities] : [];
      return toAdminUser(u);
    }),
  );

export const adminSetActive = async (id: string, active: boolean): Promise<AdminUser> =>
  delay(mutateDb((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, "User not found.");
    u.is_active = active;
    return toAdminUser(u);
  }));

export const terminateUser = async (id: string): Promise<AdminUser> =>
  delay(mutateDb((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, "User not found.");
    u.terminated_at = nowIso();
    u.is_active = false;
    u.is_terminated = true;
    for (const s of db.shifts) {
      if (s.user_id === id && new Date(s.starts_at).getTime() > Date.now()) s.status = "cancelled";
    }
    return toAdminUser(u);
  }));

export const restoreUserViewOnly = async (id: string): Promise<AdminUser> =>
  delay(mutateDb((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, "User not found.");
    u.is_active = true;
    return toAdminUser(u);
  }));

export const rehireUser = async (id: string): Promise<AdminUser> =>
  delay(mutateDb((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new ApiError(404, "User not found.");
    u.terminated_at = null;
    u.is_terminated = false;
    u.is_active = true;
    return toAdminUser(u);
  }));

export const adminSendPasswordReset = async (_userId: string): Promise<{ email_sent: boolean; reset_url?: string | null }> =>
  delay({ email_sent: true, reset_url: null });

export const updateKioskCreds = async (
  id: string,
  body: { phone?: string | null; pin?: string | null; clear_pin?: boolean },
): Promise<AdminUser> =>
  delay(
    mutateDb((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "User not found.");
      if (body.phone !== undefined) u.phone_e164 = body.phone;
      if (body.clear_pin) {
        u.pin = null;
        u.has_pin = false;
      } else if (body.pin) {
        u.pin = body.pin;
        u.has_pin = true;
      }
      return toAdminUser(u);
    }),
  );

export const resetKioskPin = async (id: string): Promise<{ new_pin: string; email_sent: boolean }> =>
  delay(
    mutateDb((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "User not found.");
      const pin = String(1000 + Math.floor(Math.random() * 9000));
      u.pin = pin;
      u.has_pin = true;
      return { new_pin: pin, email_sent: true };
    }),
  );

export const kioskUnlock = async (_id: string): Promise<undefined> => delay(undefined);

export type EmergencyContactData = {
  ec_name: string | null;
  ec_relationship: string | null;
  ec_phone: string | null;
  ec_notes: string | null;
};
export const updateEmergencyContact = async (id: string, data: EmergencyContactData): Promise<AdminUser> =>
  delay(
    mutateDb((db) => {
      const u = db.users.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "User not found.");
      u.ec_name = data.ec_name;
      u.ec_relationship = data.ec_relationship;
      u.ec_phone = data.ec_phone;
      u.ec_notes = data.ec_notes;
      return toAdminUser(u);
    }),
  );

// ─── Invites ──────────────────────────────────────────────────────────────

export type Invite = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
export type InviteCreated = Invite & { accept_url: string };

export const adminListInvites = async (): Promise<Invite[]> => delay(getDb().invites.map(({ token: _t, ...rest }) => rest));

export const adminCreateInvite = async (body: {
  email: string;
  full_name: string;
  role: Role;
  expires_in_days?: number;
}): Promise<InviteCreated> =>
  delay(
    mutateDb((db) => {
      const invite = {
        id: uid("invite"),
        email: body.email,
        full_name: body.full_name,
        role: body.role,
        created_at: nowIso(),
        expires_at: new Date(Date.now() + (body.expires_in_days ?? 30) * 86_400_000).toISOString(),
        accepted_at: null,
        revoked_at: null,
        token: uid("invitetoken"),
      };
      db.invites.push(invite);
      const { token, ...rest } = invite;
      const accept_url =
        typeof window !== "undefined" ? `${window.location.origin}/accept-invite/${token}` : `https://example.invalid/accept-invite/${token}`;
      return { ...rest, accept_url };
    }),
  );

export const adminRevokeInvite = async (id: string): Promise<undefined> =>
  delay(
    mutateDb((db) => {
      const inv = db.invites.find((i) => i.id === id);
      if (inv) inv.revoked_at = nowIso();
      return undefined;
    }),
  );
