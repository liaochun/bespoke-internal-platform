// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
import type { CurrentUser, Role } from "@/lib/api";

// Capability ids — kept in sync with the backend catalog (app/core/capabilities.py).
// Use these constants instead of raw strings so typos surface at compile time.
export const CAP = {
  manage_schedule: "manage_schedule",
  review_corrections: "review_corrections",
  edit_others_punches: "edit_others_punches",
  print_qr: "print_qr",
  view_timesheets: "view_timesheets",
  export_timesheets: "export_timesheets",
  view_users: "view_users",
  manage_users: "manage_users",
  manage_invites: "manage_invites",
  manage_permissions: "manage_permissions",
  view_inventory: "view_inventory",
  manage_inventory: "manage_inventory",
  edit_ingredients: "edit_ingredients",
  edit_recipes: "edit_recipes",
  edit_production_rates: "edit_production_rates",
  manage_production_runs: "manage_production_runs",
  manage_discipline: "manage_discipline",
  view_discipline_documents: "view_discipline_documents",
  approve_reconciliations: "approve_reconciliations",
} as const;

export type CapabilityId = (typeof CAP)[keyof typeof CAP];

export function has(user: CurrentUser, capability: string): boolean {
  return user.capabilities.includes(capability);
}

export function canViewReports(user: CurrentUser): boolean {
  return has(user, CAP.view_timesheets) || has(user, CAP.export_timesheets);
}

export function canManageWorkforce(user: CurrentUser): boolean {
  return (
    has(user, CAP.manage_schedule) ||
    has(user, CAP.review_corrections) ||
    has(user, CAP.edit_others_punches) ||
    has(user, CAP.print_qr)
  );
}

export function canManageUsers(user: CurrentUser): boolean {
  return has(user, CAP.manage_users) || has(user, CAP.manage_invites);
}

export function canViewUsers(user: CurrentUser): boolean {
  return has(user, CAP.view_users);
}

export function canManagePermissions(user: CurrentUser): boolean {
  return has(user, CAP.manage_permissions);
}

// Documents hub (/admin/documents). Generators of a document type can view it;
// read-only grantees get an explicit view capability per section.
export function canViewDocuments(user: CurrentUser): boolean {
  return (
    has(user, CAP.manage_discipline) || has(user, CAP.view_discipline_documents)
  );
}

export function clocksIn(user: CurrentUser): boolean {
  // Accountants typically don't clock in. Anyone else with a role does.
  return user.role !== "accountant";
}

const BUILT_IN_ROLE_LABEL: Partial<Record<Role, string>> = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  assistant_manager: "Assistant Manager",
  accountant: "Accountant",
  staff: "Staff",
};

/** Returns a friendly label for any role key, including custom ones. */
export function roleLabel(key: string): string {
  return (
    BUILT_IN_ROLE_LABEL[key as Role] ??
    key
      .split("_")
      .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
      .join(" ")
  );
}

// Kept for direct lookup of built-ins; new code should call roleLabel().
export const ROLE_LABEL: Partial<Record<string, string>> = BUILT_IN_ROLE_LABEL;
