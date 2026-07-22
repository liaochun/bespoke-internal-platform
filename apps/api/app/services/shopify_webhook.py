# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Shopify webhook helpers — HMAC verification.

Fulfillment processing lives in shopify_inventory.apply_fulfillment(); both
/webhooks/shopify and /webhooks/shopify/fulfillments-create call it so
behavior is identical no matter which URL is registered in Shopify. An
earlier, divergent handler used to live here — it never set location_id on
the transactions it wrote, so on-hand reads (which filter on location_id)
silently never saw those sales, and it had no idempotency/correlation_id
guard and no Toronto-only guard against double-counting Wavecrest US stock.
"""
from __future__ import annotations

import base64
import hashlib
import hmac


def verify_hmac(secret: str, body: bytes, signature_b64: str) -> bool:
    """Constant-time HMAC-SHA256 verify of a Shopify webhook body.

    Shopify sends `X-Shopify-Hmac-Sha256: <base64-of-hmac-sha256(body, secret)>`.
    """
    if not secret or not signature_b64:
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(expected, signature_b64)
