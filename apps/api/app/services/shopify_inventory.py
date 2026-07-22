# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Shopify inventory sync (Phase C).

Outbound:
  - `push_inventory_level(inventory_item_id, location_id, available)`
    POSTs to `/admin/api/<ver>/inventory_levels/set.json` to make
    Shopify match our on-hand. Idempotent: setting the same value
    twice is a no-op on Shopify's side.

  - In shadow mode (push disabled), the function logs the intent and
    returns without making any HTTP call. Use the reconciler to compare
    what we *would* have written against Shopify's actual state. The
    kill switch is a DB-backed override (super-admin toggle on
    /admin/integrations, app_config key "shopify_inventory_push_enabled")
    with the SHOPIFY_INVENTORY_PUSH_ENABLED env var as the fallback/
    default when no override has been saved.

  - `maybe_push_for_item(db, item_id, location_id)` is the standard
    call site: looks up the variant's shopify_inventory_item_id and
    the location's shopify_location_id, then calls push_inventory_level.
    Only called for Toronto. Never called for Wavecrest US (3PL-managed).
    Only ops-originated transactions (production output, transfers,
    manual adjustments) should call this — never webhook handlers.

Inbound:
  - `apply_webhook_delta(payload, db, webhook_id=None)` interprets a
    live `inventory_levels/update` body and computes the delta
    between Shopify's reported `available` and ops on-hand.

    Wavecrest US: writes an ADJUSTMENT ledger entry immediately (same
    math as `sync_wavecrest_us_from_shopify`, just event-triggered
    instead of on the 30-min timer) and refreshes the cached
    `stock_available_wavecrest`. Safe because Wavecrest has no other
    live decrement path — fulfillment there is 3PL-managed and
    `apply_fulfillment` explicitly skips it, so reacting to every
    webhook vs. polling every 30 min is the same reconciliation, just
    faster. Idempotent via `webhook_id` (Shopify's X-Shopify-Webhook-Id)
    folded into the ledger correlation_id.

    Toronto: refreshes cached `stock_available_toronto` but does NOT
    write a ledger entry. Shopify `available` = on_hand - committed,
    so at the moment an order is placed (committed, not yet shipped)
    this delta looks identical to a real decrement. Toronto already
    has a live, correct decrement path — `apply_fulfillment` on the
    `fulfillments-create` webhook/topic, firing once per shipped line
    item. Also writing an ADJUSTMENT here for Toronto would double-
    decrement every order: once at commit (this webhook) and again
    at fulfillment (the other one).

Reconciler:
  - `reconcile_canada_finished(db)` walks every finished SKU with
    a shopify_inventory_item_id and the Toronto Shopify location,
    fetches the current level, and returns a list of drift rows
    (ops_on_hand, shopify_available, delta). Note: delta includes
    committed orders as apparent drift — this is expected and normal
    when orders are pending. The reconciler is for human review only.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.inventory import (
    InventoryTransaction,
    ItemType,
    Location,
    MasterItem,
    TransactionType,
)
from app.services import app_config, inventory_ledger
from datetime import datetime, timezone

log = logging.getLogger("northbound.shopify_inventory")

# Shopify Admin REST API allows ~2 requests/sec (leaky bucket, burst 40) per
# shop. The reconciler/push/pull loops below make one request per SKU in a
# tight loop, so without a small delay + 429 handling they can blow through
# the bucket on stores with more than a couple dozen SKUs and silently
# truncate the drift report (a caught "shopify 429" error per remaining row)
# instead of retrying. This throttle + backoff applies to all three loops.
_INTER_REQUEST_DELAY_SECONDS = 0.55
_MAX_RATE_LIMIT_RETRIES = 4
_DEFAULT_RETRY_AFTER_SECONDS = 2.0


async def _throttle() -> None:
    """Small delay between per-SKU requests to stay under Shopify's bucket."""
    await asyncio.sleep(_INTER_REQUEST_DELAY_SECONDS)


async def _request_with_backoff(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response:
    """Issue one Shopify Admin API request, retrying on HTTP 429.

    Reads the `Retry-After` header (seconds) when present and sleeps that
    long before retrying, bounded to `_MAX_RATE_LIMIT_RETRIES` attempts.
    Falls back to `_DEFAULT_RETRY_AFTER_SECONDS` if the header is missing
    or unparseable. Non-429 responses (including other 4xx/5xx) are
    returned immediately for the caller's existing status_code>=400 handling.
    """
    attempt = 0
    while True:
        response = await client.request(method, url, **kwargs)
        if response.status_code != 429 or attempt >= _MAX_RATE_LIMIT_RETRIES:
            return response

        retry_after_header = response.headers.get("Retry-After")
        try:
            delay = float(retry_after_header) if retry_after_header else _DEFAULT_RETRY_AFTER_SECONDS
        except (TypeError, ValueError):
            delay = _DEFAULT_RETRY_AFTER_SECONDS
        delay = max(delay, 0.0)

        attempt += 1
        log.warning(
            "shopify_inventory rate_limited method=%s url=%s attempt=%d/%d retry_after=%.2fs",
            method,
            url,
            attempt,
            _MAX_RATE_LIMIT_RETRIES,
            delay,
        )
        await asyncio.sleep(delay)


def _admin_api_base() -> Optional[str]:
    settings = get_settings()
    if not settings.shopify_shop_domain:
        return None
    return f"https://{settings.shopify_shop_domain}/admin/api/{settings.shopify_admin_api_version}"


def _auth_headers() -> dict[str, str]:
    settings = get_settings()
    return {
        "X-Shopify-Access-Token": settings.shopify_admin_api_token,
        "Content-Type": "application/json",
    }


@dataclass(slots=True)
class PushResult:
    pushed: bool
    shadow: bool
    inventory_item_id: str
    location_id: str
    available: int
    error: str | None = None


async def push_inventory_level(
    *,
    db: AsyncSession,
    inventory_item_id: str,
    location_id: str,
    available: int,
) -> PushResult:
    """Set Shopify's `available` value for one (inventory_item_id, location)
    pair. No-op in shadow mode.

    The kill switch is read from the DB-backed override (app_config,
    admin-editable at runtime from /admin/integrations) with the
    SHOPIFY_INVENTORY_PUSH_ENABLED env var as the fallback/default when
    no override has ever been saved. Checked here, at push time — not at
    boot — so flipping it takes effect on the very next call.
    """
    settings = get_settings()
    push_enabled = await app_config.get_shopify_push_enabled(db)
    if not push_enabled:
        log.info(
            "shopify_inventory_push SHADOW inv=%s loc=%s available=%d",
            inventory_item_id,
            location_id,
            available,
        )
        return PushResult(
            pushed=False,
            shadow=True,
            inventory_item_id=inventory_item_id,
            location_id=location_id,
            available=available,
        )

    base = _admin_api_base()
    if base is None or not settings.shopify_admin_api_token:
        return PushResult(
            pushed=False,
            shadow=False,
            inventory_item_id=inventory_item_id,
            location_id=location_id,
            available=available,
            error="shopify_shop_domain / shopify_admin_api_token not configured",
        )

    url = f"{base}/inventory_levels/set.json"
    payload = {
        "inventory_item_id": int(inventory_item_id),
        "location_id": int(location_id),
        "available": int(available),
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(url, json=payload, headers=_auth_headers())
        if r.status_code >= 400:
            log.error(
                "shopify_inventory_push FAIL inv=%s loc=%s status=%d body=%s",
                inventory_item_id,
                location_id,
                r.status_code,
                r.text[:300],
            )
            return PushResult(
                pushed=False,
                shadow=False,
                inventory_item_id=inventory_item_id,
                location_id=location_id,
                available=available,
                error=f"shopify {r.status_code}: {r.text[:200]}",
            )
        return PushResult(
            pushed=True,
            shadow=False,
            inventory_item_id=inventory_item_id,
            location_id=location_id,
            available=available,
        )
    except Exception as e:  # noqa: BLE001 — log and surface to caller
        log.exception("shopify_inventory_push raised")
        return PushResult(
            pushed=False,
            shadow=False,
            inventory_item_id=inventory_item_id,
            location_id=location_id,
            available=available,
            error=str(e),
        )


async def maybe_push_for_item(
    db: AsyncSession,
    *,
    item_id,
    location_id,
) -> Optional[PushResult]:
    """Push the current ops on-hand to Shopify for one (item, location).

    Skips silently when:
      - The item has no mapped Shopify inventory_item_id.
      - The location has no mapped Shopify location_id.
    Returns None for those skips so the caller can ignore them cheaply.
    """
    from app.models.inventory import MasterItemVariant  # local import to avoid cycle

    variant_stmt = (
        select(MasterItemVariant)
        .where(MasterItemVariant.master_item_id == item_id)
        .where(MasterItemVariant.shopify_inventory_item_id.is_not(None))
    )
    variant = (await db.execute(variant_stmt)).scalars().first()
    if variant is None or not variant.shopify_inventory_item_id:
        return None

    loc = await db.get(Location, location_id)
    if loc is None or not loc.shopify_location_id:
        return None

    on_hand = await _ops_on_hand(db, item_id, location_id)
    return await push_inventory_level(
        db=db,
        inventory_item_id=variant.shopify_inventory_item_id,
        location_id=loc.shopify_location_id,
        available=on_hand,
    )


async def _ops_on_hand(db: AsyncSession, item_id, location_id) -> int:
    stmt = select(func.coalesce(func.sum(InventoryTransaction.quantity), 0)).where(
        InventoryTransaction.item_id == item_id,
        InventoryTransaction.location_id == location_id,
    )
    return int((await db.execute(stmt)).scalar_one() or 0)


async def apply_webhook_delta(payload: dict, db: AsyncSession, webhook_id: str | None = None) -> dict:
    """Live handler for `inventory_levels/update` webhooks.

    Wavecrest US: applies an ADJUSTMENT ledger entry for the delta between
    Shopify's `available` and ops on-hand — see module docstring for why
    this is safe there (no other live decrement path). Toronto: logs the
    delta and refreshes the stock cache only — see module docstring for
    why writing a ledger entry there would double-decrement.

    Serialized via pg_advisory_xact_lock keyed on (item_id, location) —
    same pattern as inventory_ledger.set_absolute_quantity() — so two
    concurrent deliveries for the same item/location (a fast double
    stock-change, a retry racing the original, or Shopify ever being
    configured with two subscriptions hitting both webhook URLs) read
    ops on-hand AFTER each other rather than off the same stale snapshot.

    `webhook_id` (Shopify's X-Shopify-Webhook-Id) is required for the
    ledger write specifically — Shopify always sends it in practice, so
    when it's missing (a malformed/manual request) this degrades to a
    safe no-op rather than fabricating a weak, always-unique fallback
    correlation_id that would let duplicate deliveries double-apply.

    `shopify_inventory_item_id` has no DB uniqueness guarantee (mirrors
    `shopify_variant_id`, whose unique constraint was deliberately
    dropped — see migration 0016 — because source data legitimately
    contains duplicates), so this queries and handles every matching
    variant rather than assuming exactly one, like the poll functions do.
    """
    import hashlib
    from sqlalchemy import text

    inv_id = payload.get("inventory_item_id")
    sh_loc_id = payload.get("location_id")
    shopify_available = payload.get("available")

    if inv_id is None or sh_loc_id is None or shopify_available is None:
        return {"ok": False, "reason": "missing fields"}

    inv_id_str = str(inv_id)
    sh_loc_str = str(sh_loc_id)
    shopify_available = int(shopify_available)

    from app.models.inventory import MasterItemVariant

    variant_stmt = select(MasterItemVariant).where(
        MasterItemVariant.shopify_inventory_item_id == inv_id_str
    )
    variants = list((await db.execute(variant_stmt)).scalars().all())

    loc_stmt = select(Location).where(Location.shopify_location_id == sh_loc_str)
    loc = (await db.execute(loc_stmt)).scalar_one_or_none()
    if loc is None:
        return {
            "ok": False,
            "reason": f"no ops location for shopify_location_id={sh_loc_str}",
        }

    # Refresh the cached stock number on every mapped variant regardless of
    # ledger eligibility — mirrors sync_wavecrest_us_from_shopify's "every
    # mapped variant, linked or not" convention.
    for variant in variants:
        if loc.code == "toronto":
            variant.stock_available_toronto = shopify_available
        elif loc.code == "wavecrest_us":
            variant.stock_available_wavecrest = shopify_available
        db.add(variant)

    # Distinct PRODUCT-type master items linked among the matching variants.
    # Normally exactly one; if more than one this inventory_item_id is
    # ambiguously mapped (a data problem, not something to guess through) —
    # skip the ledger write rather than pick one arbitrarily.
    linked_item_ids = {v.master_item_id for v in variants if v.master_item_id is not None}
    if not linked_item_ids:
        return {"ok": True, "action": "cache-refresh-only", "reason": "no master item linked"}
    if len(linked_item_ids) > 1:
        log.warning(
            "shopify_inventory_webhook: inv=%s maps to %d distinct master items — skipping ledger write",
            inv_id_str, len(linked_item_ids),
        )
        return {"ok": True, "action": "cache-refresh-only", "reason": "ambiguous item mapping"}
    item_id = next(iter(linked_item_ids))

    item = await db.get(MasterItem, item_id)
    ledger_eligible = item is not None and item.item_type == ItemType.PRODUCT

    if loc.code != "wavecrest_us":
        # Toronto (or any other non-Wavecrest location): log-only, per the
        # double-decrement risk explained in the module docstring. No lock
        # needed — this path never writes.
        current_ops = await _ops_on_hand(db, item_id, loc.id)
        delta = shopify_available - current_ops
        if delta != 0:
            log.warning(
                "shopify_inventory_drift inv=%s loc=%s shopify_available=%d ops_on_hand=%d delta=%d"
                " (log-only location — see module docstring)",
                inv_id_str, loc.code, shopify_available, current_ops, delta,
            )
        return {
            "ok": True,
            "action": "logged" if delta != 0 else "no-op",
            "delta": delta,
            "ops_was": current_ops,
            "shopify_now": shopify_available,
            "item_id": str(item_id),
            "location_code": loc.code,
        }

    if not ledger_eligible:
        return {"ok": True, "action": "no-op", "item_id": str(item_id), "location_code": loc.code}

    if not webhook_id:
        log.warning(
            "shopify_inventory_webhook: inv=%s loc=%s missing X-Shopify-Webhook-Id — skipping ledger write",
            inv_id_str, loc.code,
        )
        return {"ok": True, "action": "no-op", "reason": "missing webhook_id", "item_id": str(item_id)}

    # Serialize concurrent deliveries for this (item, location) so the
    # read-then-write below can't race against another delivery's.
    lock_seed = f"{item_id}:{loc.id}".encode()
    lock_key = int.from_bytes(hashlib.md5(lock_seed).digest()[:8], "big", signed=True)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    current_ops = await _ops_on_hand(db, item_id, loc.id)
    delta = shopify_available - current_ops

    if delta == 0:
        return {
            "ok": True,
            "action": "no-op",
            "delta": 0,
            "item_id": str(item_id),
            "location_code": loc.code,
        }

    now = datetime.now(timezone.utc)
    correlation_id = f"shopify_webhook:{webhook_id}"
    await inventory_ledger.record(
        db,
        item_id=item_id,
        location_id=loc.id,
        quantity=delta,
        transaction_type=TransactionType.ADJUSTMENT,
        origin="shopify_webhook",
        correlation_id=correlation_id,
        note=f"US stock live-sync from Shopify webhook: {current_ops} → {shopify_available}",
        occurred_at=now,
        legacy_location=loc.code,
    )
    log.info(
        "shopify_inventory_webhook applied delta=%d inv=%s loc=%s (ops=%d shopify=%d)",
        delta, inv_id_str, loc.code, current_ops, shopify_available,
    )
    return {
        "ok": True,
        "action": "adjusted",
        "delta": delta,
        "ops_was": current_ops,
        "shopify_now": shopify_available,
        "item_id": str(item_id),
        "location_code": loc.code,
    }


@dataclass(slots=True)
class DriftRow:
    item_id: str
    sku: str
    name: str
    inventory_item_id: str
    location_code: str
    shopify_location_id: str
    ops_on_hand: int
    shopify_on_hand: int | None
    delta: int | None
    error: str | None = None


async def reconcile_canada_finished(db: AsyncSession) -> list[DriftRow]:
    """For every Canada finished SKU mapped to Shopify, fetch the
    Shopify-side `available` and report drift versus ops on-hand.
    Non-mutating; the operator can decide whether to push, accept, or
    investigate.

    Important: DriftRow.delta = shopify_available - ops_on_hand.
    Shopify `available` excludes committed (reserved) units, so delta
    will equal committed order count even when stock is fully in sync.
    A delta of -N with N open orders is normal, not a real discrepancy.
    """
    settings = get_settings()
    base = _admin_api_base()
    if base is None or not settings.shopify_admin_api_token:
        return []

    from app.models.inventory import MasterItemVariant

    loc_stmt = select(Location).where(Location.code == "toronto")
    toronto = (await db.execute(loc_stmt)).scalar_one_or_none()
    if toronto is None or not toronto.shopify_location_id:
        log.warning("reconcile_canada_finished: toronto location not mapped to a shopify_location_id")
        return []

    # Items + their primary variant. We only care about finished
    # products with a non-null shopify_inventory_item_id.
    stmt = (
        select(MasterItem, MasterItemVariant)
        .join(
            MasterItemVariant,
            MasterItemVariant.master_item_id == MasterItem.id,
        )
        .where(
            MasterItem.item_type == ItemType.PRODUCT,
            MasterItemVariant.shopify_inventory_item_id.is_not(None),
        )
    )
    rows = (await db.execute(stmt)).all()

    out: list[DriftRow] = []
    async with httpx.AsyncClient(timeout=15.0) as client:
        for item, variant in rows:
            inv_id = variant.shopify_inventory_item_id or ""
            ops = await _ops_on_hand(db, item.id, toronto.id)
            try:
                r = await _request_with_backoff(
                    client,
                    "GET",
                    f"{base}/inventory_levels.json",
                    params={
                        "inventory_item_ids": inv_id,
                        "location_ids": toronto.shopify_location_id,
                    },
                    headers=_auth_headers(),
                )
                if r.status_code >= 400:
                    out.append(
                        DriftRow(
                            item_id=str(item.id),
                            sku=item.sku,
                            name=item.name,
                            inventory_item_id=inv_id,
                            location_code=toronto.code,
                            shopify_location_id=toronto.shopify_location_id,
                            ops_on_hand=ops,
                            shopify_on_hand=None,
                            delta=None,
                            error=f"shopify {r.status_code}: {r.text[:120]}",
                        )
                    )
                    continue
                levels = r.json().get("inventory_levels") or []
                shopify_qty = levels[0]["available"] if levels else 0
            except Exception as e:  # noqa: BLE001
                out.append(
                    DriftRow(
                        item_id=str(item.id),
                        sku=item.sku,
                        name=item.name,
                        inventory_item_id=inv_id,
                        location_code=toronto.code,
                        shopify_location_id=toronto.shopify_location_id,
                        ops_on_hand=ops,
                        shopify_on_hand=None,
                        delta=None,
                        error=str(e),
                    )
                )
                continue
            finally:
                await _throttle()
            out.append(
                DriftRow(
                    item_id=str(item.id),
                    sku=item.sku,
                    name=item.name,
                    inventory_item_id=inv_id,
                    location_code=toronto.code,
                    shopify_location_id=toronto.shopify_location_id,
                    ops_on_hand=ops,
                    shopify_on_hand=int(shopify_qty),
                    delta=int(shopify_qty) - ops,
                )
            )
    return out


async def push_canada_to_shopify(db: AsyncSession) -> list[DriftRow]:
    """Admin-triggered one-shot push: sets Shopify Toronto inventory to ops
    on-hand for every Canada finished SKU. Bypasses the push_enabled kill
    switch intentionally — this is a manual reconcile, not an automatic write.
    Returns one DriftRow per SKU showing what was pushed.
    """
    settings = get_settings()
    base = _admin_api_base()
    if base is None or not settings.shopify_admin_api_token:
        return []

    from app.models.inventory import MasterItemVariant

    loc_stmt = select(Location).where(Location.code == "toronto")
    toronto = (await db.execute(loc_stmt)).scalar_one_or_none()
    if toronto is None or not toronto.shopify_location_id:
        log.warning("push_canada_to_shopify: toronto location not mapped to shopify_location_id")
        return []

    stmt = (
        select(MasterItem, MasterItemVariant)
        .join(MasterItemVariant, MasterItemVariant.master_item_id == MasterItem.id)
        .where(
            MasterItem.item_type == ItemType.PRODUCT,
            MasterItemVariant.shopify_inventory_item_id.is_not(None),
        )
    )
    rows = (await db.execute(stmt)).all()

    # Deduplicate by inventory_item_id — an item with multiple variants
    # mapped to the same Shopify inventory item should only be pushed once.
    seen_inv_ids: set[str] = set()
    out: list[DriftRow] = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for item, variant in rows:
            inv_id = variant.shopify_inventory_item_id or ""
            if inv_id in seen_inv_ids:
                continue
            seen_inv_ids.add(inv_id)

            ops = await _ops_on_hand(db, item.id, toronto.id)
            url = f"{base}/inventory_levels/set.json"
            payload = {
                "inventory_item_id": int(inv_id),
                "location_id": int(toronto.shopify_location_id),
                "available": ops,
            }
            try:
                r = await _request_with_backoff(client, "POST", url, json=payload, headers=_auth_headers())
                if r.status_code >= 400:
                    out.append(DriftRow(
                        item_id=str(item.id), sku=item.sku, name=item.name,
                        inventory_item_id=inv_id, location_code=toronto.code,
                        shopify_location_id=toronto.shopify_location_id,
                        ops_on_hand=ops, shopify_on_hand=None, delta=None,
                        error=f"shopify {r.status_code}: {r.text[:200]}",
                    ))
                    continue
                log.info("push_canada_to_shopify pushed sku=%s available=%d", item.sku, ops)
                out.append(DriftRow(
                    item_id=str(item.id), sku=item.sku, name=item.name,
                    inventory_item_id=inv_id, location_code=toronto.code,
                    shopify_location_id=toronto.shopify_location_id,
                    ops_on_hand=ops, shopify_on_hand=ops, delta=0,
                ))
            except Exception as e:  # noqa: BLE001
                out.append(DriftRow(
                    item_id=str(item.id), sku=item.sku, name=item.name,
                    inventory_item_id=inv_id, location_code=toronto.code,
                    shopify_location_id=toronto.shopify_location_id,
                    ops_on_hand=ops, shopify_on_hand=None, delta=None,
                    error=str(e),
                ))
            finally:
                await _throttle()
    return out


async def sync_wavecrest_us_from_shopify(db: AsyncSession) -> list[DriftRow]:
    """Pull Shopify inventory levels for the Wavecrest US location.

    Refreshes `MasterItemVariant.stock_available_wavecrest` for EVERY variant
    mapped to Shopify (shopify_inventory_item_id IS NOT NULL), regardless of
    whether it's linked to a master item yet — otherwise an unlinked variant's
    cached stock sits stale/null until someone eventually links it.

    Additionally, and only for variants linked to a PRODUCT-type master item,
    writes an ADJUSTMENT ledger entry so ops on-hand matches Shopify's
    `available` (unchanged from before) — a ledger row inherently needs a
    master item id to attach to, so unlinked variants only get the stock-cache
    refresh, never a ledger write.

    Pure PULL — never pushes to Shopify. Safe to run repeatedly; each call
    applies the delta needed to bring ops in sync with the current Shopify value.
    """
    settings = get_settings()
    base = _admin_api_base()
    if base is None or not settings.shopify_admin_api_token:
        log.warning("sync_wavecrest_us: shopify not configured — skipping")
        return []

    from app.models.inventory import MasterItemVariant

    loc_stmt = select(Location).where(Location.code == "wavecrest_us")
    wavecrest = (await db.execute(loc_stmt)).scalar_one_or_none()
    if wavecrest is None or not wavecrest.shopify_location_id:
        log.warning("sync_wavecrest_us: wavecrest_us location not found or missing shopify_location_id")
        return []

    # Every Shopify-mapped variant, linked or not — the stock cache refresh
    # below applies to all of them. Only the linked-PRODUCT subset (resolved
    # via items_by_id) additionally gets a ledger write.
    variant_stmt = select(MasterItemVariant).where(
        MasterItemVariant.shopify_inventory_item_id.is_not(None)
    )
    variants = (await db.execute(variant_stmt)).scalars().all()

    master_item_ids = {v.master_item_id for v in variants if v.master_item_id is not None}
    items_by_id: dict = {}
    if master_item_ids:
        items_stmt = select(MasterItem).where(MasterItem.id.in_(master_item_ids))
        items_by_id = {mi.id: mi for mi in (await db.execute(items_stmt)).scalars().all()}

    out: list[DriftRow] = []
    now = datetime.now(timezone.utc)
    ts = int(now.timestamp())

    async with httpx.AsyncClient(timeout=15.0) as client:
        for variant in variants:
            inv_id = variant.shopify_inventory_item_id or ""
            item = items_by_id.get(variant.master_item_id) if variant.master_item_id else None
            ledger_eligible = item is not None and item.item_type == ItemType.PRODUCT

            row_item_id = str(item.id) if item is not None else ""
            row_sku = item.sku if item is not None else (variant.sku or "")
            row_name = item.name if item is not None else (variant.variant_name or variant.sku or "")

            ops = await _ops_on_hand(db, item.id, wavecrest.id) if ledger_eligible else 0
            try:
                r = await _request_with_backoff(
                    client,
                    "GET",
                    f"{base}/inventory_levels.json",
                    params={
                        "inventory_item_ids": inv_id,
                        "location_ids": wavecrest.shopify_location_id,
                    },
                    headers=_auth_headers(),
                )
                if r.status_code >= 400:
                    out.append(
                        DriftRow(
                            item_id=row_item_id,
                            sku=row_sku,
                            name=row_name,
                            inventory_item_id=inv_id,
                            location_code=wavecrest.code,
                            shopify_location_id=wavecrest.shopify_location_id,
                            ops_on_hand=ops,
                            shopify_on_hand=None,
                            delta=None,
                            error=f"shopify {r.status_code}: {r.text[:120]}",
                        )
                    )
                    continue
                levels = r.json().get("inventory_levels") or []
                shopify_qty = int(levels[0]["available"]) if levels else 0
            except Exception as e:  # noqa: BLE001
                out.append(
                    DriftRow(
                        item_id=row_item_id,
                        sku=row_sku,
                        name=row_name,
                        inventory_item_id=inv_id,
                        location_code=wavecrest.code,
                        shopify_location_id=wavecrest.shopify_location_id,
                        ops_on_hand=ops,
                        shopify_on_hand=None,
                        delta=None,
                        error=str(e),
                    )
                )
                continue
            finally:
                await _throttle()

            # Refresh the cached stock number for every mapped variant,
            # linked or not — this is a plain field update, not a ledger write.
            variant.stock_available_wavecrest = shopify_qty

            delta: int | None = None
            if ledger_eligible:
                delta = shopify_qty - ops
                if delta != 0:
                    await inventory_ledger.record(
                        db,
                        item_id=item.id,
                        location_id=wavecrest.id,
                        quantity=delta,
                        transaction_type=TransactionType.ADJUSTMENT,
                        origin="shopify_us_sync",
                        correlation_id=f"shopify_us_sync:{inv_id}:{ts}",
                        note=f"US stock sync from Shopify: {ops} → {shopify_qty}",
                        occurred_at=now,
                        legacy_location=wavecrest.code,
                    )
                    log.info(
                        "sync_wavecrest_us applied delta=%d for sku=%s (ops=%d shopify=%d)",
                        delta, row_sku, ops, shopify_qty,
                    )

            out.append(
                DriftRow(
                    item_id=row_item_id,
                    sku=row_sku,
                    name=row_name,
                    inventory_item_id=inv_id,
                    location_code=wavecrest.code,
                    shopify_location_id=wavecrest.shopify_location_id,
                    ops_on_hand=shopify_qty if ledger_eligible else ops,
                    shopify_on_hand=shopify_qty,
                    delta=delta,
                )
            )
    return out


async def sync_canada_from_shopify(db: AsyncSession) -> list[DriftRow]:
    """Pull Shopify inventory levels for the Toronto location.

    Mirrors sync_wavecrest_us_from_shopify: refreshes
    MasterItemVariant.stock_available_toronto for every variant mapped to
    Shopify, and writes an ADJUSTMENT ledger entry (for variants linked to
    a PRODUCT-type master item) so ops on-hand matches Shopify's
    `available`.

    Same caveat as reconcile_canada_finished: Shopify `available` excludes
    committed (reserved) units, so this is deliberately a manual, on-demand
    "make ops match Shopify's number right now" action, not an always-on
    sync — calling it while there are open unfulfilled Toronto orders will
    apply a delta equal to those orders' reserved quantity.

    Pure PULL — never pushes to Shopify. Safe to run repeatedly; each call
    applies the delta needed to bring ops in sync with the current Shopify value.
    """
    settings = get_settings()
    base = _admin_api_base()
    if base is None or not settings.shopify_admin_api_token:
        log.warning("sync_canada: shopify not configured — skipping")
        return []

    from app.models.inventory import MasterItemVariant

    loc_stmt = select(Location).where(Location.code == "toronto")
    toronto = (await db.execute(loc_stmt)).scalar_one_or_none()
    if toronto is None or not toronto.shopify_location_id:
        log.warning("sync_canada: toronto location not found or missing shopify_location_id")
        return []

    variant_stmt = select(MasterItemVariant).where(
        MasterItemVariant.shopify_inventory_item_id.is_not(None)
    )
    variants = (await db.execute(variant_stmt)).scalars().all()

    master_item_ids = {v.master_item_id for v in variants if v.master_item_id is not None}
    items_by_id: dict = {}
    if master_item_ids:
        items_stmt = select(MasterItem).where(MasterItem.id.in_(master_item_ids))
        items_by_id = {mi.id: mi for mi in (await db.execute(items_stmt)).scalars().all()}

    out: list[DriftRow] = []
    now = datetime.now(timezone.utc)
    ts = int(now.timestamp())

    async with httpx.AsyncClient(timeout=15.0) as client:
        for variant in variants:
            inv_id = variant.shopify_inventory_item_id or ""
            item = items_by_id.get(variant.master_item_id) if variant.master_item_id else None
            ledger_eligible = item is not None and item.item_type == ItemType.PRODUCT

            row_item_id = str(item.id) if item is not None else ""
            row_sku = item.sku if item is not None else (variant.sku or "")
            row_name = item.name if item is not None else (variant.variant_name or variant.sku or "")

            ops = await _ops_on_hand(db, item.id, toronto.id) if ledger_eligible else 0
            try:
                r = await _request_with_backoff(
                    client,
                    "GET",
                    f"{base}/inventory_levels.json",
                    params={
                        "inventory_item_ids": inv_id,
                        "location_ids": toronto.shopify_location_id,
                    },
                    headers=_auth_headers(),
                )
                if r.status_code >= 400:
                    out.append(
                        DriftRow(
                            item_id=row_item_id,
                            sku=row_sku,
                            name=row_name,
                            inventory_item_id=inv_id,
                            location_code=toronto.code,
                            shopify_location_id=toronto.shopify_location_id,
                            ops_on_hand=ops,
                            shopify_on_hand=None,
                            delta=None,
                            error=f"shopify {r.status_code}: {r.text[:120]}",
                        )
                    )
                    continue
                levels = r.json().get("inventory_levels") or []
                shopify_qty = int(levels[0]["available"]) if levels else 0
            except Exception as e:  # noqa: BLE001
                out.append(
                    DriftRow(
                        item_id=row_item_id,
                        sku=row_sku,
                        name=row_name,
                        inventory_item_id=inv_id,
                        location_code=toronto.code,
                        shopify_location_id=toronto.shopify_location_id,
                        ops_on_hand=ops,
                        shopify_on_hand=None,
                        delta=None,
                        error=str(e),
                    )
                )
                continue
            finally:
                await _throttle()

            # Refresh the cached stock number for every mapped variant,
            # linked or not — this is a plain field update, not a ledger write.
            variant.stock_available_toronto = shopify_qty

            delta: int | None = None
            if ledger_eligible:
                delta = shopify_qty - ops
                if delta != 0:
                    await inventory_ledger.record(
                        db,
                        item_id=item.id,
                        location_id=toronto.id,
                        quantity=delta,
                        transaction_type=TransactionType.ADJUSTMENT,
                        origin="shopify_canada_sync",
                        correlation_id=f"shopify_canada_sync:{inv_id}:{ts}",
                        note=f"Canada stock sync from Shopify: {ops} → {shopify_qty}",
                        occurred_at=now,
                        legacy_location=toronto.code,
                    )
                    log.info(
                        "sync_canada applied delta=%d for sku=%s (ops=%d shopify=%d)",
                        delta, row_sku, ops, shopify_qty,
                    )

            out.append(
                DriftRow(
                    item_id=row_item_id,
                    sku=row_sku,
                    name=row_name,
                    inventory_item_id=inv_id,
                    location_code=toronto.code,
                    shopify_location_id=toronto.shopify_location_id,
                    ops_on_hand=shopify_qty if ledger_eligible else ops,
                    shopify_on_hand=shopify_qty,
                    delta=delta,
                )
            )
    return out


async def apply_fulfillment(payload: dict, db: AsyncSession) -> dict:
    """Handle one fulfillments/create webhook body.

    Creates a SALE ledger entry for each line item fulfilled from Toronto.
    Ignores Wavecrest US and any other non-Toronto location.
    Idempotent: correlation_id blocks duplicate entries on webhook retry.
    """
    from app.models.inventory import MasterItemVariant

    sh_loc_id = str(payload.get("location_id", ""))
    fulfillment_id = payload.get("id")
    order_id = payload.get("order_id")
    line_items = payload.get("line_items") or []

    if not sh_loc_id or fulfillment_id is None:
        return {"ok": False, "reason": "missing location_id or fulfillment id"}

    # Resolve to an ops location — only Toronto is managed by ops.
    loc_stmt = select(Location).where(Location.shopify_location_id == sh_loc_id)
    loc = (await db.execute(loc_stmt)).scalar_one_or_none()
    if loc is None:
        return {"ok": True, "skipped": f"no ops location for shopify_location_id={sh_loc_id}"}
    if loc.code != "toronto":
        return {"ok": True, "skipped": f"non-toronto location {loc.code!r} — managed by 3PL"}

    recorded = 0
    skipped: list[str] = []

    for li in line_items:
        sku = li.get("sku") or ""
        qty = int(li.get("quantity") or 0)
        line_id = li.get("id")

        if not sku or qty <= 0:
            skipped.append(f"line {line_id}: missing sku or zero qty")
            continue

        variant_stmt = select(MasterItemVariant).where(MasterItemVariant.sku == sku)
        variant = (await db.execute(variant_stmt)).scalar_one_or_none()
        if variant is None:
            log.warning("apply_fulfillment: no variant for sku=%s (order=%s)", sku, order_id)
            skipped.append(f"sku={sku}: no matching variant")
            continue
        if variant.master_item_id is None:
            log.warning("apply_fulfillment: variant sku=%s has no master_item_id", sku)
            skipped.append(f"sku={sku}: variant not linked to master item")
            continue

        correlation = f"shopify_fulfillment:{fulfillment_id}:line:{line_id}"
        await inventory_ledger.record(
            db,
            item_id=variant.master_item_id,
            location_id=loc.id,
            quantity=-qty,
            transaction_type=TransactionType.SALE,
            origin="shopify_order",
            correlation_id=correlation,
            reference_table="shopify_fulfillments",
            reference_id=None,
            note=f"Shopify order {order_id} fulfilled",
            occurred_at=datetime.now(timezone.utc),
            legacy_location=loc.code,
        )
        recorded += 1

    return {
        "ok": True,
        "fulfillment_id": fulfillment_id,
        "order_id": order_id,
        "location": loc.code,
        "recorded": recorded,
        "skipped": skipped,
    }
