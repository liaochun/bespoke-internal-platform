// Client-side "database" for the static demo build.
//
// NOTE: this module and demoSeed.ts import from each other (demoSeed needs
// `uid`; this module needs `seedDb` for first-visit seeding). That's safe
// here because the only value demoSeed pulls from this module is the
// hoisted function declaration `uid`, so it exists on this module's exports
// object before either module's top-level statements finish running.
//
// Everything the app used to fetch from a FastAPI backend now lives here as
// plain JS objects/arrays, persisted to `localStorage` as one JSON blob under
// DB_KEY. This is intentionally a simple, single-writer, single-tab store —
// there's no real backend, no auth, and no concurrent-writer story to worry
// about. Loaded lazily on first access, saved after every mutation.
//
// See demoSeed.ts for how the store is populated the first time a visitor
// loads the app. See api.ts for the public functions pages actually call.

import { seedDb } from "./demoSeed";

export const DB_KEY = "northbound-demo-v1";
export const PERSONA_KEY = "northbound-demo-persona-v1";

// ─── Entity shapes ──────────────────────────────────────────────────────
// Plain data shapes for everything the demo "persists." Kept intentionally
// loose (lots of `| null`, few invariants enforced) since this is a demo
// data layer, not a schema migration target.

export type DemoRole = "super_admin" | "admin" | "manager" | "assistant_manager" | "accountant" | "staff" | (string & {});

export interface DemoUser {
  id: string;
  email: string;
  full_name: string;
  role: DemoRole;
  user_type: "internal" | "external";
  is_active: boolean;
  is_terminated?: boolean;
  terminated_at: string | null;
  phone_e164: string | null;
  has_pin: boolean;
  pin: string | null;
  ec_name: string | null;
  ec_relationship: string | null;
  ec_phone: string | null;
  ec_notes: string | null;
  capabilities: string[];
}

export interface DemoShift {
  id: string;
  user_id: string;
  location: string;
  role_label: string | null;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "in_progress" | "completed" | "missed" | "cancelled";
  notes: string | null;
  sick_called_at: string | null;
  sick_call_note: string | null;
  sick_call_status: "pending_review" | "dismissed" | "filling" | "filled" | null;
  called_in_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DemoClaimOffer {
  id: string;
  shift_id: string;
  opened_by_user_id: string;
  opened_at: string;
  expires_at: string;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  candidate_user_ids: string[];
  claim_token: string;
}

export interface DemoShiftPreset {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
}

export interface DemoStudioClosure {
  id: string;
  date: string;
  name: string;
}

export interface DemoTimeOffRequest {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  status: "pending" | "approved" | "denied";
  reason: string | null;
  reviewed_at: string | null;
  pending_modification?: boolean;
}

export interface DemoPunch {
  id: string;
  user_id: string;
  punch_type: "clock_in" | "clock_out" | "break_start" | "break_end";
  punched_at: string;
  location: string;
  device_id: string | null;
  reason: string | null;
}

export interface DemoCorrection {
  id: string;
  user_id: string;
  punch_id: string | null;
  status: "pending" | "approved" | "denied";
  reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface DemoDisciplineAction {
  id: string;
  user_id: string;
  status: "awaiting_approval" | "approved" | "denied";
  proposed_by_user_id: string;
  approvals: { approver_user_id: string; approved_at: string }[];
  created_at: string;
}

export interface DemoRecipeLine {
  id: string;
  component_item_id: string;
  component_sku: string;
  component_name: string;
  component_item_type: "ingredient" | "packaging";
  qty_per_unit: number;
  measurement_unit: string | null;
}

export interface DemoRecipe {
  id: string;
  finished_item_id: string;
  finished_name: string;
  name: string | null;
  is_active: boolean;
  lines: DemoRecipeLine[];
}

export interface DemoMasterItem {
  id: string;
  sku: string;
  name: string;
  item_type: "product" | "ingredient" | "packaging";
  subcategory_at: string | null;
  on_hand: number;
  low_stock: boolean;
  stock_by_location: { location: string; quantity: number }[];
  weekly_velocity_toronto: string;
  weekly_velocity_wavecrest: string;
  measurement_unit: string | null;
  has_recipe: boolean;
}

export interface DemoProductionRunStaff {
  user_id: string;
  hours: number;
  shift_hours: number | null;
}

export interface DemoProductionRun {
  id: string;
  finished_item_id: string;
  recipe_id: string | null;
  scheduled_date: string;
  status: "planned" | "in_progress" | "completed" | "cancelled";
  run_type: "finished" | "bagged_sealed_only";
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
  notes: string | null;
  staff: DemoProductionRunStaff[];
  ledger_committed: boolean;
}

export interface DemoProductionRate {
  item_id: string;
  rate: number | null;
  hidden: boolean;
  history: number[]; // recent hit-rate fractions, most recent last
}

export interface DemoInvite {
  id: string;
  email: string;
  full_name: string;
  role: DemoRole;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  token: string;
}

export interface DemoLocalNote {
  note: string | null;
  updated_at: string;
  updated_by_email: string;
}

export interface DemoCustomer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  source: string | null;
  created_date: string | null;
  email_consent: boolean;
  sms_consent: boolean;
  shopify_tags: string | null;
  total_clv: number | null;
  churn_probability: number | null;
  historic_order_count: number | null;
  average_order_value: number | null;
  last_order_date: string | null;
  expected_next_order: string | null;
  emails_received: number | null;
  emails_opened: number | null;
  open_rate: number | null;
  emails_clicked: number | null;
  click_rate: number | null;
  last_email_opened: string | null;
  last_email_clicked: string | null;
  last_email_received: string | null;
  order_count_rollup: number | null;
}

export interface DemoOrderLine {
  id: string;
  customer_id: string;
  order_id: string;
  order_number: number;
  created_at_shopify: string;
  line_item_name: string;
  sku: string | null;
  quantity: number;
  line_item_subtotal: number;
  order_currency: string;
  order_fulfillment_status: string | null;
  cancelled_at_shopify: string | null;
  channel: string | null;
  line_item_tracking_link: string | null;
}

export interface DemoRoleDef {
  key: string;
  label: string;
  description: string | null;
  is_built_in: boolean;
  default_capabilities: string[];
  canonical_capabilities: string[];
}

export interface DemoDispatchRule {
  send_day: number;
  period_month_offset: -1 | 0;
  period_start_day: number;
  period_end_day: number;
}

export interface DemoDispatchConfig {
  recipients: string[];
  rules: DemoDispatchRule[];
  include_accountants: boolean;
  last_sent_period: string | null;
  last_sent_at: string | null;
}

export interface DemoWebhookEvent {
  id: string;
  source: "shopify" | "airtable";
  topic: string;
  status: "processed" | "failed" | "ignored";
  received_at: string;
}

export interface DemoTransferV2 {
  id: string;
  master_item_name: string;
  quantity: number;
  from_warehouse: string;
  to_warehouse: string;
  status: "planned" | "in_transit" | "received";
}

export interface Db {
  seededAt: string;
  users: DemoUser[];
  roles: DemoRoleDef[];
  shifts: DemoShift[];
  claimOffers: DemoClaimOffer[];
  shiftPresets: DemoShiftPreset[];
  studioClosures: DemoStudioClosure[];
  timeOffRequests: DemoTimeOffRequest[];
  punches: DemoPunch[];
  corrections: DemoCorrection[];
  disciplineActions: DemoDisciplineAction[];
  masterItems: DemoMasterItem[];
  recipes: DemoRecipe[];
  productionRuns: DemoProductionRun[];
  productionRates: DemoProductionRate[];
  rateHistoryWindow: number;
  invites: DemoInvite[];
  localNotes: Record<string, DemoLocalNote>;
  customers: DemoCustomer[];
  orderLines: DemoOrderLine[];
  dispatchConfig: DemoDispatchConfig;
  webhookEvents: DemoWebhookEvent[];
  transfersV2: DemoTransferV2[];
  navLayout: Record<string, string[]>;
  currentPersonaId: string;
}

// ─── Persistence ─────────────────────────────────────────────────────────

let cache: Db | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/** Lazily loads (and seeds, on first visit) the demo DB. Synchronous. */
export function getDb(): Db {
  if (cache) return cache;
  if (!isBrowser()) {
    // Server-side render pass (e.g. static export prerender) — return a
    // throwaway empty-ish shape; real data only matters client-side.
    // Populated lazily via ensureSeeded() on the client.
    cache = emptyDb();
    return cache;
  }
  const raw = window.localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      cache = JSON.parse(raw) as Db;
      return cache;
    } catch {
      // fall through to reseed on parse failure
    }
  }
  cache = seedDb();
  saveDb(cache);
  return cache;
}

export function saveDb(db: Db): void {
  cache = db;
  if (!isBrowser()) return;
  window.localStorage.setItem(DB_KEY, JSON.stringify(db));
}

/** Read-modify-write helper: pass a function that mutates `db` in place. */
export function mutateDb<T>(fn: (db: Db) => T): T {
  const db = getDb();
  const result = fn(db);
  saveDb(db);
  return result;
}

/** Wipes the demo DB + persona choice. Caller is responsible for reloading. */
export function resetDb(): void {
  if (isBrowser()) {
    window.localStorage.removeItem(DB_KEY);
    window.localStorage.removeItem(PERSONA_KEY);
  }
  cache = null;
}

function emptyDb(): Db {
  return {
    seededAt: new Date(0).toISOString(),
    users: [],
    roles: [],
    shifts: [],
    claimOffers: [],
    shiftPresets: [],
    studioClosures: [],
    timeOffRequests: [],
    punches: [],
    corrections: [],
    disciplineActions: [],
    masterItems: [],
    recipes: [],
    productionRuns: [],
    productionRates: [],
    rateHistoryWindow: 10,
    invites: [],
    localNotes: {},
    customers: [],
    orderLines: [],
    dispatchConfig: { recipients: [], rules: [], include_accountants: true, last_sent_period: null, last_sent_at: null },
    webhookEvents: [],
    transfersV2: [],
    navLayout: {},
    currentPersonaId: "",
  };
}

// ─── Persona (demo auth) ─────────────────────────────────────────────────

export function getCurrentPersonaId(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(PERSONA_KEY);
}

export function setCurrentPersonaId(userId: string): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(PERSONA_KEY, userId);
}

// ─── Misc helpers ────────────────────────────────────────────────────────

let counter = 0;
/** Short, sufficiently-unique id for demo records (not cryptographically anything). */
export function uid(prefix = "id"): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Simulates network latency so the demo feels like it's really talking to a server. */
export function delay<T>(value: T, ms = 200 + Math.random() * 150): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
