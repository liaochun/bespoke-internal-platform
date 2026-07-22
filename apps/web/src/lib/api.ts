// Excerpted from a private production codebase for portfolio purposes.
//
// The real `api.ts` in this codebase is ~5,400 lines / ~370 typed functions
// covering the platform's entire API surface (inventory, Airtable sync,
// Shopify sync, transfers/customs docs, timesheets, discipline, kiosk
// pairing, notification preferences, and more). Reproducing all of that
// here would just be a roundabout way of handing over the full private API
// surface, which is exactly what this excerpt is intentionally NOT doing.
//
// Instead, this file re-implements only the `api<T>()` fetch helper, the
// `ApiError` class, and a curated slice of the functions/types the six
// included page groups call — enough for the shapes to read as internally
// consistent, not enough to be a drop-in replacement. The full copied pages
// (see apps/web/src/app/**) reference additional endpoints beyond this
// slice; that's expected. This is not a runnable standalone application.

function resolveApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_API_URL must be set in production builds");
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "http://localhost:8000";
}

export const API_URL = resolveApiUrl();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Auth / nav chrome ──────────────────────────────────────────────────

export type Role =
  | "super_admin"
  | "admin"
  | "manager"
  | "assistant_manager"
  | "accountant"
  | "staff"
  | (string & {});

export type CurrentUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  user_type: "internal" | "external";
  is_active: boolean;
  capabilities: string[];
};

export const fetchMe = () => api<CurrentUser>("/auth/me");
export const logout = () => api<{ status: string }>("/auth/logout", { method: "POST" });

export type NavLayoutSection = "workforce" | "inventory" | "admin" | "me";
export type NavLayout = {
  sections: Partial<Record<NavLayoutSection, string[]>>;
};
export const fetchNavLayout = () => api<NavLayout>("/nav-layout");

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
export const globalSearch = (q: string) =>
  api<GlobalSearchResponse>(`/inventory/search?q=${encodeURIComponent(q)}`);

// ─── Shifts + the sick-call / first-to-claim workflow ──────────────────
// (see apps/api/app/services/sick_call.py for the backend half of this —
// this is the one flow in the excerpt kept at full fidelity end to end.)

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

export const listShifts = (params?: { start?: string; end?: string; user_id?: string }) => {
  const q = new URLSearchParams();
  if (params?.start) q.set("start", params.start);
  if (params?.end) q.set("end", params.end);
  if (params?.user_id) q.set("user_id", params.user_id);
  const qs = q.toString();
  return api<ShiftWithStaff[]>(`/shifts${qs ? `?${qs}` : ""}`);
};

export const createShift = (body: ShiftCreateInput) =>
  api<ShiftWithStaff>("/shifts", { method: "POST", body: JSON.stringify(body) });

export const updateShift = (id: string, body: ShiftUpdateInput) =>
  api<ShiftWithStaff>(`/shifts/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const cancelShift = (id: string) => api<undefined>(`/shifts/${id}`, { method: "DELETE" });

export const fetchMyShifts = (days = 14, back = 0) =>
  api<Shift[]>(`/shifts/me?days=${days}&back=${back}`);

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

// Staff: self-report calling in sick on an upcoming scheduled shift.
export const callInSick = (shiftId: string, note?: string) =>
  api<SickCall>(`/me/shifts/${shiftId}/sick`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });

// Manager: record a sick call on a staff member's behalf.
export const adminMarkShiftSick = (shiftId: string, note?: string) =>
  api<SickCall>(`/admin/shifts/${shiftId}/sick`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });

export const listSickCalls = (params?: {
  status?: SickCallStatus;
  user_id?: string;
  from_date?: string;
  to_date?: string;
}) => {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.user_id) q.set("user_id", params.user_id);
  if (params?.from_date) q.set("from_date", params.from_date);
  if (params?.to_date) q.set("to_date", params.to_date);
  const qs = q.toString();
  return api<SickCall[]>(`/admin/sick-calls${qs ? `?${qs}` : ""}`);
};

export const listStaffUpcomingShifts = (userId: string) =>
  api<Shift[]>(`/admin/staff/${userId}/upcoming-shifts`);

export const dismissSickCall = (shiftId: string, note?: string) =>
  api<SickCall>(`/admin/sick-calls/${shiftId}/dismiss`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });

// Opens the shift up to every eligible, available, unscheduled candidate —
// first to click their unique claim link gets it (see sick_call.py).
export const openClaimOffer = (shiftId: string) =>
  api<{ offer: ClaimOffer; candidate_count: number }>(
    `/admin/sick-calls/${shiftId}/open-offer`,
    { method: "POST" },
  );

export const getClaimOffer = (shiftId: string) =>
  api<ClaimOffer>(`/admin/sick-calls/${shiftId}/offer`);

export const cancelClaimOffer = (shiftId: string, reason?: string) =>
  api<ClaimOffer>(`/admin/sick-calls/${shiftId}/cancel-offer`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? null }),
  });

// Unauthenticated (the 64-char claim_token itself is the credential) --
// backs the /shifts/claim/[token] page.
export const previewClaim = (token: string) => api<ClaimPreview>(`/shifts/claim/${token}/preview`);

export const claimShift = (token: string) =>
  api<{ shift: Shift; message: string }>(`/shifts/claim/${token}`, { method: "POST" });

export type SubHistoryEntry = {
  shift_id: string;
  shift_starts_at: string;
  shift_ends_at: string;
  sick_user: { id: string; full_name: string; email: string };
  opened_by: { id: string; full_name: string; email: string };
  opened_at: string;
  expires_at: string;
  candidates: { id: string; full_name: string; email: string }[];
  claimed_by: { id: string; full_name: string; email: string } | null;
  claimed_at: string | null;
  cancelled: boolean;
};

export const getOfferHistory = (params?: { limit?: number; offset?: number }) => {
  const q = new URLSearchParams();
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  const qs = q.toString();
  return api<SubHistoryEntry[]>(`/admin/sick-calls/offer-history${qs ? `?${qs}` : ""}`);
};

export type SubLeaderboardEntry = {
  user: { id: string; full_name: string; email: string };
  times_contacted: number;
  shifts_claimed: number;
};
export const getSubLeaderboard = () =>
  api<SubLeaderboardEntry[]>("/admin/sick-calls/sub-leaderboard");

// ─── Inventory dashboard (simplified — the real payload nests several
// more read-only mirror-table summaries not reproduced here) ───────────

export type InventoryDashboard = {
  stats: {
    total_variants: number;
    linked_variants: number;
    critical_count: number;
  };
  low_stock: { id: string; sku: string; name: string; on_hand: number }[];
  recent_production_runs: { id: string; name: string | null; status: string | null }[];
};
export const fetchInventoryDashboard = () => api<InventoryDashboard>("/inventory/dashboard");

// ─── Production scheduling ──────────────────────────────────────────────

export type ProductionRunStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type ProductionRunType = "finished" | "bagged_sealed_only";

export type ProductionRunStaff = { user_id: string; full_name: string; hours: number };

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
  ledger_committed: boolean;
  notes: string | null;
  staff: ProductionRunStaff[];
  hours_total: number;
  rate: number;
};

export const listProductionRuns = (params?: {
  status?: ProductionRunStatus;
  from_date?: string;
  to_date?: string;
}) => {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.from_date) q.set("from_date", params.from_date);
  if (params?.to_date) q.set("to_date", params.to_date);
  const qs = q.toString();
  return api<ProductionRun[]>(`/production-runs${qs ? `?${qs}` : ""}`);
};

export const createProductionRun = (body: {
  finished_item_id: string;
  scheduled_date: string;
  run_type?: ProductionRunType;
  staff_count_planned?: number;
  hours_planned?: number;
  notes?: string | null;
}) => api<ProductionRun>("/production-runs", { method: "POST", body: JSON.stringify(body) });

export const updateProductionRun = (
  id: string,
  body: {
    scheduled_date?: string;
    staff_count_planned?: number;
    hours_planned?: number;
    notes?: string | null;
  },
) => api<ProductionRun>(`/production-runs/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const completeProductionRun = (
  id: string,
  body: { completed_qty: number; location_code?: string },
) =>
  api<ProductionRun>(`/production-runs/${id}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export type BomPreflightComponent = {
  ingredient_id: string;
  name: string;
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
// Dry-run BOM check — "can we actually produce this many, given current
// on-hand ingredient stock" — before a run is scheduled/confirmed.
export const getBomPreflight = (finishedItemId: string, targetQty: number) =>
  api<BomPreflightReport>(
    `/production-runs/preflight?finished_item_id=${finishedItemId}&target_qty=${targetQty}`,
  );

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
export const listScheduledOn = (isoDate: string) =>
  api<ScheduledStaffOnDate[]>(`/shifts/scheduled-on/${isoDate}`);

// ─── Kiosk clock-in ──────────────────────────────────────────────────────

export type PunchType = "clock_in" | "clock_out" | "break_start" | "break_end";
export type KioskState = "clocked_in" | "clocked_out" | "on_break";
export type KioskUserMini = { id: string; full_name: string };
export type KioskStatus = {
  state: KioskState;
  last_punch_at: string | null;
  last_punch_type: PunchType | null;
  last_location: string | null;
};
export type KioskAuthResponse = {
  token: string;
  expires_in_seconds: number;
  user: KioskUserMini;
  status: KioskStatus;
};
export type KioskPunchResponse = {
  punch_type: PunchType;
  punched_at: string;
  user: KioskUserMini;
  status: KioskStatus;
};

// Shared-device PIN auth — issues a short-lived token, not a full session.
export const kioskAuth = (pin: string, device_id?: string | null) =>
  api<KioskAuthResponse>("/kiosk/auth", {
    method: "POST",
    body: JSON.stringify({ pin, device_id: device_id ?? null }),
  });

export const kioskPunch = (
  token: string,
  opts: { punch_type?: PunchType; location?: string; device_id?: string | null } = {},
) =>
  api<KioskPunchResponse>("/kiosk/punch", {
    method: "POST",
    body: JSON.stringify({
      token,
      punch_type: opts.punch_type ?? null,
      location: opts.location ?? null,
      device_id: opts.device_id ?? null,
    }),
  });

// ─── Timesheets ──────────────────────────────────────────────────────────

export type TimesheetRow = {
  user_id: string;
  full_name: string;
  total_minutes: number;
};
export type OpenPair = { user_id: string; full_name: string; clock_in_at: string };
export type TimesheetPreview = {
  timezone: string;
  range_start: string;
  range_end: string;
  rows: TimesheetRow[];
  total_minutes: number;
  open_pairs: OpenPair[];
};
export const previewTimesheet = (params: { start?: string; end?: string; user_id?: string }) => {
  const q = new URLSearchParams();
  if (params.start) q.set("start", params.start);
  if (params.end) q.set("end", params.end);
  if (params.user_id) q.set("user_id", params.user_id);
  const qs = q.toString();
  return api<TimesheetPreview>(`/timesheets/preview${qs ? `?${qs}` : ""}`);
};

// ─── Roles & capabilities (capability-based RBAC admin) ─────────────────

export type CapabilityInfo = { key: string; label: string; group: string };
export type CapabilityCatalog = {
  capabilities: CapabilityInfo[];
  role_defaults: Record<Role, string[]>;
};
export const fetchCapabilityCatalog = () => api<CapabilityCatalog>("/roles/capabilities");

export type RoleDefinition = {
  key: string;
  label: string;
  description: string | null;
  is_built_in: boolean;
  default_capabilities: string[];
  canonical_capabilities: string[];
};
export const listRoles = () => api<RoleDefinition[]>("/roles");
export const fetchRole = (key: string) => api<RoleDefinition>(`/roles/${key}`);
export const updateRole = (
  key: string,
  body: { label?: string; description?: string | null; default_capabilities?: string[] },
) => api<RoleDefinition>(`/roles/${key}`, { method: "PATCH", body: JSON.stringify(body) });

// ─── Users admin ─────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  user_type: "internal" | "external";
  is_active: boolean;
  is_terminated?: boolean;
};
export const adminListUsers = (includeTerminated?: boolean) =>
  api<AdminUser[]>(`/users${includeTerminated ? "?include_terminated=true" : ""}`);

export const adminUpdateUser = (id: string, data: { full_name?: string }) =>
  api<AdminUser>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data) });

export const adminUpdateRole = (id: string, role: Role) =>
  api<AdminUser>(`/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
