# Bespoke Internal Operations Platform (Portfolio Excerpt)

This repository is a **curated excerpt** from a private, production business-operations
platform built by **liaochun** for a real small-manufacturing / retail client
("Northbound Ops" below is a stand-in brand — the real company name, domain, and
personnel have been redacted throughout).

The platform is a full-stack internal ops system: a FastAPI/Python backend and a
Next.js/TypeScript frontend, covering workforce scheduling, production capacity
planning, inventory, and two-way sync with third-party systems (Airtable, Shopify).

**This repository is an intentionally incomplete excerpt** — migrations, deployment
configuration, environment/secrets handling, and large portions of the API surface
have been omitted or redacted. **It is not a runnable standalone application.** It
exists to demonstrate specific engineering pieces from the real codebase, not to hand
over a working clone of it.

## Why these pieces

Rather than a toy demo, this is real production code (with business-identifying
details removed) showing how a handful of non-trivial problems were actually solved:

- **Capability-based authorization**, not just role checks — fine-grained permission
  gating that composes cleanly with a small set of role shortcuts.
- **A novel shift-claim workflow** — when staff call in sick, the system computes
  every eligible, available, unscheduled coworker and opens a first-to-claim race via
  single-use tokenized links, with the whole flow (open → notify → claim → confirm)
  handled atomically and race-safely.
- **Third-party sync integrations** — Airtable as an operator-facing system of record
  synced into a normalized Postgres schema, and a two-way Shopify inventory sync
  (webhook-driven inbound, ledger-triggered outbound) built with an explicit shadow
  mode / kill-switch for safe rollout.
- **Production capacity scheduling** — BOM-aware "can we actually make this many"
  preflight checks against live ingredient stock before a production run is confirmed.

## What's included

### Backend (`apps/api/`)

| Path | What it shows |
|---|---|
| `app/services/sick_call.py` + `app/api/routes/sick_call.py` | The full sick-call → shift-offer → first-to-claim workflow, staff- and manager-facing routes, and the unauthenticated one-click "find a sub" email action. |
| `app/services/airtable_production_runs.py` | Pull-only sync + idempotent import of an Airtable-backed production log into the canonical scheduling table, including dedup/backfill logic for a real historical data-migration edge case. |
| `app/services/production.py` | Production run scheduling math and BOM auto-deduction. |
| `app/services/shopify_inventory.py` + `app/services/shopify_webhook.py` + `app/api/routes/shopify_inventory.py` | Two-way Shopify inventory sync: outbound push, inbound webhook delta apply, and a non-mutating drift reconciler, all behind an explicit shadow-mode kill switch. |
| `app/api/deps.py` | The capability-based RBAC dependency system (role shortcuts + fine-grained capability gates) used across every route in the platform. |
| `app/services/transfer_documents/service.py` | Assembly layer for cross-border shipment paperwork (commercial invoice, packing list, customs forms) from inventory-transfer records. Business-identifying constants (broker, shipper, legal entity) have been replaced with fictional placeholders. |
| `app/services/notifications.py` | Transactional email dispatch helpers with per-user opt-in checks and a dev-environment batching/redirect mode. |
| `app/core/config.py` | The environment-driven settings pattern used throughout the API. |
| `alembic/versions/0011_webhook_events.py`, `0016_drop_variant_shopify_unique.py` | Two representative, purely structural migrations (table creation, index change) showing migration style. |

### Frontend (`apps/web/`)

Six "hero" page groups and their real component/hook dependencies, traced and copied
from the actual app:

- **Inventory dashboard** (`app/admin/inventory/dashboard`)
- **Production schedule + calendar** (`app/admin/inventory/production-schedule`, `production-calendar`)
- **The shift-claim flow, end to end** — staff call-in-sick (`app/me/schedule`), the
  manager queue for open shift offers (`app/admin/sick-calls`), and the unauthenticated
  claim page (`app/shifts/claim/[token]`)
- **Kiosk clock-in** (`app/kiosk/clock`)
- **Admin scheduling + timesheets** (`app/admin/schedule`, `app/admin/timesheets`)
- **Roles & capabilities admin** (`app/admin/roles`, `app/admin/users`)

`apps/web/src/lib/api.ts` is **not** a copy of the real client (which is ~5,400 lines /
~370 typed functions covering the entire private API surface). It's a from-scratch,
much shorter file implementing just the shared fetch helper and a curated slice of
the endpoints these six page groups call, enough to read as internally consistent —
not enough to reconstruct the real API.

## What's deliberately excluded

All Alembic migrations except the two named above, deployment/CI configuration
(`render.yaml`, Docker, GitHub Actions), Shopify app manifests, `.env` files and
secrets, Airtable schema/metadata dumps, internal audit/rollback docs, and any file
referencing a real person. See the project's internal build notes for the full
exclusion list — nothing in that list appears here.

## Stack

- **API**: FastAPI, Python, SQLAlchemy (async), Alembic, Pydantic v2
- **Web**: Next.js (App Router), TypeScript, Tailwind CSS
- **Integrations shown**: Airtable, Shopify Admin API + webhooks, transactional email

---

*Business names, domains, email addresses, location/warehouse names, and third-party
identifiers throughout this repository (e.g. "Northbound Ops", `northboundops.example`,
the second fulfillment location referred to as "Wavecrest US") are fictional
placeholders substituted for the real client's details.*
