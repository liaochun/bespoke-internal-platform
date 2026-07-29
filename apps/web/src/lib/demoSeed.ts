// Generates the synthetic "day one" dataset for the static demo, the first
// time a visitor's browser has no `northbound-demo-v1` key yet. Everything
// here is fictional (see README) and timestamped relative to `Date.now()` so
// the demo always looks current, whatever day someone loads it.

import type {
  Db,
  DemoClaimOffer,
  DemoCorrection,
  DemoCustomer,
  DemoDisciplineAction,
  DemoInvite,
  DemoMasterItem,
  DemoOrderLine,
  DemoPunch,
  DemoProductionRate,
  DemoProductionRun,
  DemoRecipe,
  DemoRoleDef,
  DemoShift,
  DemoShiftPreset,
  DemoStudioClosure,
  DemoTimeOffRequest,
  DemoUser,
  DemoWebhookEvent,
} from "./demoStore";
import { uid } from "./demoStore";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysFromNow(days: number, hour = 0, minute = 0): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}

function startOfWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return d;
}

// ─── Capabilities catalog ────────────────────────────────────────────────

export const CAPABILITY_CATALOG = [
  { id: "manage_schedule", label: "Manage schedule", description: "Build and edit the staff shift schedule", category: "Workforce" },
  { id: "review_corrections", label: "Review punch corrections", description: "Approve/deny staff-submitted punch fixes", category: "Workforce" },
  { id: "edit_others_punches", label: "Edit others' punches", description: "Directly edit any staff member's clock punches", category: "Workforce" },
  { id: "print_qr", label: "Print kiosk QR", description: "Print the studio clock-in QR code", category: "Workforce" },
  { id: "view_timesheets", label: "View timesheets", description: "View hours worked reports", category: "Payroll" },
  { id: "export_timesheets", label: "Export timesheets", description: "Download timesheet CSVs, manage auto-email", category: "Payroll" },
  { id: "view_users", label: "View users", description: "See the staff directory", category: "Admin" },
  { id: "manage_users", label: "Manage users", description: "Edit roles, employment status, kiosk PINs", category: "Admin" },
  { id: "manage_invites", label: "Manage invites", description: "Send and revoke user invites", category: "Admin" },
  { id: "manage_permissions", label: "Manage permissions", description: "Configure default capabilities per role", category: "Admin" },
  { id: "view_inventory", label: "View inventory", description: "View the inventory dashboard and catalog", category: "Inventory" },
  { id: "manage_inventory", label: "Manage inventory", description: "Edit stock, transfers, and integrations", category: "Inventory" },
  { id: "edit_ingredients", label: "Edit ingredients", description: "Edit raw ingredient/packaging catalog", category: "Inventory" },
  { id: "edit_recipes", label: "Edit recipes", description: "Edit BOM recipes for finished goods", category: "Production" },
  { id: "edit_production_rates", label: "Edit production rates", description: "Override dynamic production rate tuning", category: "Production" },
  { id: "manage_production_runs", label: "Manage production runs", description: "Create/edit/complete production runs", category: "Production" },
  { id: "manage_discipline", label: "Manage discipline", description: "Author and approve discipline actions", category: "HR" },
  { id: "view_discipline_documents", label: "View discipline documents", description: "Read-only access to discipline records", category: "HR" },
  { id: "approve_reconciliations", label: "Approve reconciliations", description: "Sign off on financial reconciliations", category: "Payroll" },
] as const;

const ALL_CAPS = CAPABILITY_CATALOG.map((c) => c.id);

const ROLE_DEFAULTS: Record<string, string[]> = {
  super_admin: ALL_CAPS,
  admin: ALL_CAPS,
  manager: [
    "manage_schedule",
    "review_corrections",
    "edit_others_punches",
    "print_qr",
    "view_timesheets",
    "export_timesheets",
    "view_users",
    "view_inventory",
    "manage_inventory",
    "edit_recipes",
    "manage_production_runs",
    "view_discipline_documents",
  ],
  assistant_manager: ["manage_schedule", "review_corrections", "print_qr", "view_timesheets", "view_inventory", "view_discipline_documents"],
  accountant: ["view_timesheets", "export_timesheets", "approve_reconciliations", "view_users"],
  staff: [],
};

function rolesSeed(): DemoRoleDef[] {
  const builtIns: { key: string; label: string; description: string }[] = [
    { key: "super_admin", label: "Super Admin", description: "Full system access, including nav layout and dangerous tools." },
    { key: "admin", label: "Admin", description: "Full operational access across workforce, inventory, and production." },
    { key: "manager", label: "Manager", description: "Runs day-to-day scheduling, timesheets, and production." },
    { key: "assistant_manager", label: "Assistant Manager", description: "Scheduling support with lighter admin access." },
    { key: "accountant", label: "Accountant", description: "Payroll and reconciliation-focused, no clock-in." },
    { key: "staff", label: "Staff", description: "Clocks in, views own schedule and hours." },
  ];
  return builtIns.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    is_built_in: true,
    default_capabilities: [...(ROLE_DEFAULTS[r.key] ?? [])],
    canonical_capabilities: [...(ROLE_DEFAULTS[r.key] ?? [])],
  }));
}

// ─── Staff ────────────────────────────────────────────────────────────────

type SeedPerson = { first: string; last: string; role: string };

const PEOPLE: SeedPerson[] = [
  { first: "Priya", last: "Anand", role: "admin" },
  { first: "Sana", last: "Malik", role: "super_admin" },
  { first: "Marcus", last: "Webb", role: "manager" },
  { first: "Elena", last: "Cho", role: "manager" },
  { first: "Diego", last: "Fuentes", role: "assistant_manager" },
  { first: "Grace", last: "Whitfield", role: "accountant" },
  { first: "Jordan", last: "Lee", role: "staff" },
  { first: "Amara", last: "Osei", role: "staff" },
  { first: "Liam", last: "Brennan", role: "staff" },
  { first: "Nina", last: "Petrov", role: "staff" },
  { first: "Tobias", last: "Reyes", role: "staff" },
  { first: "Harpreet", last: "Dhillon", role: "staff" },
];

// Demo personas: these three IDs are exposed to the persona switcher.
export const PERSONA_KEYS = {
  admin: "persona-admin",
  manager: "persona-manager",
  staff: "persona-staff",
} as const;

function usersSeed(): DemoUser[] {
  return PEOPLE.map((p, i) => {
    const isPersonaAdmin = p.first === "Priya" && p.last === "Anand";
    const isPersonaManager = p.first === "Marcus" && p.last === "Webb";
    const isPersonaStaff = p.first === "Jordan" && p.last === "Lee";
    const id = isPersonaAdmin
      ? PERSONA_KEYS.admin
      : isPersonaManager
        ? PERSONA_KEYS.manager
        : isPersonaStaff
          ? PERSONA_KEYS.staff
          : uid("user");
    return {
      id,
      email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@northboundops.example`,
      full_name: `${p.first} ${p.last}`,
      role: p.role,
      user_type: "internal",
      is_active: true,
      is_terminated: false,
      terminated_at: null,
      phone_e164: `+1416555${String(1000 + i).slice(-4)}`,
      has_pin: i % 4 !== 3,
      pin: i % 4 !== 3 ? String(1000 + i * 37).slice(-4) : null,
      ec_name: i % 3 === 0 ? `${p.first} Emergency Contact` : null,
      ec_relationship: i % 3 === 0 ? "Spouse" : null,
      ec_phone: i % 3 === 0 ? "+14165551212" : null,
      ec_notes: null,
      capabilities: [...(ROLE_DEFAULTS[p.role] ?? [])],
    };
  });
}

// ─── Inventory / master items ────────────────────────────────────────────

function masterItemsSeed(): DemoMasterItem[] {
  const products: Array<[string, string, string | null, boolean]> = [
    ["CW1", "Cedarwood Soak", "Core Baths", false],
    ["CF1", "Citrus Fizz Bar", "Core Baths", false],
    ["LM1", "Lavender Mineral Soak", "Core Baths", false],
    ["OM1", "Oat Milk Bath Melt", "Core Baths", false],
    ["CD1", "Charcoal Detox Bar", "Core Baths", false],
    ["RQ1", "Rose Quartz Bath Bomb", "Limited Baths", true],
    ["ES1", "Eucalyptus Steam Tablet", "Core Baths", false],
    ["KIT1", "Sea Salt Soak Trio Kit", "Kits", false],
    ["WB1", "Wildflower Bath Petals", "Limited Baths", true],
  ];
  const ingredients: Array<[string, string, boolean]> = [
    ["ING-EPS", "Epsom Salt (bulk)", false],
    ["ING-SHEA", "Shea Butter", false],
    ["ING-CIT", "Citric Acid", false],
    ["ING-EOL", "Essential Oil — Lavender", true],
  ];
  const packaging: Array<[string, string, boolean]> = [
    ["PKG-KP250", "Kraft Pouch 250g", true],
    ["PKG-GBS", "Gift Box — Small", false],
  ];

  const items: DemoMasterItem[] = [];
  for (const [sku, name, sub, low] of products) {
    const toronto = low ? 6 + Math.floor(Math.random() * 8) : 40 + Math.floor(Math.random() * 120);
    const wavecrest = low ? 2 + Math.floor(Math.random() * 5) : 20 + Math.floor(Math.random() * 80);
    items.push({
      id: uid("item"),
      sku,
      name,
      item_type: "product",
      subcategory_at: sub,
      on_hand: toronto + wavecrest,
      low_stock: low,
      stock_by_location: [
        { location: "toronto", quantity: toronto },
        { location: "wavecrest_usa", quantity: wavecrest },
      ],
      weekly_velocity_toronto: (low ? 8 + Math.random() * 6 : 3 + Math.random() * 10).toFixed(1),
      weekly_velocity_wavecrest: (low ? 4 + Math.random() * 3 : 1 + Math.random() * 6).toFixed(1),
      measurement_unit: "units",
      has_recipe: true,
    });
  }
  for (const [sku, name, low] of ingredients) {
    const qty = low ? 300 + Math.floor(Math.random() * 400) : 4000 + Math.floor(Math.random() * 8000);
    items.push({
      id: uid("item"),
      sku,
      name,
      item_type: "ingredient",
      subcategory_at: null,
      on_hand: qty,
      low_stock: low,
      stock_by_location: [{ location: "toronto", quantity: qty }],
      weekly_velocity_toronto: "0",
      weekly_velocity_wavecrest: "0",
      measurement_unit: "g",
      has_recipe: false,
    });
  }
  for (const [sku, name, low] of packaging) {
    const qty = low ? 400 + Math.floor(Math.random() * 300) : 3000 + Math.floor(Math.random() * 5000);
    items.push({
      id: uid("item"),
      sku,
      name,
      item_type: "packaging",
      subcategory_at: null,
      on_hand: qty,
      low_stock: low,
      stock_by_location: [{ location: "toronto", quantity: qty }],
      weekly_velocity_toronto: "0",
      weekly_velocity_wavecrest: "0",
      measurement_unit: "units",
      has_recipe: false,
    });
  }
  return items;
}

function recipesSeed(items: DemoMasterItem[]): DemoRecipe[] {
  const bySku = new Map(items.map((i) => [i.sku, i]));
  const epsom = bySku.get("ING-EPS")!;
  const shea = bySku.get("ING-SHEA")!;
  const citric = bySku.get("ING-CIT")!;
  const eol = bySku.get("ING-EOL")!;
  const pouch = bySku.get("PKG-KP250")!;
  const box = bySku.get("PKG-GBS")!;

  const finished = items.filter((i) => i.item_type === "product" && i.has_recipe);
  return finished.map((f) => {
    const usesBox = f.sku === "KIT1";
    const lines = [
      { comp: epsom, qty: 180 + Math.random() * 60, unit: "g" },
      { comp: shea, qty: 20 + Math.random() * 15, unit: "g" },
      { comp: citric, qty: 10 + Math.random() * 8, unit: "g" },
      { comp: eol, qty: 2 + Math.random() * 2, unit: "ml" },
      { comp: usesBox ? box : pouch, qty: 1, unit: "unit" },
    ].map(({ comp, qty, unit }) => ({
      id: uid("recline"),
      component_item_id: comp.id,
      component_sku: comp.sku,
      component_name: comp.name,
      component_item_type: comp.item_type as "ingredient" | "packaging",
      qty_per_unit: Number(qty.toFixed(2)),
      measurement_unit: unit,
    }));
    return {
      id: uid("recipe"),
      finished_item_id: f.id,
      finished_name: f.name,
      name: null,
      is_active: true,
      lines,
    };
  });
}

function productionRatesSeed(recipes: DemoRecipe[]): DemoProductionRate[] {
  return recipes.map((r) => ({
    item_id: r.finished_item_id,
    rate: 45 + Math.round(Math.random() * 20),
    hidden: false,
    history: [0.92, 0.95, 0.98, 1.01, 0.97],
  }));
}

// ─── Production schedule ─────────────────────────────────────────────────

function productionRunsSeed(recipes: DemoRecipe[], users: DemoUser[]): DemoProductionRun[] {
  const staffPool = users.filter((u) => u.role === "staff" || u.role === "manager");
  const weekStart = startOfWeek();
  const runs: DemoProductionRun[] = [];
  const total = 13;
  for (let i = 0; i < total; i++) {
    const recipe = recipes[i % recipes.length];
    // Spread across -2..+4 days from week start so some are past (completed),
    // some today/in-progress, some upcoming (planned).
    const dayOffset = -2 + (i % 7);
    const scheduledDate = ymd(new Date(weekStart.getTime() + dayOffset * DAY_MS));
    const isPast = dayOffset < 0;
    const isToday = ymd(new Date()) === scheduledDate;
    const status: DemoProductionRun["status"] = isPast
      ? "completed"
      : isToday && i % 2 === 0
        ? "in_progress"
        : "planned";
    const staffCount = 2 + (i % 3);
    const hours = 4 + (i % 3) * 2;
    const rate = 55;
    const targetQty = staffCount * hours * rate;
    const completedQty = status === "completed" ? Math.round(targetQty * (0.9 + Math.random() * 0.15)) : null;
    const assigned = Array.from({ length: staffCount }, (_, k) => staffPool[(i + k) % staffPool.length]).filter(Boolean);

    runs.push({
      id: uid("run"),
      finished_item_id: recipe.finished_item_id,
      recipe_id: recipe.id,
      scheduled_date: scheduledDate,
      status,
      run_type: "finished",
      staff_count_planned: staffCount,
      hours_planned: hours,
      target_qty: targetQty,
      completed_qty: completedQty,
      completed_at: status === "completed" ? isoDaysFromNow(dayOffset, 16) : null,
      bagged_at: status === "completed" ? isoDaysFromNow(dayOffset, 15) : null,
      sealed_at: status === "completed" ? isoDaysFromNow(dayOffset, 15, 30) : null,
      bag_minutes: status === "completed" ? 30 : null,
      seal_minutes: status === "completed" ? 25 : null,
      bag_seal_staff_count: staffCount,
      include_bag_seal_hours: false,
      packaging_minutes: status === "completed" ? 45 : null,
      include_packaging_hours: false,
      packaging_staff_count: staffCount,
      qc_errors: status === "completed" ? String(Math.round(Math.random() * 3)) : null,
      baths_per_hour_per_person: null,
      notes: null,
      staff: assigned.map((u) => ({ user_id: u.id, hours, shift_hours: hours })),
      ledger_committed: status === "completed",
    });
  }
  return runs;
}

// ─── Shifts + sick calls ─────────────────────────────────────────────────

function shiftsSeed(users: DemoUser[]): { shifts: DemoShift[]; claimOffers: DemoClaimOffer[] } {
  const clockingUsers = users.filter((u) => u.role !== "accountant");
  const weekStart = startOfWeek();
  const shifts: DemoShift[] = [];
  const claimOffers: DemoClaimOffer[] = [];

  // Regular week of shifts: each clocking staff member gets ~4 shifts this week.
  for (const u of clockingUsers) {
    const dayIndexes = [0, 1, 3, 4].map((d) => (d + clockingUsers.indexOf(u)) % 7);
    for (const dayOffset of dayIndexes) {
      const day = new Date(weekStart.getTime() + dayOffset * DAY_MS);
      const dateStr = ymd(day);
      shifts.push({
        id: uid("shift"),
        user_id: u.id,
        location: dayOffset % 2 === 0 ? "toronto" : "wavecrest",
        role_label: null,
        starts_at: `${dateStr}T13:30:00.000Z`,
        ends_at: `${dateStr}T21:30:00.000Z`,
        status: dayOffset < ((new Date().getDay() + 6) % 7) ? "completed" : "scheduled",
        notes: null,
        sick_called_at: null,
        sick_call_note: null,
        sick_call_status: null,
        called_in_by_user_id: null,
        created_at: isoDaysFromNow(-10),
        updated_at: isoDaysFromNow(-10),
      });
    }
  }

  // Sick call #1 — active, unclaimed open offer (today, filling).
  const staffA = clockingUsers.find((u) => u.role === "staff") ?? clockingUsers[0];
  const sickShiftA: DemoShift = {
    id: uid("shift"),
    user_id: staffA.id,
    location: "toronto",
    role_label: "Front counter",
    starts_at: isoDaysFromNow(0, 13, 30),
    ends_at: isoDaysFromNow(0, 21, 30),
    status: "cancelled",
    notes: null,
    sick_called_at: isoDaysFromNow(0, 8, 15),
    sick_call_note: "Woke up with a bad cold, don't want to risk it near the retail floor.",
    sick_call_status: "filling",
    called_in_by_user_id: staffA.id,
    created_at: isoDaysFromNow(-3),
    updated_at: isoDaysFromNow(0, 8, 15),
  };
  shifts.push(sickShiftA);

  const candidatesA = clockingUsers.filter((u) => u.id !== staffA.id).slice(0, 4);
  const managerUser = users.find((u) => u.role === "manager") ?? users[0];
  claimOffers.push({
    id: uid("offer"),
    shift_id: sickShiftA.id,
    opened_by_user_id: managerUser.id,
    opened_at: isoDaysFromNow(0, 8, 30),
    expires_at: isoDaysFromNow(1, 8, 30),
    claimed_by_user_id: null,
    claimed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    candidate_user_ids: candidatesA.map((u) => u.id),
    claim_token: "demo-claim-token-open-0001",
  });

  // Sick call #2 — already claimed (completed workflow), a couple days ago.
  const staffB = clockingUsers.find((u) => u.role === "staff" && u.id !== staffA.id) ?? clockingUsers[1];
  const staffC = clockingUsers.find((u) => u.role === "staff" && u.id !== staffA.id && u.id !== staffB.id) ?? clockingUsers[2];
  const sickShiftB: DemoShift = {
    id: uid("shift"),
    user_id: staffB.id,
    location: "toronto",
    role_label: null,
    starts_at: isoDaysFromNow(-2, 13, 30),
    ends_at: isoDaysFromNow(-2, 21, 30),
    status: "cancelled",
    notes: null,
    sick_called_at: isoDaysFromNow(-2, 7, 0),
    sick_call_note: "Family emergency, need the day.",
    sick_call_status: "filled",
    called_in_by_user_id: staffB.id,
    created_at: isoDaysFromNow(-5),
    updated_at: isoDaysFromNow(-2, 9, 0),
  };
  shifts.push(sickShiftB);
  // The claimed shift itself — staffC picked it up.
  shifts.push({
    id: uid("shift"),
    user_id: staffC.id,
    location: "toronto",
    role_label: null,
    starts_at: isoDaysFromNow(-2, 13, 30),
    ends_at: isoDaysFromNow(-2, 21, 30),
    status: "completed",
    notes: "Picked up via sub offer.",
    sick_called_at: null,
    sick_call_note: null,
    sick_call_status: null,
    called_in_by_user_id: null,
    created_at: isoDaysFromNow(-2, 9, 0),
    updated_at: isoDaysFromNow(-2, 9, 0),
  });
  claimOffers.push({
    id: uid("offer"),
    shift_id: sickShiftB.id,
    opened_by_user_id: managerUser.id,
    opened_at: isoDaysFromNow(-2, 7, 15),
    expires_at: isoDaysFromNow(-1, 7, 15),
    claimed_by_user_id: staffC.id,
    claimed_at: isoDaysFromNow(-2, 8, 0),
    cancelled_at: null,
    cancel_reason: null,
    candidate_user_ids: clockingUsers.filter((u) => u.id !== staffB.id).slice(0, 5).map((u) => u.id),
    claim_token: "demo-claim-token-claimed-0002",
  });

  // A pending-review sick call, not yet actioned.
  const staffD = clockingUsers.find((u) => u.role === "staff" && ![staffA.id, staffB.id, staffC.id].includes(u.id)) ?? clockingUsers[3];
  shifts.push({
    id: uid("shift"),
    user_id: staffD.id,
    location: "wavecrest",
    role_label: null,
    starts_at: isoDaysFromNow(1, 13, 30),
    ends_at: isoDaysFromNow(1, 21, 30),
    status: "cancelled",
    notes: null,
    sick_called_at: isoDaysFromNow(0, 18, 0),
    sick_call_note: null,
    sick_call_status: "pending_review",
    called_in_by_user_id: staffD.id,
    created_at: isoDaysFromNow(-1),
    updated_at: isoDaysFromNow(0, 18, 0),
  });

  return { shifts, claimOffers };
}

// ─── Timesheets (punches) ────────────────────────────────────────────────

function punchesSeed(users: DemoUser[]): DemoPunch[] {
  const clockingUsers = users.filter((u) => u.role !== "accountant");
  const punches: DemoPunch[] = [];
  for (const u of clockingUsers) {
    for (let d = 1; d <= 12; d++) {
      if (d % 3 === 0) continue; // skip some days off
      const dayOffset = -d;
      const inHour = 13 + (d % 2);
      const outHour = inHour + 8;
      punches.push({
        id: uid("punch"),
        user_id: u.id,
        punch_type: "clock_in",
        punched_at: isoDaysFromNow(dayOffset, inHour, 30),
        location: d % 2 === 0 ? "toronto" : "wavecrest",
        device_id: "seed-kiosk-01",
        reason: null,
      });
      punches.push({
        id: uid("punch"),
        user_id: u.id,
        punch_type: "clock_out",
        punched_at: isoDaysFromNow(dayOffset, outHour, 15),
        location: d % 2 === 0 ? "toronto" : "wavecrest",
        device_id: "seed-kiosk-01",
        reason: null,
      });
    }
  }
  // One open (unclosed) clock-in for realism.
  const openUser = clockingUsers[clockingUsers.length - 1];
  punches.push({
    id: uid("punch"),
    user_id: openUser.id,
    punch_type: "clock_in",
    punched_at: isoDaysFromNow(0, 13, 30),
    location: "toronto",
    device_id: "seed-kiosk-01",
    reason: null,
  });
  return punches;
}

// ─── Customers / orders (for the inventory dashboard drawer) ─────────────

const CUSTOMER_NAMES: Array<[string, string]> = [
  ["Alex", "Nguyen"],
  ["Bianca", "Rossi"],
  ["Carter", "Jameson"],
  ["Dahlia", "Okafor"],
  ["Ethan", "Park"],
  ["Freya", "Lindqvist"],
];

function customersSeed(): { customers: DemoCustomer[]; orderLines: DemoOrderLine[] } {
  const customers: DemoCustomer[] = [];
  const orderLines: DemoOrderLine[] = [];
  const skuPool = ["CW1", "CF1", "LM1", "OM1", "CD1", "RQ1", "ES1", "KIT1"];
  CUSTOMER_NAMES.forEach(([first, last], i) => {
    const id = uid("cust");
    const churn = i % 3 === 0 ? 0.82 : i % 3 === 1 ? 0.55 : 0.2;
    const clv = 180 + i * 65;
    customers.push({
      id,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: null,
      city: ["Toronto", "Ottawa", "Vancouver", "Calgary", "Halifax", "Montreal"][i % 6],
      region: "ON",
      country: "Canada",
      source: i % 2 === 0 ? "Shopify" : "Retail",
      created_date: isoDaysFromNow(-200 - i * 15),
      email_consent: i % 2 === 0,
      sms_consent: i % 3 === 0,
      shopify_tags: i % 2 === 0 ? "vip" : null,
      total_clv: clv,
      churn_probability: churn,
      historic_order_count: 3 + i,
      average_order_value: 45 + i * 3,
      last_order_date: isoDaysFromNow(-10 - i * 4),
      expected_next_order: isoDaysFromNow(20 - i * 2),
      emails_received: 20 + i * 4,
      emails_opened: 10 + i * 2,
      open_rate: 0.4 + i * 0.02,
      emails_clicked: 3 + i,
      click_rate: 0.12 + i * 0.01,
      last_email_opened: isoDaysFromNow(-3 - i),
      last_email_clicked: isoDaysFromNow(-6 - i),
      last_email_received: isoDaysFromNow(-1 - i),
      order_count_rollup: 3 + i,
    });
    for (let o = 0; o < 3 + (i % 2); o++) {
      orderLines.push({
        id: uid("orderline"),
        customer_id: id,
        order_id: uid("order"),
        order_number: 10230 + i * 10 + o,
        created_at_shopify: isoDaysFromNow(-5 - o * 20 - i * 3),
        line_item_name: `${["Cedarwood Soak", "Citrus Fizz Bar", "Lavender Mineral Soak"][o % 3]}`,
        sku: skuPool[(i + o) % skuPool.length],
        quantity: 1 + (o % 3),
        line_item_subtotal: 18 + o * 6,
        order_currency: "CAD",
        order_fulfillment_status: o === 0 ? "unfulfilled" : "fulfilled",
        cancelled_at_shopify: null,
        channel: i % 2 === 0 ? "Online Store" : "POS",
        line_item_tracking_link: null,
      });
    }
  });
  return { customers, orderLines };
}

// ─── Misc small collections ──────────────────────────────────────────────

function shiftPresetsSeed(): DemoShiftPreset[] {
  return [
    { id: uid("preset"), label: "Opening · 9:30am–5:30pm", start_time: "09:30", end_time: "17:30" },
    { id: uid("preset"), label: "Closing · 1:30pm–9:30pm", start_time: "13:30", end_time: "21:30" },
    { id: uid("preset"), label: "Mid · 11am–7pm", start_time: "11:00", end_time: "19:00" },
  ];
}

function studioClosuresSeed(): DemoStudioClosure[] {
  return [{ id: uid("closure"), date: dateDaysFromNow(18), name: "Staff training day" }];
}

function timeOffSeed(users: DemoUser[]): DemoTimeOffRequest[] {
  const staff = users.filter((u) => u.role === "staff");
  return [
    {
      id: uid("timeoff"),
      user_id: staff[0]?.id ?? users[0].id,
      start_date: dateDaysFromNow(9),
      end_date: dateDaysFromNow(11),
      status: "pending",
      reason: "Family trip",
      reviewed_at: null,
    },
    {
      id: uid("timeoff"),
      user_id: staff[1]?.id ?? users[1].id,
      start_date: dateDaysFromNow(-5),
      end_date: dateDaysFromNow(-5),
      status: "approved",
      reason: "Appointment",
      reviewed_at: isoDaysFromNow(-6),
    },
  ];
}

function correctionsSeed(users: DemoUser[]): DemoCorrection[] {
  const staff = users.filter((u) => u.role === "staff");
  return [
    {
      id: uid("corr"),
      user_id: staff[0]?.id ?? users[0].id,
      punch_id: null,
      status: "pending",
      reason: "Forgot to clock out at close, actual time was 9:30pm not 6pm.",
      created_at: isoDaysFromNow(-1),
      reviewed_at: null,
    },
  ];
}

function disciplineSeed(users: DemoUser[]): DemoDisciplineAction[] {
  const staff = users.filter((u) => u.role === "staff");
  const manager = users.find((u) => u.role === "manager") ?? users[0];
  return [
    {
      id: uid("disc"),
      user_id: staff[2]?.id ?? users[2].id,
      status: "awaiting_approval",
      proposed_by_user_id: manager.id,
      approvals: [],
      created_at: isoDaysFromNow(-2),
    },
  ];
}

function invitesSeed(): DemoInvite[] {
  return [
    {
      id: uid("invite"),
      email: "casey.morgan@example.com",
      full_name: "Casey Morgan",
      role: "staff",
      created_at: isoDaysFromNow(-3),
      expires_at: isoDaysFromNow(27),
      accepted_at: null,
      revoked_at: null,
      token: "demo-invite-token-0001",
    },
  ];
}

function webhookEventsSeed(): DemoWebhookEvent[] {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, i) => ({
    id: uid("webhook"),
    source: i % 2 === 0 ? "shopify" : "airtable",
    topic: i % 2 === 0 ? "orders/create" : "table.sync",
    status: i === 5 ? "failed" : "processed",
    received_at: new Date(now - i * 40 * 60_000).toISOString(),
  })) as DemoWebhookEvent[];
}

// ─── Top-level seed ───────────────────────────────────────────────────────

export function seedDb(): Db {
  const users = usersSeed();
  const roles = rolesSeed();
  const masterItems = masterItemsSeed();
  const recipes = recipesSeed(masterItems);
  const productionRates = productionRatesSeed(recipes);
  const productionRuns = productionRunsSeed(recipes, users);
  const { shifts, claimOffers } = shiftsSeed(users);
  const punches = punchesSeed(users);
  const { customers, orderLines } = customersSeed();

  return {
    seededAt: new Date().toISOString(),
    users,
    roles,
    shifts,
    claimOffers,
    shiftPresets: shiftPresetsSeed(),
    studioClosures: studioClosuresSeed(),
    timeOffRequests: timeOffSeed(users),
    punches,
    corrections: correctionsSeed(users),
    disciplineActions: disciplineSeed(users),
    masterItems,
    recipes,
    productionRuns,
    productionRates,
    rateHistoryWindow: 10,
    invites: invitesSeed(),
    localNotes: {},
    customers,
    orderLines,
    dispatchConfig: {
      recipients: ["accounting@northboundops.example"],
      rules: [
        { send_day: 8, period_month_offset: -1, period_start_day: 22, period_end_day: 31 },
        { send_day: 22, period_month_offset: 0, period_start_day: 8, period_end_day: 21 },
      ],
      include_accountants: true,
      last_sent_period: null,
      last_sent_at: null,
    },
    webhookEvents: webhookEventsSeed(),
    transfersV2: [
      { id: uid("transfer"), master_item_name: "Cedarwood Soak", quantity: 120, from_warehouse: "toronto", to_warehouse: "wavecrest_usa", status: "in_transit" },
      { id: uid("transfer"), master_item_name: "Citrus Fizz Bar", quantity: 80, from_warehouse: "toronto", to_warehouse: "wavecrest_usa", status: "planned" },
    ],
    navLayout: {},
    currentPersonaId: PERSONA_KEYS.admin,
  };
}
