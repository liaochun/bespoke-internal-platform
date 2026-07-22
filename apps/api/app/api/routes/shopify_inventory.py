# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Shopify 2-way inventory sync — webhook in + reconciler endpoint.

POST /webhooks/shopify/inventory-levels-update
  Body: standard Shopify `inventory_levels/update` payload.
  Header: X-Shopify-Hmac-Sha256 (verified).
  Action: writes an ADJUSTMENT ledger entry when our on-hand
  disagrees with Shopify's `available`.

GET /shopify/inventory/drift
  Runs the reconciler against Canada finished SKUs and returns the
  drift table. Read-only, manage_inventory cap.
"""
from __future__ import annotations

import json
import logging
import secrets

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin, require_capability, require_super_admin
from app.core.config import get_settings
from app.db.session import get_db
from app.models.app_config import AppConfig
from app.models.user import User
from app.services import app_config, shopify_inventory, shopify_variant_sync
from app.services.event_log import record_event
from app.services.shopify_webhook import verify_hmac

log = logging.getLogger("northbound.shopify_inventory_routes")

router = APIRouter(tags=["shopify-inventory"])
settings = get_settings()


@router.post("/webhooks/shopify/inventory-levels-update")
async def inventory_levels_update(
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_shopify_hmac_sha256: str | None = Header(default=None),
    x_shopify_webhook_id: str | None = Header(default=None),
) -> dict:
    body = await request.body()
    if not verify_hmac(settings.shopify_webhook_secret, body, x_shopify_hmac_sha256 or ""):
        raise HTTPException(401, "invalid HMAC signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid JSON")

    result = await shopify_inventory.apply_webhook_delta(payload, db, webhook_id=x_shopify_webhook_id)
    await db.commit()
    return result


class DriftRowPublic(BaseModel):
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


class ShopifyInventoryStatus(BaseModel):
    push_enabled: bool
    shop_configured: bool
    shop_domain: str
    us_sync_enabled: bool
    us_sync_interval_minutes: int


@router.get("/shopify/inventory/status", response_model=ShopifyInventoryStatus)
async def status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_capability("manage_inventory")),
) -> ShopifyInventoryStatus:
    return ShopifyInventoryStatus(
        push_enabled=await app_config.get_shopify_push_enabled(db),
        shop_configured=bool(settings.shopify_shop_domain and settings.shopify_admin_api_token),
        shop_domain=settings.shopify_shop_domain or "",
        us_sync_enabled=settings.shopify_us_sync_enabled,
        us_sync_interval_minutes=settings.shopify_us_sync_interval_minutes,
    )


class ShopifyPushToggle(BaseModel):
    enabled: bool


@router.patch("/shopify/inventory/push-enabled", response_model=ShopifyPushToggle)
async def set_push_enabled(
    body: ShopifyPushToggle,
    actor: User = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> ShopifyPushToggle:
    """Flip the Shopify inventory push kill switch. Super-admin only: turning
    this on makes maybe_push_for_item() write real inventory levels to
    Shopify for every ops-originated transaction (production output,
    transfers, manual adjustments). Takes effect on the very next push —
    no restart or redeploy. SHOPIFY_INVENTORY_PUSH_ENABLED in Render
    remains the fallback default whenever this DB override is never set."""
    await app_config.set_shopify_push_enabled(db, body.enabled)
    await record_event(
        db,
        category="inventory",
        event_type="shopify_inventory_push_toggled",
        actor=actor.email,
        entity_table=None,
        entity_id=None,
        payload={"enabled": body.enabled},
    )
    await db.commit()
    return ShopifyPushToggle(enabled=await app_config.get_shopify_push_enabled(db))


class VariantSyncResultPublic(BaseModel):
    upserted: int
    linked: int
    already_linked: int
    auto_created: int = 0
    unresolved: list[str]
    error: str | None = None


@router.post("/admin/shopify/sync-variants", response_model=VariantSyncResultPublic)
async def sync_variants(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> VariantSyncResultPublic:
    """Pull all Shopify products/variants and upsert into master_item_variants.
    Auto-links master_item_id by SKU where unambiguous. Auto-creates stub
    master items for real SKUs with no existing match. Safe to re-run."""
    result = await shopify_variant_sync.sync_variants_from_shopify(db)
    await db.commit()
    return VariantSyncResultPublic(
        upserted=result.upserted,
        linked=result.linked,
        already_linked=result.already_linked,
        auto_created=result.auto_created,
        unresolved=result.unresolved,
        error=result.error,
    )


@router.post("/webhooks/shopify/products-create")
async def products_create(
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_shopify_hmac_sha256: str | None = Header(default=None),
) -> dict:
    """Shopify products/create webhook — auto-creates master items for new SKUs."""
    body = await request.body()
    if not verify_hmac(settings.shopify_webhook_secret, body, x_shopify_hmac_sha256 or ""):
        raise HTTPException(401, "invalid HMAC signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid JSON")

    result = await shopify_variant_sync.sync_product_from_webhook(payload, db)
    await db.commit()
    return result


@router.post("/webhooks/shopify/fulfillments-create")
async def fulfillments_create(
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_shopify_hmac_sha256: str | None = Header(default=None),
) -> dict:
    body = await request.body()
    if not verify_hmac(settings.shopify_webhook_secret, body, x_shopify_hmac_sha256 or ""):
        raise HTTPException(401, "invalid HMAC signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid JSON")
    result = await shopify_inventory.apply_fulfillment(payload, db)
    await db.commit()
    return result


@router.get("/shopify/inventory/drift", response_model=list[DriftRowPublic])
async def drift(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_capability("manage_inventory")),
):
    rows = await shopify_inventory.reconcile_canada_finished(db)
    return [
        DriftRowPublic(
            item_id=r.item_id,
            sku=r.sku,
            name=r.name,
            inventory_item_id=r.inventory_item_id,
            location_code=r.location_code,
            shopify_location_id=r.shopify_location_id,
            ops_on_hand=r.ops_on_hand,
            shopify_on_hand=r.shopify_on_hand,
            delta=r.delta,
            error=r.error,
        )
        for r in rows
    ]


@router.post("/shopify/inventory/push-all", response_model=list[DriftRowPublic])
async def push_all(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Admin-only one-shot: push all ops Toronto inventory values to Shopify.
    Bypasses the push_enabled kill switch — this is a manual reconcile trigger.
    """
    rows = await shopify_inventory.push_canada_to_shopify(db)
    pushed = sum(1 for r in rows if r.error is None)
    failed = sum(1 for r in rows if r.error is not None)
    log.info("push_all_canada completed pushed=%d failed=%d", pushed, failed)
    return [
        DriftRowPublic(
            item_id=r.item_id, sku=r.sku, name=r.name,
            inventory_item_id=r.inventory_item_id, location_code=r.location_code,
            shopify_location_id=r.shopify_location_id, ops_on_hand=r.ops_on_hand,
            shopify_on_hand=r.shopify_on_hand, delta=r.delta, error=r.error,
        )
        for r in rows
    ]


@router.post("/shopify/inventory/sync-us", response_model=list[DriftRowPublic])
async def sync_us(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_capability("manage_inventory")),
):
    """Pull Shopify Wavecrest US inventory levels and write ADJUSTMENT ledger
    entries to bring ops on-hand in sync. Pure pull — never pushes to Shopify.
    Returns one row per SKU showing the applied delta."""
    rows = await shopify_inventory.sync_wavecrest_us_from_shopify(db)
    await db.commit()
    return [
        DriftRowPublic(
            item_id=r.item_id,
            sku=r.sku,
            name=r.name,
            inventory_item_id=r.inventory_item_id,
            location_code=r.location_code,
            shopify_location_id=r.shopify_location_id,
            ops_on_hand=r.ops_on_hand,
            shopify_on_hand=r.shopify_on_hand,
            delta=r.delta,
            error=r.error,
        )
        for r in rows
    ]


@router.post("/shopify/inventory/sync-canada", response_model=list[DriftRowPublic])
async def sync_canada(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_capability("manage_inventory")),
):
    """Pull Shopify Toronto inventory levels and write ADJUSTMENT ledger
    entries to bring ops on-hand in sync. Pure pull — never pushes to Shopify.
    Returns one row per SKU showing the applied delta."""
    rows = await shopify_inventory.sync_canada_from_shopify(db)
    await db.commit()
    return [
        DriftRowPublic(
            item_id=r.item_id,
            sku=r.sku,
            name=r.name,
            inventory_item_id=r.inventory_item_id,
            location_code=r.location_code,
            shopify_location_id=r.shopify_location_id,
            ops_on_hand=r.ops_on_hand,
            shopify_on_hand=r.shopify_on_hand,
            delta=r.delta,
            error=r.error,
        )
        for r in rows
    ]


@router.post("/shopify/inventory/sync-all", response_model=list[DriftRowPublic])
async def sync_shopify_all(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_capability("manage_inventory")),
):
    """One-click "Sync Shopify" action: pulls both Toronto (Canada) and
    Wavecrest (US) inventory levels from Shopify and writes ADJUSTMENT
    ledger entries to bring ops on-hand in sync with Shopify for both
    regions in a single call. Pure pull — never pushes to Shopify.

    This is the Shopify-sourced counterpart to the existing Airtable
    "Sync now"/hard-reset actions — an operator can choose which system
    (Airtable or Shopify) is the source of truth for a given sync.
    """
    canada_rows = await shopify_inventory.sync_canada_from_shopify(db)
    us_rows = await shopify_inventory.sync_wavecrest_us_from_shopify(db)
    await db.commit()
    return [
        DriftRowPublic(
            item_id=r.item_id,
            sku=r.sku,
            name=r.name,
            inventory_item_id=r.inventory_item_id,
            location_code=r.location_code,
            shopify_location_id=r.shopify_location_id,
            ops_on_hand=r.ops_on_hand,
            shopify_on_hand=r.shopify_on_hand,
            delta=r.delta,
            error=r.error,
        )
        for r in (canada_rows + us_rows)
    ]


# ---------------------------------------------------------------------------
# Shopify OAuth — captures a permanent shpat_ access token
# ---------------------------------------------------------------------------

_OAUTH_SCOPES = (
    "read_products,read_inventory,write_inventory,"
    "read_locations,read_orders,read_fulfillments"
)


@router.get("/shopify/oauth/start")
async def oauth_start(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
) -> RedirectResponse:
    """Redirect to Shopify OAuth consent page. Super-admin only."""
    if not settings.shopify_client_id:
        raise HTTPException(400, "SHOPIFY_CLIENT_ID not configured in environment")
    if not settings.shopify_shop_domain:
        raise HTTPException(400, "SHOPIFY_SHOP_DOMAIN not configured in environment")

    state = secrets.token_hex(16)
    await db.merge(AppConfig(key="shopify_oauth_nonce", value={"nonce": state}))
    await db.commit()

    redirect_uri = f"{settings.api_origin_url}/shopify/oauth/callback"

    auth_url = (
        f"https://{settings.shopify_shop_domain}/admin/oauth/authorize"
        f"?client_id={settings.shopify_client_id}"
        f"&scope={_OAUTH_SCOPES}"
        f"&redirect_uri={redirect_uri}"
        f"&state={state}"
    )
    return RedirectResponse(auth_url, status_code=302)


@router.get("/shopify/oauth/callback")
async def oauth_callback(
    code: str,
    state: str,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Shopify redirects here with ?code=&state=. Exchanges code for access token
    and stores it in app_config. Returns an HTML page showing the token for
    the admin to copy into Render as SHOPIFY_ADMIN_API_TOKEN."""
    nonce_row = await db.get(AppConfig, "shopify_oauth_nonce")
    if nonce_row is None or nonce_row.value.get("nonce") != state:
        raise HTTPException(400, "Invalid or expired state parameter — restart OAuth flow")

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"https://{settings.shopify_shop_domain}/admin/oauth/access_token",
            json={
                "client_id": settings.shopify_client_id,
                "client_secret": settings.shopify_client_secret,
                "code": code,
            },
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"Shopify token exchange failed: {resp.text}")

    token_data = resp.json()
    access_token: str = token_data.get("access_token", "")
    if not access_token:
        raise HTTPException(502, "No access_token in Shopify response")

    # Deliberately NOT persisted to app_config: every consumer of the token
    # (_auth_headers() and friends) reads only get_settings().shopify_admin_api_token,
    # which is sourced from the environment. A DB-stored copy was never read
    # back by any code path, so it was just a second, unencrypted, forgotten
    # copy of a live production secret sitting in the database.
    await db.delete(nonce_row)
    await db.commit()

    granted_scopes = token_data.get("scope", "")
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html>
<head><title>Shopify Connected</title>
<style>
  body {{ font-family: system-ui, sans-serif; padding: 2rem; max-width: 640px; }}
  code {{ background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }}
  textarea {{ width: 100%; font-family: monospace; font-size: 0.85em; padding: 8px;
              border: 1px solid #ccc; border-radius: 6px; resize: vertical; }}
  .badge {{ background: #16a34a; color: white; padding: 4px 10px; border-radius: 20px;
            font-size: 0.85em; }}
</style>
</head>
<body>
  <h2><span class="badge">Connected</span> Shopify OAuth complete</h2>
  <p>Copy this token and paste it into Render as <code>SHOPIFY_ADMIN_API_TOKEN</code>, then redeploy:</p>
  <textarea rows="3" onclick="this.select()" readonly>{access_token}</textarea>
  <p style="color:#555;font-size:0.9em">Granted scopes: <code>{granted_scopes}</code></p>
  <p style="color:#555;font-size:0.9em">
    This token is <strong>not</strong> saved anywhere automatically — you must
    paste it into Render as <code>SHOPIFY_ADMIN_API_TOKEN</code> and redeploy
    before the API will use it.
  </p>
  <hr>
  <p style="font-size:0.85em;color:#999">
    Next: run <code>POST /admin/shopify/sync-variants</code> to map SKUs,
    then check <code>GET /shopify/inventory/drift</code> before enabling writes.
  </p>
</body>
</html>""",
        status_code=200,
    )
