# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Production scheduler + BOM auto-deduct (Phase B3).

Owns the math:
  - hours_total = SUM(production_run_staff.hours)  if any exist
                  else staff_count_planned * hours_planned
  - rate         = production_runs.baths_per_hour_per_person  if set
                  else DEFAULT_RATE_BATHS_PER_HOUR_PER_PERSON
  - target_qty   = round(hours_total * rate)

On `complete()` we write ledger entries in a single transaction:
  - one negative line per recipe_line (production_use, location=toronto)
  - one positive line for the finished item (production_output)
Correlation IDs key off the run id + component id so a replayed
completion is a no-op.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.production_rates import guardrail_for_db
from app.models.inventory import (
    InventoryTransaction,
    ItemType,
    Location,
    MasterItem,
    ProductionRun,
    ProductionRunStaff,
    ProductionRunStatus,
    Recipe,
    RecipeLine,
    TransactionType,
)
from app.models.shift import ShiftStatus, StaffShift
from app.services import inventory_ledger, rate_tuning
from app.services.unit_conversion import convert_qty_per_unit

log = logging.getLogger("northbound.production")

_PRODUCTION_SHIFT_START_HOUR = 9  # 9am local; opinionated default

DEFAULT_RATE_BATHS_PER_HOUR_PER_PERSON = 55.0
DEFAULT_PRODUCTION_LOCATION_CODE = "toronto"


@dataclass(slots=True)
class CapacityCalc:
    hours_total: float
    rate: float
    target_qty: int
    used_per_staff: bool


@dataclass(slots=True)
class BomPreflightComponent:
    item_id: uuid.UUID
    sku: str
    name: str
    item_type: str
    qty_per_unit: float
    qty_required: float
    on_hand: float
    shortfall: float
    measurement_unit: Optional[str]


@dataclass(slots=True)
class BomPreflightReport:
    finished_item_id: uuid.UUID
    finished_sku: str
    finished_name: str
    recipe_id: Optional[uuid.UUID]
    target_qty: int
    location_code: str
    can_produce: bool
    missing_recipe: bool
    components: list[BomPreflightComponent]


async def compute_capacity(db: AsyncSession, run: ProductionRun) -> CapacityCalc:
    """Returns the projected capacity for a planned run.

    Rate fallback chain:
      1. run.baths_per_hour_per_person (per-run override)
      2. master_items.baths_per_hour_per_person (per-SKU default,
         set per historical throughput data during a one-time backfill)
      3. constant 55 (legacy)
    """
    staff_sum_stmt = select(func.coalesce(func.sum(ProductionRunStaff.hours), 0)).where(
        ProductionRunStaff.production_run_id == run.id
    )
    staff_hours = float((await db.execute(staff_sum_stmt)).scalar_one() or 0)
    used_per_staff = staff_hours > 0

    hours_total = staff_hours if used_per_staff else float(run.staff_count_planned) * float(
        run.hours_planned or 0
    )
    # packaging_minutes is a tracked metric only by default -- packaging
    # sometimes spills into another day (daily target already hit, bagging
    # finished later), so it shouldn't silently inflate this run's hours.
    # include_packaging_hours is an explicit per-run opt-in for when
    # packaging genuinely happened within the same block of time.
    # Multiplied by packaging_staff_count (defaulting to 1 crew member if
    # unset) to turn tracked duration into actual labor-hours, same as
    # production_run_staff.hours already does for the main run.
    if run.include_packaging_hours and run.packaging_minutes:
        hours_total += (float(run.packaging_minutes) / 60.0) * float(
            run.packaging_staff_count or 1
        )

    # Same reasoning for combined bag+seal time -- opt-in via
    # include_bag_seal_hours, multiplied by bag_seal_staff_count.
    bag_seal_minutes = (run.bag_minutes or 0) + (run.seal_minutes or 0)
    if run.include_bag_seal_hours and bag_seal_minutes:
        hours_total += (float(bag_seal_minutes) / 60.0) * float(
            run.bag_seal_staff_count or 1
        )

    rate: float
    if run.baths_per_hour_per_person is not None:
        rate = float(run.baths_per_hour_per_person)
    else:
        item = await db.get(MasterItem, run.finished_item_id)
        if item is not None and item.baths_per_hour_per_person is not None:
            rate = float(item.baths_per_hour_per_person)
        else:
            rate = DEFAULT_RATE_BATHS_PER_HOUR_PER_PERSON

    target_qty = int(round(hours_total * rate))
    return CapacityCalc(
        hours_total=hours_total,
        rate=rate,
        target_qty=target_qty,
        used_per_staff=used_per_staff,
    )


async def create_run(
    db: AsyncSession,
    *,
    finished_item_id: uuid.UUID,
    scheduled_date: date,
    run_type: str = "finished",
    staff_count_planned: int = 1,
    hours_planned: float = 8.0,
    baths_per_hour_per_person: Optional[float] = None,
    notes: Optional[str] = None,
    created_by_user_id: Optional[uuid.UUID] = None,
) -> ProductionRun:
    # Attach the active recipe live (Q1 decision: no snapshot column).
    recipe_stmt = select(Recipe).where(
        Recipe.finished_item_id == finished_item_id,
        Recipe.is_active.is_(True),
    )
    recipe = (await db.execute(recipe_stmt)).scalar_one_or_none()

    run = ProductionRun(
        finished_item_id=finished_item_id,
        recipe_id=recipe.id if recipe else None,
        scheduled_date=scheduled_date,
        status=ProductionRunStatus.PLANNED,
        run_type=run_type,
        staff_count_planned=staff_count_planned,
        hours_planned=hours_planned,
        baths_per_hour_per_person=baths_per_hour_per_person,
        notes=notes,
        created_by_user_id=created_by_user_id,
    )
    db.add(run)
    await db.flush()
    # Initial target_qty derived from planned headcount/hours (no
    # per-staff rows exist yet).
    cap = await compute_capacity(db, run)
    run.target_qty = cap.target_qty
    await db.flush()
    return run


_AUTO_NOTE_PREFIX = "Auto-linked to production run"


async def _sync_shift_for_run_staff(
    db: AsyncSession,
    *,
    run: ProductionRun,
    user_id: uuid.UUID,
    hours: float,
) -> None:
    """Upsert the matching staff_shift row for a (run, user) pair.

    Lookup order:
      1. An existing shift already linked to (run, user) -- update it.
      2. Any SCHEDULED shift for this user whose window touches the
         production day, NOT already linked to a different run --
         claim it (set production_run_id, leave times/role/notes
         alone so the manual shift's original intent is preserved).
      3. Create a fresh shift, 9am local for `hours` hours.

    Worked or cancelled shifts (status != SCHEDULED) are never
    rewritten -- the workforce UI owns those transitions.
    """
    if hours <= 0:
        return
    tz = ZoneInfo(get_settings().app_timezone)
    start_local = datetime.combine(
        run.scheduled_date, time(hour=_PRODUCTION_SHIFT_START_HOUR), tzinfo=tz
    )
    end_local = start_local + timedelta(hours=float(hours))
    starts_at = start_local.astimezone(timezone.utc)
    ends_at = end_local.astimezone(timezone.utc)
    # Local-day window used to detect manual shifts to claim.
    day_start_utc = datetime.combine(
        run.scheduled_date, time.min, tzinfo=tz
    ).astimezone(timezone.utc)
    day_end_utc = day_start_utc + timedelta(days=1)

    # 1. Already linked to this run?
    existing_stmt = select(StaffShift).where(
        StaffShift.production_run_id == run.id,
        StaffShift.user_id == user_id,
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing is not None:
        if existing.status != ShiftStatus.SCHEDULED:
            return
        # Only rewrite times/role/notes if WE created this shift
        # (prefix sentinel). For a claimed manual shift, leave the
        # original window intact.
        if (existing.notes or "").startswith(_AUTO_NOTE_PREFIX):
            existing.starts_at = starts_at
            existing.ends_at = ends_at
            existing.role_label = "Production"
            existing.notes = f"{_AUTO_NOTE_PREFIX} {str(run.id)[:8]}"
        await db.flush()
        return

    # 2. Claim an existing manual shift on the same day if one
    # exists and isn't linked to a different run.
    claim_stmt = (
        select(StaffShift)
        .where(
            StaffShift.user_id == user_id,
            StaffShift.status == ShiftStatus.SCHEDULED,
            StaffShift.production_run_id.is_(None),
            StaffShift.starts_at < day_end_utc,
            StaffShift.ends_at > day_start_utc,
        )
        .order_by(StaffShift.starts_at)
        .limit(1)
    )
    claimable = (await db.execute(claim_stmt)).scalar_one_or_none()
    if claimable is not None:
        claimable.production_run_id = run.id
        # Original role_label / notes / times stay intact so the
        # operator's planning context isn't clobbered.
        await db.flush()
        return

    # 3. No existing shift -- create a fresh one. Sentinel-prefixed
    # notes mark this as our auto-creation so removal can delete
    # it cleanly (vs. unlink for claims).
    db.add(
        StaffShift(
            user_id=user_id,
            location="toronto",
            role_label="Production",
            starts_at=starts_at,
            ends_at=ends_at,
            status=ShiftStatus.SCHEDULED,
            notes=f"{_AUTO_NOTE_PREFIX} {str(run.id)[:8]}",
            production_run_id=run.id,
        )
    )
    await db.flush()


async def _remove_shift_for_run_staff(
    db: AsyncSession,
    *,
    production_run_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    """If WE auto-created the linked shift -> delete it.
    If we only claimed a pre-existing manual shift -> unlink it
    (set production_run_id = NULL) and leave it on the calendar.
    """
    stmt = select(StaffShift).where(
        StaffShift.production_run_id == production_run_id,
        StaffShift.user_id == user_id,
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        return
    if row.status != ShiftStatus.SCHEDULED:
        return
    if (row.notes or "").startswith(_AUTO_NOTE_PREFIX):
        await db.delete(row)
    else:
        row.production_run_id = None
    await db.flush()


async def set_staff_hours(
    db: AsyncSession,
    *,
    production_run_id: uuid.UUID,
    user_id: uuid.UUID,
    hours: float,
    shift_hours: Optional[float] = None,
) -> ProductionRunStaff:
    """Upsert a single staff member's hours on a run.

    `hours`        -- production hours, used for capacity math
    `shift_hours`  -- calendar shift duration; pass None to mirror
                      production hours, or pass a different value
                      (e.g. 8 when they're on shift 8h but only
                      working 4h on the run).

    Triggers staff_shift sync using shift_hours (or hours fallback).
    """
    existing_stmt = select(ProductionRunStaff).where(
        ProductionRunStaff.production_run_id == production_run_id,
        ProductionRunStaff.user_id == user_id,
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing is not None:
        existing.hours = hours
        if shift_hours is not None:
            existing.shift_hours = shift_hours
    else:
        existing = ProductionRunStaff(
            production_run_id=production_run_id,
            user_id=user_id,
            hours=hours,
            shift_hours=shift_hours,
        )
        db.add(existing)
    await db.flush()

    effective_shift_hours = (
        float(existing.shift_hours) if existing.shift_hours is not None else float(existing.hours)
    )
    run = await db.get(ProductionRun, production_run_id)
    if run is not None:
        await _sync_shift_for_run_staff(
            db, run=run, user_id=user_id, hours=effective_shift_hours
        )

    return existing


async def remove_staff(
    db: AsyncSession, *, production_run_id: uuid.UUID, user_id: uuid.UUID
) -> bool:
    stmt = select(ProductionRunStaff).where(
        ProductionRunStaff.production_run_id == production_run_id,
        ProductionRunStaff.user_id == user_id,
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        return False
    await db.delete(row)
    await db.flush()
    await _remove_shift_for_run_staff(
        db, production_run_id=production_run_id, user_id=user_id
    )
    return True


async def recompute_target(db: AsyncSession, run: ProductionRun) -> ProductionRun:
    cap = await compute_capacity(db, run)
    run.target_qty = cap.target_qty
    await db.flush()
    return run


async def bom_preflight(
    db: AsyncSession,
    *,
    finished_item_id: uuid.UUID,
    target_qty: int,
    location_code: str = "toronto",
) -> BomPreflightReport:
    """Per-component stock check for a planned production run.

    Returns required vs on-hand quantities for every recipe line so the
    UI can surface shortfalls before a run starts.
    """
    finished = await db.get(MasterItem, finished_item_id)
    if finished is None:
        raise ValueError(f"Item {finished_item_id} not found")

    recipe_stmt = select(Recipe).where(
        Recipe.finished_item_id == finished_item_id,
        Recipe.is_active.is_(True),
    )
    recipe = (await db.execute(recipe_stmt)).scalar_one_or_none()

    if recipe is None:
        return BomPreflightReport(
            finished_item_id=finished_item_id,
            finished_sku=finished.sku,
            finished_name=finished.name,
            recipe_id=None,
            target_qty=target_qty,
            location_code=location_code,
            can_produce=False,
            missing_recipe=True,
            components=[],
        )

    loc_stmt = select(Location).where(Location.code == location_code)
    location = (await db.execute(loc_stmt)).scalar_one_or_none()
    if location is None:
        raise ValueError(f"Location {location_code!r} not found")

    lines_stmt = select(RecipeLine).where(RecipeLine.recipe_id == recipe.id)
    lines = list((await db.execute(lines_stmt)).scalars())

    components: list[BomPreflightComponent] = []
    can_produce = True

    for line in lines:
        component = await db.get(MasterItem, line.component_item_id)
        if component is None:
            continue

        # On-hand always reads the inventory_ledger sum -- the same source
        # master-items-v2 uses -- rather than master_items.at_available_toronto
        # (a denormalized column only ever written by the Airtable pull-sync,
        # so it goes stale the moment a production run consumes stock between
        # syncs; confirmed live on a sample SKU where at_available_toronto
        # still showed the pre-consumption Airtable baseline after a completed
        # run had already deducted stock in the ledger). recipe_lines already
        # FK straight to master_items, so this makes the ledger the single
        # source of truth end to end -- and keeps working unchanged once
        # Airtable is retired, since nothing here depends on it anymore.
        on_hand = await inventory_ledger.on_hand(db, component.id, location.id)

        if component.item_type == ItemType.PACKAGING:
            # Packaging is counted (not weighed) in its own native unit
            # ("Individual", "Batches", etc.) -- the grams-per-purchase-unit
            # conversion below doesn't apply to it.
            converted_qty_per_unit = convert_qty_per_unit(
                qty_per_unit=float(line.qty_per_unit),
                recipe_measurement_unit=line.measurement_unit,
                item=component,
                recipe_id=recipe.id,
            )
            display_unit = component.unit
        else:
            # Ingredients: ledger on-hand is tracked in grams -- production
            # consumption is posted to the ledger in grams too (see
            # complete()'s use of this same converted_qty_per_unit), and
            # quantity_per_purchase_unit is a purchasing-only factor (grams
            # per supplier bag/case) that does NOT describe how stock is
            # counted day-to-day. Comparing a recipe's grams requirement
            # against on-hand after dividing by that factor mixes two
            # different units in the shortfall math, not just the display.
            # Compare directly in grams instead.
            converted_qty_per_unit = float(line.qty_per_unit)
            display_unit = "g"

        qty_required = converted_qty_per_unit * target_qty
        shortfall = max(0.0, qty_required - on_hand)
        if shortfall > 0:
            can_produce = False

        components.append(BomPreflightComponent(
            item_id=component.id,
            sku=component.sku,
            name=component.name,
            item_type=component.item_type.value,
            qty_per_unit=converted_qty_per_unit,
            qty_required=qty_required,
            on_hand=on_hand,
            shortfall=shortfall,
            measurement_unit=display_unit,
        ))

    return BomPreflightReport(
        finished_item_id=finished_item_id,
        finished_sku=finished.sku,
        finished_name=finished.name,
        recipe_id=recipe.id,
        target_qty=target_qty,
        location_code=location_code,
        can_produce=can_produce,
        missing_recipe=False,
        components=components,
    )


async def resync_shifts_for_run(db: AsyncSession, run: ProductionRun) -> None:
    """Re-derive every linked shift's start/end from the run's
    current scheduled_date. Called from PATCH /production-runs when
    the date moves so staff calendars stay in sync.
    """
    staff_rows = list(
        (
            await db.execute(
                select(ProductionRunStaff).where(
                    ProductionRunStaff.production_run_id == run.id
                )
            )
        ).scalars()
    )
    for s in staff_rows:
        eff = float(s.shift_hours) if s.shift_hours is not None else float(s.hours)
        await _sync_shift_for_run_staff(db, run=run, user_id=s.user_id, hours=eff)


async def cleanup_shifts_for_run(db: AsyncSession, production_run_id: uuid.UUID) -> None:
    """On run deletion: delete auto-created scheduled shifts,
    unlink claimed ones (keep the manual shift on the calendar).
    Worked / cancelled shifts are untouched.
    """
    stmt = select(StaffShift).where(StaffShift.production_run_id == production_run_id)
    for row in (await db.execute(stmt)).scalars():
        if row.status != ShiftStatus.SCHEDULED:
            continue
        if (row.notes or "").startswith(_AUTO_NOTE_PREFIX):
            await db.delete(row)
        else:
            row.production_run_id = None
    await db.flush()


async def adjust_completed_qty(
    db: AsyncSession,
    *,
    run: ProductionRun,
    new_completed_qty: int,
    actor_user_id: Optional[uuid.UUID] = None,
    location_code: str = DEFAULT_PRODUCTION_LOCATION_CODE,
) -> ProductionRun:
    """Post a delta against a completed run.

    Writes one supplemental ledger row per BOM component plus one
    for the finished item, all carrying a fresh correlation_id
    keyed on the adjustment timestamp so reposts are dedup'd.

    Errors if run hasn't been completed (use complete_run first)
    or if new_completed_qty matches the current value (no-op).
    """
    if not run.ledger_committed or run.status != ProductionRunStatus.COMPLETED:
        raise ValueError("Run must be completed before adjusting")
    if new_completed_qty <= 0:
        raise ValueError("new_completed_qty must be positive")
    old_qty = run.completed_qty or 0
    delta = new_completed_qty - old_qty
    if delta == 0:
        raise ValueError("new_completed_qty equals current; nothing to adjust")

    loc_stmt = select(Location).where(Location.code == location_code)
    loc = (await db.execute(loc_stmt)).scalar_one_or_none()
    if loc is None:
        raise ValueError(f"Unknown location code: {location_code}")

    if run.recipe_id is None:
        recipe_stmt = select(Recipe).where(
            Recipe.finished_item_id == run.finished_item_id,
            Recipe.is_active.is_(True),
        )
        recipe = (await db.execute(recipe_stmt)).scalar_one_or_none()
        if recipe is None:
            raise ValueError("Run has no recipe link and no active recipe found for this item; cannot adjust BOM")
        run.recipe_id = recipe.id
        await db.flush()
    else:
        recipe = await db.get(Recipe, run.recipe_id)
        if recipe is None:
            raise ValueError("Linked recipe is missing")

    lines_stmt = select(RecipeLine).where(RecipeLine.recipe_id == recipe.id)
    lines = list((await db.execute(lines_stmt)).scalars())

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%S%f")
    run_id_str = str(run.id)

    # Adjust each BOM component by the delta (-) for additional
    # output, (+) when shrinking the qty back.
    for line in lines:
        component = await db.get(MasterItem, line.component_item_id)
        if component is None:
            raise ValueError(
                f"Recipe component {line.component_item_id} no longer exists; "
                "cannot adjust BOM"
            )
        # Ingredients are always tracked in grams (see bom_preflight) --
        # quantity_per_purchase_unit is purchasing-only, not a stock-basis
        # conversion factor, so deduct the raw recipe grams directly.
        # Packaging is counted in its own native unit and still needs
        # convert_qty_per_unit's each/individual/batches alias handling.
        converted_qty_per_unit = (
            float(line.qty_per_unit)
            if component.item_type != ItemType.PACKAGING
            else convert_qty_per_unit(
                qty_per_unit=float(line.qty_per_unit),
                recipe_measurement_unit=line.measurement_unit,
                item=component,
                recipe_id=recipe.id,
            )
        )
        bom_delta = -int(round(converted_qty_per_unit * delta))
        if bom_delta == 0:
            continue
        await inventory_ledger.record(
            db,
            item_id=line.component_item_id,
            location_id=loc.id,
            quantity=bom_delta,
            transaction_type=TransactionType.PRODUCTION_USE,
            origin="production_run_adjust",
            correlation_id=f"prun:{run_id_str}:adjust:{stamp}:use:{line.component_item_id}",
            reference_table="production_runs",
            reference_id=run.id,
            note=f"Run {run_id_str[:8]} adjust {old_qty}->{new_completed_qty}",
            occurred_at=now,
            created_by_user_id=actor_user_id,
            legacy_location=loc.code,
        )

    # Adjust the finished output.
    await inventory_ledger.record(
        db,
        item_id=run.finished_item_id,
        location_id=loc.id,
        quantity=int(delta),
        transaction_type=TransactionType.PRODUCTION_OUTPUT,
        origin="production_run_adjust",
        correlation_id=f"prun:{run_id_str}:adjust:{stamp}:output",
        reference_table="production_runs",
        reference_id=run.id,
        note=f"Run {run_id_str[:8]} adjust output {old_qty}->{new_completed_qty}",
        occurred_at=now,
        created_by_user_id=actor_user_id,
        legacy_location=loc.code,
    )

    run.completed_qty = new_completed_qty
    await db.flush()

    # Shopify push moved to route layer, after db.commit() — see routes/production.py
    try:
        await rate_tuning.recompute_rate_from_history(
            db, finished_item_id=run.finished_item_id
        )
    except Exception:  # noqa: BLE001
        pass
    return run


async def complete_run(
    db: AsyncSession,
    *,
    run: ProductionRun,
    completed_qty: int,
    actor_user_id: Optional[uuid.UUID] = None,
    location_code: str = DEFAULT_PRODUCTION_LOCATION_CODE,
) -> ProductionRun:
    """Atomically mark a run completed and deduct components from inventory.

    Idempotent via correlation_id keyed on the run id. Calling
    `complete_run` twice for the same run is a no-op (raises if
    ledger_committed is already true).
    """
    if run.ledger_committed:
        raise ValueError("Run already committed to ledger")
    if completed_qty <= 0:
        raise ValueError("completed_qty must be positive")

    loc_stmt = select(Location).where(Location.code == location_code)
    loc = (await db.execute(loc_stmt)).scalar_one_or_none()
    if loc is None:
        raise ValueError(f"Unknown location code: {location_code}")

    # Resolve the live recipe. We rely on whatever is active right
    # now (Q1: live FK, no snapshot).
    if run.recipe_id is None:
        recipe_stmt = select(Recipe).where(
            Recipe.finished_item_id == run.finished_item_id,
            Recipe.is_active.is_(True),
        )
        recipe = (await db.execute(recipe_stmt)).scalar_one_or_none()
        if recipe is None:
            raise ValueError("No active recipe for this finished item; cannot deduct BOM")
        run.recipe_id = recipe.id
    else:
        recipe = await db.get(Recipe, run.recipe_id)
        if recipe is None or not recipe.is_active:
            raise ValueError("Linked recipe is missing or inactive")

    lines_stmt = select(RecipeLine).where(RecipeLine.recipe_id == recipe.id)
    lines = list((await db.execute(lines_stmt)).scalars())

    now = datetime.now(timezone.utc)
    run_id_str = str(run.id)

    # Deduct each component (ingredients + packaging).
    for line in lines:
        component = await db.get(MasterItem, line.component_item_id)
        if component is None:
            raise ValueError(
                f"Recipe component {line.component_item_id} no longer exists; "
                "cannot complete run"
            )
        # Ingredients are always tracked in grams (see bom_preflight) --
        # quantity_per_purchase_unit is purchasing-only, not a stock-basis
        # conversion factor, so deduct the raw recipe grams directly.
        # Packaging is counted in its own native unit and still needs
        # convert_qty_per_unit's each/individual/batches alias handling.
        converted_qty_per_unit = (
            float(line.qty_per_unit)
            if component.item_type != ItemType.PACKAGING
            else convert_qty_per_unit(
                qty_per_unit=float(line.qty_per_unit),
                recipe_measurement_unit=line.measurement_unit,
                item=component,
                recipe_id=recipe.id,
            )
        )
        delta = -int(round(converted_qty_per_unit * completed_qty))
        await inventory_ledger.record(
            db,
            item_id=line.component_item_id,
            location_id=loc.id,
            quantity=delta,
            transaction_type=TransactionType.PRODUCTION_USE,
            origin="production_run",
            correlation_id=f"prun:{run_id_str}:use:{line.component_item_id}",
            reference_table="production_runs",
            reference_id=run.id,
            note=f"Run {run_id_str[:8]} -- {recipe.name or 'recipe'}",
            occurred_at=now,
            created_by_user_id=actor_user_id,
            legacy_location=loc.code,
        )

    # Credit the finished item.
    await inventory_ledger.record(
        db,
        item_id=run.finished_item_id,
        location_id=loc.id,
        quantity=int(completed_qty),
        transaction_type=TransactionType.PRODUCTION_OUTPUT,
        origin="production_run",
        correlation_id=f"prun:{run_id_str}:output",
        reference_table="production_runs",
        reference_id=run.id,
        note=f"Run {run_id_str[:8]} output",
        occurred_at=now,
        created_by_user_id=actor_user_id,
        legacy_location=loc.code,
    )

    run.status = ProductionRunStatus.COMPLETED
    run.completed_qty = completed_qty
    run.completed_at = now
    run.ledger_committed = True
    await db.flush()

    # Shopify push moved to route layer, after db.commit() — see routes/production.py
    # Guardrail check: warn if the effective rate (completed_qty per
    # staff-hour) drifted outside the +-25% band around the
    # configured baths_per_hour_per_person. Log-only -- doesn't fail
    # the completion or auto-correct anything.
    await _warn_if_outside_guardrail(db, run=run, completed_qty=completed_qty)
    # Auto-tune the per-SKU production rate from the latest history.
    # Logs only; safe to fail silently.
    try:
        await rate_tuning.recompute_rate_from_history(
            db, finished_item_id=run.finished_item_id
        )
    except Exception:  # noqa: BLE001
        pass

    return run


async def correct_run_finished_item(
    db: AsyncSession,
    *,
    run: ProductionRun,
    new_finished_item_id: uuid.UUID,
    actor_user_id: Optional[uuid.UUID] = None,
) -> ProductionRun:
    """Super-admin-only correction for a completed run linked to the wrong
    finished item entirely (a real data-entry mistake -- not a display/
    naming issue). "Change bath" (the pre-completion item picker) is
    intentionally hidden once a run completes because the ledger has
    already been posted against the OLD item's recipe; this function is
    the deliberate, audited path to undo that and repost correctly.

    Reverses every ledger transaction this run originally posted (the
    initial complete_run() postings AND any later adjust_completed_qty
    deltas) by negating each row exactly as it stands, not recomputing --
    so the reversal nets to zero regardless of intervening adjustments.
    Re-links the run to the new item + its active recipe, then reposts
    fresh deductions/output for the new item at the same completed_qty.

    Caller commits once at the end.
    """
    if run.status != ProductionRunStatus.COMPLETED or not run.ledger_committed:
        raise ValueError("Only a completed, ledger-committed run can have its item corrected")
    if run.completed_qty is None or run.completed_qty <= 0:
        raise ValueError("Run has no completed_qty to re-post")
    if new_finished_item_id == run.finished_item_id:
        raise ValueError("New item is the same as the current one")
    new_item = await db.get(MasterItem, new_finished_item_id)
    if new_item is None:
        raise ValueError(f"Item {new_finished_item_id} not found")

    loc_stmt = select(Location).where(Location.code == DEFAULT_PRODUCTION_LOCATION_CODE)
    loc = (await db.execute(loc_stmt)).scalar_one_or_none()
    if loc is None:
        raise ValueError(f"Unknown location code: {DEFAULT_PRODUCTION_LOCATION_CODE}")

    run_id_str = str(run.id)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%S%f")
    old_item_id = run.finished_item_id
    old_completed_qty = run.completed_qty

    # 1. Reverse every ledger transaction this run originally posted.
    orig_tx_stmt = select(InventoryTransaction).where(
        InventoryTransaction.reference_table == "production_runs",
        InventoryTransaction.reference_id == run.id,
        InventoryTransaction.origin.in_(["production_run", "production_run_adjust"]),
    )
    orig_txs = list((await db.execute(orig_tx_stmt)).scalars())
    for tx in orig_txs:
        await inventory_ledger.record(
            db,
            item_id=tx.item_id,
            location_id=tx.location_id or loc.id,
            quantity=-tx.quantity,
            transaction_type=tx.transaction_type,
            origin="production_run_item_correction",
            correlation_id=f"prun:{run_id_str}:item_correction:{stamp}:reverse:{tx.id}",
            reference_table="production_runs",
            reference_id=run.id,
            note=(
                f"Run {run_id_str[:8]}: reversing postings made against the "
                f"wrong finished item {old_item_id} (undoing txn {tx.id})"
            ),
            occurred_at=now,
            created_by_user_id=actor_user_id,
            legacy_location=tx.location or loc.code,
        )

    # 2. Re-link the run to the new item + its active recipe (or None),
    # matching the pre-completion "Change bath" behavior.
    run.finished_item_id = new_finished_item_id
    new_recipe_stmt = select(Recipe).where(
        Recipe.finished_item_id == new_finished_item_id,
        Recipe.is_active.is_(True),
    )
    new_recipe = (await db.execute(new_recipe_stmt)).scalar_one_or_none()
    run.recipe_id = new_recipe.id if new_recipe else None
    run.baths_per_hour_per_person = None

    # 3. Repost deductions/output for the NEW item, if it has an active
    # recipe. If not, the run is re-linked but produces no fresh BOM
    # postings -- same "No recipe linked" state any completed run without
    # a recipe already shows.
    if new_recipe is not None:
        lines_stmt = select(RecipeLine).where(RecipeLine.recipe_id == new_recipe.id)
        lines = list((await db.execute(lines_stmt)).scalars())
        for line in lines:
            component = await db.get(MasterItem, line.component_item_id)
            if component is None:
                raise ValueError(
                    f"Recipe component {line.component_item_id} no longer exists; "
                    "cannot repost corrected BOM"
                )
            converted_qty_per_unit = (
                float(line.qty_per_unit)
                if component.item_type != ItemType.PACKAGING
                else convert_qty_per_unit(
                    qty_per_unit=float(line.qty_per_unit),
                    recipe_measurement_unit=line.measurement_unit,
                    item=component,
                    recipe_id=new_recipe.id,
                )
            )
            delta = -int(round(converted_qty_per_unit * old_completed_qty))
            await inventory_ledger.record(
                db,
                item_id=line.component_item_id,
                location_id=loc.id,
                quantity=delta,
                transaction_type=TransactionType.PRODUCTION_USE,
                origin="production_run_item_correction",
                correlation_id=f"prun:{run_id_str}:item_correction:{stamp}:use:{line.component_item_id}",
                reference_table="production_runs",
                reference_id=run.id,
                note=f"Run {run_id_str[:8]} -- corrected to {new_item.name}",
                occurred_at=now,
                created_by_user_id=actor_user_id,
                legacy_location=loc.code,
            )
        await inventory_ledger.record(
            db,
            item_id=new_finished_item_id,
            location_id=loc.id,
            quantity=int(old_completed_qty),
            transaction_type=TransactionType.PRODUCTION_OUTPUT,
            origin="production_run_item_correction",
            correlation_id=f"prun:{run_id_str}:item_correction:{stamp}:output",
            reference_table="production_runs",
            reference_id=run.id,
            note=f"Run {run_id_str[:8]} output -- corrected to {new_item.name}",
            occurred_at=now,
            created_by_user_id=actor_user_id,
            legacy_location=loc.code,
        )

    await db.flush()
    return run


async def _warn_if_outside_guardrail(
    db: AsyncSession, *, run: ProductionRun, completed_qty: int
) -> None:
    """Emit a structured warning when a completed run's effective
    rate falls outside the +-25% guardrail band around the configured
    rate. Best-effort -- swallows errors so a guardrail miscalc can
    never abort a successful completion."""
    try:
        cap = await compute_capacity(db, run)
        if cap.hours_total <= 0 or cap.rate <= 0:
            return
        effective_rate = float(completed_qty) / cap.hours_total
        lower, upper = await guardrail_for_db(db, cap.rate)
        if lower is None or upper is None:
            return
        if effective_rate < lower or effective_rate > upper:
            log.warning(
                "production_rate_guardrail_breach run=%s finished_item_id=%s "
                "configured_rate=%.2f effective_rate=%.2f band=[%.2f, %.2f] "
                "completed_qty=%d hours_total=%.2f",
                run.id,
                run.finished_item_id,
                cap.rate,
                effective_rate,
                lower,
                upper,
                completed_qty,
                cap.hours_total,
            )
    except Exception:  # noqa: BLE001
        pass
