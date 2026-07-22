# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Pull-only sync for Airtable's Production Runs table."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as _date_type, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import (
    AirtableProductionRun,
    MasterItem,
    ProductionRun,
    ProductionRunStatus,
)
from app.services.airtable import (
    AirtableClient,
    _coerce_str,
    _first_scalar,
    _to_decimal,
    _to_int,
)
from app.services.recipe_matching import (
    find_active_recipe_by_name,
    load_active_recipe_candidates,
)


def _parse_dt(v: Any) -> datetime | None:
    s = _coerce_str(v)
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _first_link(v: Any) -> str | None:
    if isinstance(v, list) and v:
        return str(v[0])
    return None


def _join_multi(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, list):
        return ", ".join(str(x) for x in v) or None
    return str(v) or None


@dataclass
class MappedProductionRun:
    airtable_id: str
    fields: dict[str, Any]
    master_item_airtable_id: str | None
    errors: list[str] = field(default_factory=list)


def map_run_record(record: dict) -> MappedProductionRun:
    src: dict[str, Any] = record.get("fields") or {}
    out: dict[str, Any] = {}
    errs: list[str] = []

    out["name"] = _coerce_str(_first_scalar(src.get("Production Run Name")))
    try:
        out["id_number"] = _to_int(_first_scalar(src.get("ID Number")))
    except ValueError as e:
        errs.append(f"id_number: {e}")
    out["status"] = _coerce_str(_first_scalar(src.get("Status")))
    out["warehouse"] = _coerce_str(_first_scalar(src.get("Warehouse")))
    out["production_stage"] = _join_multi(src.get("Production Stage"))
    out["batch_notes"] = _coerce_str(src.get("Batch Notes"))

    int_pairs = [
        ("production_target", "Production Target"),
        ("production_target_calculated", "Production Target (Calculated)"),
        ("finished_product", "Finished Product"),
        ("staff_bag_seal", "Staff (Bag and Seal)"),
        ("staff_boxing", "Staff (Boxing)"),
        ("qc_errors", "QC Errors"),
        ("create_finished_goods", "Create Finished Goods"),
        # Gap-fill (mig 0025)
        ("bagged_sealed_count", "Bagged & Sealed"),
        ("production_staff_bag_seal_estimation", "Production Staff Bag and Seal (Used in production estimation)"),
    ]
    for our, at in int_pairs:
        try:
            out[our] = _to_int(_first_scalar(src.get(at)))
        except ValueError as e:
            errs.append(f"{our}: {e}")

    decimal_pairs = [
        ("hours_bag_seal", "Hours Spent (Bag and Seal)"),
        ("hours_boxing", "Hours Spent (Boxing)"),
        # Gap-fill (mig 0025)
        ("bag_and_seal_hours_estimation", "Bag and Seal Hours (Used in production estimation)"),
        ("estimated_boxing_hours", "Estimated Boxing Hours"),
        ("box_per_hour_per_person_changeable", "Box per hour per person [Changeable]"),
        ("box_per_hour_per_person_dynamic", "Box per hour per person [Dynamic]"),
    ]
    for our, at in decimal_pairs:
        try:
            d = _to_decimal(_first_scalar(src.get(at)))
            out[our] = float(d) if isinstance(d, Decimal) else d
        except ValueError as e:
            errs.append(f"{our}: {e}")

    out["finished_goods_created_on_incoming"] = (
        bool(src.get("Finished Goods Created On Incoming")) if "Finished Goods Created On Incoming" in src else None
    )
    out["update_incoming_transaction"] = (
        bool(src.get("Update Incoming Transaction")) if "Update Incoming Transaction" in src else None
    )

    out["run_date"] = _parse_dt(_first_scalar(src.get("Run Date")))
    out["bag_seal_date"] = _parse_dt(_first_scalar(src.get("Bag & Seal Date")))
    out["completed_date"] = _parse_dt(_first_scalar(src.get("Completed Date")))

    item_at_id = _first_link(src.get("Product (Link to Master Items)"))
    out["master_item_airtable_id"] = item_at_id

    return MappedProductionRun(
        airtable_id=record["id"],
        fields=out,
        master_item_airtable_id=item_at_id,
        errors=errs,
    )


@dataclass
class ProductionRunSyncResult:
    fetched: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    linked: int = 0
    unlinked: int = 0
    errors: list[dict] = field(default_factory=list)


async def sync_production_runs(
    db: AsyncSession, client: AirtableClient, table: str = "Production Runs"
) -> ProductionRunSyncResult:
    mi_rows = (await db.execute(select(MasterItem))).scalars().all()
    mi_by_at_id: dict[str, MasterItem] = {
        m.airtable_record_id: m for m in mi_rows if m.airtable_record_id
    }

    existing = (await db.execute(select(AirtableProductionRun))).scalars().all()
    by_at_id: dict[str, AirtableProductionRun] = {r.airtable_record_id: r for r in existing}

    result = ProductionRunSyncResult()

    async for record in client.list_records(table):
        result.fetched += 1
        mapped = map_run_record(record)
        for e in mapped.errors:
            result.errors.append({"airtable_id": mapped.airtable_id, "error": e})

        master_item_id = None
        if mapped.master_item_airtable_id:
            mi = mi_by_at_id.get(mapped.master_item_airtable_id)
            if mi:
                master_item_id = mi.id
        if master_item_id is not None:
            result.linked += 1
        else:
            result.unlinked += 1

        existing_row = by_at_id.get(mapped.airtable_id)
        if existing_row is None:
            row = AirtableProductionRun(
                airtable_record_id=mapped.airtable_id,
                master_item_id=master_item_id,
                **mapped.fields,
            )
            db.add(row)
            by_at_id[mapped.airtable_id] = row
            result.created += 1
        else:
            changed = False
            if existing_row.master_item_id != master_item_id:
                existing_row.master_item_id = master_item_id
                changed = True
            for k, v in mapped.fields.items():
                if getattr(existing_row, k, None) != v:
                    setattr(existing_row, k, v)
                    changed = True
            if changed:
                db.add(existing_row)
                result.updated += 1
            else:
                result.skipped += 1

    return result


_STATUS_MAP: dict[str, ProductionRunStatus] = {
    "planned": ProductionRunStatus.PLANNED,
    "in progress": ProductionRunStatus.IN_PROGRESS,
    "bagged and sealed": ProductionRunStatus.IN_PROGRESS,
    "boxing": ProductionRunStatus.IN_PROGRESS,
    "completed": ProductionRunStatus.COMPLETED,
    "completed before system sync": ProductionRunStatus.COMPLETED,
    "cancelled": ProductionRunStatus.CANCELLED,
}


@dataclass
class ImportOpsRunsResult:
    fetched: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    no_master_item: int = 0
    recipe_linked: int = 0
    recipe_unlinked: int = 0
    backfilled_airtable_id: int = 0
    errors: list[str] = field(default_factory=list)


async def import_ops_production_runs(
    db: AsyncSession,
    client: AirtableClient,
    *,
    table: str = "Production Runs",
    before_date: _date_type | None = None,
) -> ImportOpsRunsResult:
    """Import Airtable Production Runs into the canonical (ops)
    `production_runs` table -- the write target for the scheduler UI
    and BOM auto-deduction. Distinct from `sync_production_runs` above,
    which only mirrors into the read-only `airtable_production_runs`
    table.

    Idempotency / dedup (mig ProductionRun.airtable_record_id, unique):
      1. If a `production_runs` row already carries this exact Airtable
         record's id, skip -- already imported, safe to call every
         cycle.
      2. Otherwise, if an existing row with NO `airtable_record_id` (a
         legacy row from the one-time 2026-06-30 bulk import, which
         predates this column being populated) already occupies this
         (finished_item_id, scheduled_date) slot, treat it as already
         representing this Airtable record: backfill the id onto it
         rather than creating a duplicate.
      3. Otherwise this is a genuinely new run -- create it. This is
         what fixes the historical dedup bug where two distinct same-
         day batches for one item collapsed to a single row: once the
         first batch's row is ID-stamped (via step 1 or 2), a second,
         different Airtable record for the same item/date no longer
         matches by id and is no longer blocked by the date-only key,
         so it is created instead of silently dropped.

    `before_date`: optional cutoff (exclusive) -- when `None` (the
    default), every run is considered regardless of date, so re-running
    this on a schedule also catches records Airtable backfills to past
    dates after an earlier import already ran.

    recipe_id resolution per created run: first the exact FK lookup by
    finished_item_id (mirrors `production.create_run` / `recipes.
    get_active_recipe_for_item`); if that finds nothing, falls back to
    `recipe_matching.find_active_recipe_by_name` (soft name match,
    hard-gated on Full/Mini/Kit/Brush/... variant tokens). Left `None`
    (never guessed) when neither finds a confident match.
    """
    mi_rows = (await db.execute(select(MasterItem))).scalars().all()
    mi_by_at_id = {m.airtable_record_id: m for m in mi_rows if m.airtable_record_id}

    existing_runs = (await db.execute(select(ProductionRun))).scalars().all()
    by_airtable_id: dict[str, ProductionRun] = {
        r.airtable_record_id: r for r in existing_runs if r.airtable_record_id
    }
    by_item_date_no_id: dict[tuple[str, str], ProductionRun] = {
        (str(r.finished_item_id), str(r.scheduled_date)): r
        for r in existing_runs
        if not r.airtable_record_id
    }

    recipe_candidates = await load_active_recipe_candidates(db)
    recipe_by_finished_item_id = {c.ref.finished_item_id: c.ref for c in recipe_candidates}

    result = ImportOpsRunsResult()

    async for record in client.list_records(table):
        mapped = map_run_record(record)
        f = mapped.fields

        run_date_raw = f.get("run_date")
        if not run_date_raw:
            result.skipped += 1
            continue
        run_date = run_date_raw.date() if hasattr(run_date_raw, "date") else None
        if run_date is None:
            result.skipped += 1
            continue
        if before_date is not None and run_date >= before_date:
            result.skipped += 1
            continue

        result.fetched += 1

        mi = mi_by_at_id.get(mapped.master_item_airtable_id or "")
        if not mi:
            result.no_master_item += 1
            continue

        # 1) Already imported (this exact Airtable record). Every other field
        # is create-once by design, but target_qty must keep tracking
        # Airtable's "Production Target" column even after the initial
        # import, since operators edit it in Airtable after a run exists.
        if mapped.airtable_id in by_airtable_id:
            existing_run = by_airtable_id[mapped.airtable_id]
            # "Production Target" is a manual override in Airtable and is
            # usually left blank -- "Production Target (Calculated)" is
            # Airtable's auto-derived value and is what's actually populated
            # for most runs. Fall back to it so target_qty isn't silently
            # null just because nobody typed an override in.
            new_target = f.get("production_target") or f.get("production_target_calculated")
            if existing_run.target_qty != new_target:
                existing_run.target_qty = new_target
                db.add(existing_run)
                result.updated += 1
            else:
                result.skipped += 1
            continue

        # 2) Legacy row (predates id tracking) occupying this slot --
        #    backfill instead of duplicating.
        fallback_key = (str(mi.id), str(run_date))
        legacy_row = by_item_date_no_id.get(fallback_key)
        if legacy_row is not None:
            legacy_row.airtable_record_id = mapped.airtable_id
            db.add(legacy_row)
            by_airtable_id[mapped.airtable_id] = legacy_row
            del by_item_date_no_id[fallback_key]
            result.skipped += 1
            result.backfilled_airtable_id += 1
            continue

        # 3) Genuinely new run.
        status_str = (f.get("status") or "planned").lower()
        status = _STATUS_MAP.get(status_str, ProductionRunStatus.PLANNED)
        is_completed = status == ProductionRunStatus.COMPLETED

        # "Packaging" in this business's terminology is the Boxing step,
        # not Bag and Seal (confirmed with the repo owner) -- derive from
        # hours_boxing, not hours_bag_seal.
        packaging_minutes = None
        if f.get("hours_boxing"):
            try:
                packaging_minutes = int(float(f["hours_boxing"]) * 60)
            except (TypeError, ValueError):
                pass

        # Sealing (hours_bag_seal) and packaging/boxing (hours_boxing) were
        # tracked as two separate figures that together made up the day's
        # combined production time (confirmed with the repo owner) --
        # hours_planned must be their sum, not hours_bag_seal alone.
        # include_packaging_hours is intentionally left False (its default)
        # for these imported runs: since packaging is already folded into
        # this sum, additionally adding packaging_minutes on top in
        # compute_capacity() would double-count it.
        try:
            bag_seal_hours = float(f["hours_bag_seal"]) if f.get("hours_bag_seal") else 0.0
        except (TypeError, ValueError):
            bag_seal_hours = 0.0
        try:
            boxing_hours = float(f["hours_boxing"]) if f.get("hours_boxing") else 0.0
        except (TypeError, ValueError):
            boxing_hours = 0.0
        combined_hours = bag_seal_hours + boxing_hours
        hours_planned = combined_hours if combined_hours > 0 else 8.0

        recipe = recipe_by_finished_item_id.get(mi.id)
        if recipe is None:
            recipe = await find_active_recipe_by_name(
                db, mi.name, candidates=recipe_candidates
            )
        if recipe is not None:
            result.recipe_linked += 1
        else:
            result.recipe_unlinked += 1

        run = ProductionRun(
            finished_item_id=mi.id,
            recipe_id=recipe.id if recipe else None,
            scheduled_date=run_date,
            status=status,
            run_type="finished",
            staff_count_planned=f.get("staff_bag_seal") or 1,
            hours_planned=hours_planned,
            # See the fallback comment on the update branch above.
            target_qty=f.get("production_target") or f.get("production_target_calculated"),
            completed_qty=f.get("finished_product"),
            completed_at=f.get("completed_date") if is_completed else None,
            notes=f.get("batch_notes"),
            qc_errors=str(f["qc_errors"]) if f.get("qc_errors") is not None else None,
            packaging_minutes=packaging_minutes,
            ledger_committed=is_completed,
            airtable_record_id=mapped.airtable_id,
        )
        db.add(run)
        by_airtable_id[mapped.airtable_id] = run
        result.created += 1

    return result
