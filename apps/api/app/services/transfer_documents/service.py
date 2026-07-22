# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Wiring layer for cross-border transfer documentation.

Assembles the per-shipment ``TransferDocument.data`` dicts from
``InventoryTransfer`` / ``MasterItem`` / ``MasterItemCustomsProfile`` /
``Location`` rows (:func:`build_drafts`), renders a document's current
``data`` to HTML via the matching renderer module and then to PDF bytes via
WeasyPrint (:func:`render_pdf`), and finalizes a document by rendering +
uploading it to the configured storage backend (:func:`finalize`).

Does not touch ``app/services/transfers.py`` -- this module only *reads*
``InventoryTransfer`` rows, it never mutates transfer state.
"""
from __future__ import annotations

import asyncio
import io
import logging
import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, BinaryIO
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import (
    InventoryTransfer,
    Location,
    MasterItem,
    TransferDocument,
    TransferDocumentStatus,
    TransferDocumentType,
)
from app.services.storage import get_storage
from app.services.transfer_documents import (
    commercial_invoice,
    fda_product_worksheet,
    packing_list,
    pallet_labels,
    paps_form,
    port_of_entry_form,
    usmca_certificate,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Fixed business constants (see SHARED_CONTEXT "FIXED BUSINESS CONSTANTS").
# These are seed defaults used when assembling drafts -- every value lands in
# an editable TransferDocument.data field, so ops can correct/override any of
# it before finalizing.
# ---------------------------------------------------------------------------

BROKER: dict[str, Any] = {
    "name": "Placeholder Customs Brokers Inc.",
    "address_line1": "123 Example Street, Suite 100",
    "city": "Springfield",
    "region": "ON",
    "postal_code": "A1A 1A1",
    "country": "Canada",
    "phone": "+1 (555) 010-0100",
    "email": "brokers@northboundops.example",
    "fda_number": "FDA-0000000-EX",
    "hours": "Monday-Friday 9:00 AM - 5:00 PM",
}

# FDA "shipper of record" (As shown on Customs document/BOL/airway bill) --
# normally the 3PL side, constant across shipments on the Toronto -> Buffalo
# lane. Editable per-document after generation.
DEFAULT_FDA_SHIPPER: dict[str, Any] = {
    "company_name": "Northbound Logistics Inc.",
    "address": None,
    "city": "Buffalo",
    "region": "NY",
    "postal_code": None,
    "country": "USA",
    "food_facility_registration_number": None,
    "duns_number": None,
}

DEFAULT_PRIOR_NOTICE_SUBMITTER: dict[str, Any] = {
    "contact_name": "Northbound Ops Operations",
    "contact_phone": None,
    "contact_email": "ops@northboundops.example",
}

DEFAULT_TERMS_CONTACT = (
    "Questions regarding this shipment? Contact Northbound Ops Operations "
    "at ops@northboundops.example."
)

DEFAULT_DECLARATION_TEXT = (
    "I declare that the goods described above are of the origin stated and "
    "are being exported from Canada to the United States in accordance "
    "with applicable U.S. Customs and Border Protection regulations."
)

# Shipment-level pallet-manifest starting defaults -- ops edits these on the
# draft (Packing List + Pallet Labels) before finalizing.
DEFAULT_PALLETS_COUNT = 1
DEFAULT_PALLET_TARE_KG = 10.0
DEFAULT_BOX_TARE_KG = 1.29
DEFAULT_CARTONS_PER_LINE = 1

KG_TO_LB = 2.20462


# ---------------------------------------------------------------------------
# Small formatting / address helpers
# ---------------------------------------------------------------------------


def _fmt_date(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "strftime"):
        return value.strftime("%m/%d/%Y")
    return str(value)


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _address_block(loc: Location | None) -> dict[str, Any]:
    """Shape used by commercial_invoice.shipper/bill_to and
    packing_list.shipper/consignee."""
    if loc is None:
        return {}
    return {
        "name": loc.name,
        "address_line1": loc.address_line1,
        "city": loc.city,
        "region": loc.region,
        "postal_code": loc.postal_code,
        "country": loc.country,
        "phone": loc.phone,
        "email": loc.email,
        "tax_id": loc.tax_id,
        "duns_number": loc.duns_number,
    }


def _combine_address(
    address_line1: str | None,
    city: str | None,
    region: str | None,
    postal_code: str | None,
    country: str | None,
    *,
    sep: str = ", ",
) -> str | None:
    city_region = ", ".join(p for p in (city, region) if p)
    city_region_postal = f"{city_region} {postal_code}".strip() if postal_code else city_region
    parts = [p for p in (address_line1, city_region_postal, country) if p]
    return sep.join(parts) if parts else None


def _party_from_location(loc: Location | None, *, tax_id: str | None = None) -> dict[str, Any]:
    """Shape used by usmca_certificate.certifier/exporter/importer/producer."""
    if loc is None:
        return {}
    return {
        "name": loc.name,
        "company": loc.name,
        "address": _combine_address(
            loc.address_line1, loc.city, loc.region, loc.postal_code, loc.country, sep="\n"
        ),
        "phone": loc.phone,
        "email": loc.email,
        "tax_id": tax_id if tax_id is not None else loc.tax_id,
    }


# The third tuple element is intentionally the SAME MasterItem object as the
# second -- customs/producer/USMCA/FDA fields now live directly on
# MasterItem (mig 0108, consolidated from the former separate
# master_item_customs_profile table). Kept as a distinct "profile" name/slot
# throughout this module's data-assembly functions below purely to minimize
# their diff; every `profile.xxx` access still resolves correctly since
# MasterItem carries all the same field names.
TransferRow = tuple[InventoryTransfer, MasterItem | None, MasterItem | None]


async def _load_transfer_rows(
    db: AsyncSession, transfer_group_id: UUID
) -> list[TransferRow]:
    result = await db.execute(
        select(InventoryTransfer)
        .where(InventoryTransfer.transfer_group_id == transfer_group_id)
        .order_by(InventoryTransfer.created_at)
    )
    transfers = list(result.scalars())
    if not transfers:
        return []

    item_ids = {t.item_id for t in transfers}
    items_result = await db.execute(select(MasterItem).where(MasterItem.id.in_(item_ids)))
    items_by_id = {item.id: item for item in items_result.scalars()}

    rows: list[TransferRow] = []
    for t in transfers:
        item = items_by_id.get(t.item_id)
        rows.append((t, item, item))
    return rows


# ---------------------------------------------------------------------------
# Per-document data-dict assembly
# ---------------------------------------------------------------------------


def _build_commercial_invoice_data(
    *,
    reference_number: str,
    invoice_date: str | None,
    notes: str | None,
    from_location: Location | None,
    to_location: Location | None,
    rows: list[TransferRow],
) -> dict[str, Any]:
    line_items: list[dict[str, Any]] = []
    subtotal = 0.0
    for t, item, profile in rows:
        qty = _as_float(t.qty)
        # Customs/tariffs assess duties against cost, not retail price
        # (see MasterItemCustomsFields.cost) -- commercial invoice rate
        # must match that, or it reads as unpopulated for any item that
        # only has cost seeded and no price.
        rate = _as_float(item.cost) if item is not None else 0.0
        amount = qty * rate
        subtotal += amount
        line_items.append(
            {
                "name": ((item.invoice_description or item.name) if item else None),
                "sku": item.sku if item else None,
                "hs_code": profile.hs_code if profile else None,
                "country_of_manufacturer": profile.country_of_origin if profile else None,
                "producer_name": profile.producer_name if profile else None,
                "producer_address": (
                    _combine_address(
                        profile.producer_address,
                        profile.producer_city,
                        profile.producer_region,
                        profile.producer_postal_code,
                        profile.producer_country,
                    )
                    if profile
                    else None
                ),
                "producer_phone": profile.producer_phone if profile else None,
                "producer_email": profile.producer_email if profile else None,
                "quantity": qty,
                "rate": rate,
                "amount": round(amount, 2),
            }
        )

    tax = 0.0
    total = subtotal + tax

    return {
        "reference_number": reference_number,
        "invoice_date": invoice_date,
        "shipper": _address_block(from_location),
        "bill_to": _address_block(to_location),
        "notes": notes,
        "line_items": line_items,
        "subtotal": round(subtotal, 2),
        "tax": round(tax, 2),
        "total": round(total, 2),
        "broker": BROKER,
        "terms_contact": DEFAULT_TERMS_CONTACT,
    }


def _build_shipment_summary(
    *,
    rows: list[TransferRow],
    ship_date: str | None,
    receive_date: str | None,
) -> str:
    """One-line computed shipment summary appended to the Commercial
    Invoice notes: SKU count, total unit count, total product weight, ship
    date, and receive date -- so ops doesn't have to hand-tally these from
    the line items table."""
    sku_ids = {item.id for _, item, _ in rows if item is not None}
    total_items = sum(int(t.qty or 0) for t, _, _ in rows)
    total_weight_kg = sum(
        _as_float(t.qty) * _as_float(profile.unit_weight_kg if profile else None) for t, _, profile in rows
    )

    parts = [
        f"{len(sku_ids)} SKU{'s' if len(sku_ids) != 1 else ''}",
        f"{total_items} item{'s' if total_items != 1 else ''}",
        f"{total_weight_kg:.2f} kg total weight",
    ]
    if ship_date:
        parts.append(f"Ship date: {ship_date}")
    if receive_date:
        parts.append(f"Receive date: {receive_date}")
    return " · ".join(parts)


def _build_packing_list_data(
    *,
    reference_number: str,
    ship_date: str | None,
    from_location: Location | None,
    to_location: Location | None,
    rows: list[TransferRow],
) -> dict[str, Any]:
    consignee = _address_block(to_location)
    name = consignee.get("name")
    if name and "c/o" not in name.lower():
        consignee = {**consignee, "name": f"{name} C/O Northbound Logistics Inc."}

    line_items: list[dict[str, Any]] = []
    total_units = 0
    total_cartons = 0
    net_weight_kg = 0.0
    for t, item, profile in rows:
        qty = int(t.qty or 0)
        unit_weight_kg = _as_float(profile.unit_weight_kg) if profile else 0.0
        net_wt = qty * unit_weight_kg
        units_per_box = profile.units_per_box if profile else None
        # Real case-pack size when on file; falls back to the old
        # single-carton-per-line placeholder for items not yet catalogued.
        cartons = math.ceil(qty / units_per_box) if units_per_box else DEFAULT_CARTONS_PER_LINE
        total_units += qty
        total_cartons += cartons
        net_weight_kg += net_wt
        line_items.append(
            {
                "sku": item.sku if item else None,
                "description": item.name if item else None,
                "hs_code": profile.hs_code if profile else None,
                "origin": profile.country_of_origin if profile else None,
                "qty": qty,
                "net_wt_kg": round(net_wt, 3),
                "cartons": cartons,
            }
        )

    pallets_count = DEFAULT_PALLETS_COUNT
    pallet_tare_kg = DEFAULT_PALLET_TARE_KG
    box_tare_kg = DEFAULT_BOX_TARE_KG
    box_tare_total_kg = total_cartons * box_tare_kg
    pallet_tare_total_kg = pallets_count * pallet_tare_kg
    gross_weight_kg = net_weight_kg + box_tare_total_kg + pallet_tare_total_kg
    gross_weight_lb = gross_weight_kg * KG_TO_LB

    return {
        "reference_number": reference_number,
        "ship_date": ship_date,
        "shipper": _address_block(from_location),
        "consignee": consignee,
        "pallets_count": pallets_count,
        "pallet_tare_kg": pallet_tare_kg,
        "box_tare_kg": box_tare_kg,
        "line_items": line_items,
        "totals": {
            "total_units": total_units,
            "total_cartons": total_cartons,
            "net_weight_kg": round(net_weight_kg, 3),
            "box_tare_total_kg": round(box_tare_total_kg, 3),
            "pallet_tare_total_kg": round(pallet_tare_total_kg, 3),
            "gross_weight_kg": round(gross_weight_kg, 3),
            "gross_weight_lb": round(gross_weight_lb, 3),
        },
        "declaration_text": DEFAULT_DECLARATION_TEXT,
        "broker": BROKER,
        "reference_note": f"See Commercial Invoice #{reference_number} for value/pricing detail.",
    }


def _build_pallet_labels_data(
    *,
    reference_number: str,
    pallets_count: int,
    shipment_title: str | None,
    unit_label: str = "pallets",
) -> dict[str, Any]:
    return {
        "reference_number": reference_number,
        "shipment_title": shipment_title or "Transfer Shipment",
        "pallets_count": pallets_count,
        # What's being counted/labeled -- "pallets", "boxes", "cartons", or
        # any custom text the ops UI lets the user type. Editable per
        # shipment since some transfers ship loose cartons, not pallets.
        "unit_label": unit_label,
    }


def _build_usmca_data(
    *,
    from_location: Location | None,
    to_location: Location | None,
    rows: list[TransferRow],
) -> dict[str, Any]:
    certifier = _party_from_location(from_location)
    exporter = certifier
    # Northbound is also the importer of record on this lane (see SHARED_CONTEXT).
    importer = certifier

    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for t, item, profile in rows:
        if profile is not None:
            key = profile.producer_name
            producer_party = {
                "name": profile.producer_name,
                "company": profile.producer_name,
                "address": _combine_address(
                    profile.producer_address,
                    profile.producer_city,
                    profile.producer_region,
                    profile.producer_postal_code,
                    profile.producer_country,
                    sep="\n",
                ),
                "phone": profile.producer_phone,
                "email": profile.producer_email,
                "tax_id": profile.producer_duns_number,
            }
            good = {
                "description": item.name if item else None,
                "hts": profile.hs_code,
                "origin_criterion": profile.usmca_origin_criterion or "B",
                "certification_indicator": profile.usmca_certification_indicator or "D",
                "method_of_qualification": profile.usmca_method_of_qualification or "TV",
                "country_of_origin": profile.country_of_origin or "CA",
            }
        else:
            key = "unknown-producer"
            producer_party = {"name": "Unknown Producer", "company": "Unknown Producer"}
            good = {
                "description": item.name if item else None,
                "hts": None,
                "origin_criterion": "B",
                "certification_indicator": "D",
                "method_of_qualification": "TV",
                "country_of_origin": "CA",
            }

        if key not in groups:
            groups[key] = {"producer": producer_party, "goods": []}
            order.append(key)
        groups[key]["goods"].append(good)

    today = date.today()
    try:
        blanket_to = today.replace(year=today.year + 1)
    except ValueError:
        # Feb 29 on a non-leap target year.
        blanket_to = today.replace(year=today.year + 1, day=28)
    blanket_to = blanket_to - timedelta(days=1)

    return {
        "blanket_period_from": _fmt_date(today),
        "blanket_period_to": _fmt_date(blanket_to),
        "certifier": certifier,
        "exporter": exporter,
        "importer": importer,
        "producer_groups": [groups[k] for k in order] or [{"producer": {}, "goods": []}],
        "signer": {
            "name": None,
            "company": (from_location.name if from_location else None) or "Northbound Logistics Inc.",
            "title": None,
            "date": _fmt_date(today),
            "phone": from_location.phone if from_location else None,
            "email": from_location.email if from_location else None,
        },
    }


def _build_fda_data(*, rows: list[TransferRow]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    fce: dict[str, Any] | None = None
    for t, item, profile in rows:
        if profile is None or not profile.is_food:
            continue
        items.append(
            {
                "duns_number": profile.producer_duns_number,
                "client_part_number": item.sku if item else None,
                "description": item.name if item else None,
                "government_agency_processing_code": profile.fda_processing_code,
                "tariff_number": profile.hs_code,
                "fda_product_code": profile.fda_product_code,
                "customs_country_of_origin": profile.country_of_origin,
                "fda_country_of_production": profile.country_of_production or profile.country_of_origin,
                "product_packing_type": profile.packaging_type,
                "cargo_storage_status": profile.cargo_storage_status,
                "processing": profile.processing_description,
                "product_is_for": profile.product_is_for,
                "manufacturer": {
                    "company_name": profile.producer_name,
                    "address": profile.producer_address,
                    "city": profile.producer_city,
                    "region": profile.producer_region,
                    "postal_code": profile.producer_postal_code,
                    "country": profile.producer_country,
                    "food_facility_registration_number": profile.producer_food_facility_registration_number,
                    "duns_number": profile.producer_duns_number,
                },
            }
        )
        if fce is None and (profile.fce_registration_number or profile.sid_schedule_identifier_number):
            fce = {
                "fce_registration_number": profile.fce_registration_number,
                "sid_schedule_identifier_number": profile.sid_schedule_identifier_number,
            }

    return {
        "account_number": None,
        "account_name": "Northbound Logistics Inc.",
        "items": items,
        "shipper": DEFAULT_FDA_SHIPPER,
        "prior_notice_submitter": DEFAULT_PRIOR_NOTICE_SUBMITTER,
        "fce": fce,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def build_drafts(db: AsyncSession, transfer_group_id: UUID) -> list[TransferDocument]:
    """Assemble/upsert the draft TransferDocument rows for a shipment.

    Creates one row per TransferDocumentType (all 5, unconditionally --
    FDA_PRODUCT_WORKSHEET included regardless of is_food, since it's a
    reference document ops attach to every shipment). Existing draft rows
    for the group have their `data` overwritten; existing FINAL rows are
    left untouched (skipped).
    """
    rows = await _load_transfer_rows(db, transfer_group_id)
    if not rows:
        raise ValueError(f"No transfers found for transfer_group_id={transfer_group_id}")

    first = rows[0][0]
    from_location = await db.get(Location, first.from_location_id)
    to_location = await db.get(Location, first.to_location_id)
    reference_number = first.name or str(transfer_group_id)
    ship_date = _fmt_date(first.shipped_at or first.planned_date)
    receive_date = _fmt_date(first.received_at or first.expected_received_date)

    packing_list_data = _build_packing_list_data(
        reference_number=reference_number,
        ship_date=ship_date,
        from_location=from_location,
        to_location=to_location,
        rows=rows,
    )
    shipment_summary = _build_shipment_summary(rows=rows, ship_date=ship_date, receive_date=receive_date)
    commercial_invoice_data = _build_commercial_invoice_data(
        reference_number=reference_number,
        invoice_date=ship_date,
        # Default to the standard note when the transfer has no custom one --
        # the real reference invoice always shows a Notes section, but the
        # renderer only draws it when non-empty, so an unset InventoryTransfer
        # .notes was silently dropping the whole section. The computed
        # shipment summary (SKU count, item count, weight, ship/receive
        # dates) is always appended below it.
        notes=f"{first.notes or 'INVENTORY TRANSFER'}\n\n{shipment_summary}",
        from_location=from_location,
        to_location=to_location,
        rows=rows,
    )
    pallet_labels_data = _build_pallet_labels_data(
        reference_number=reference_number,
        pallets_count=int(packing_list_data["pallets_count"]),
        shipment_title=first.name,
    )
    usmca_data = _build_usmca_data(from_location=from_location, to_location=to_location, rows=rows)
    paps_form_data = {
        "reference_number": reference_number,
        "shipment_title": first.name,
        "paps_number": first.paps_number,
        "from_code": from_location.code if from_location else None,
        "to_code": to_location.code if to_location else None,
        "ship_date": ship_date,
    }
    port_of_entry_form_data = {
        "reference_number": reference_number,
        "shipment_title": first.name,
        "port_of_entry_number": first.port_of_entry_number,
        "from_code": from_location.code if from_location else None,
        "to_code": to_location.code if to_location else None,
        "ship_date": ship_date,
    }

    documents_data: list[tuple[TransferDocumentType, dict[str, Any]]] = [
        (TransferDocumentType.COMMERCIAL_INVOICE, commercial_invoice_data),
        (TransferDocumentType.PACKING_LIST, packing_list_data),
        (TransferDocumentType.PALLET_LABELS, pallet_labels_data),
        (TransferDocumentType.USMCA_CERTIFICATE, usmca_data),
        # Always included now that this is a reference document (the
        # uploaded PDF is served as-is, not rendered from is_food SKU
        # data) -- ops attach it to every shipment regardless of contents.
        (TransferDocumentType.FDA_PRODUCT_WORKSHEET, _build_fda_data(rows=rows)),
        (TransferDocumentType.PAPS_FORM, paps_form_data),
        (TransferDocumentType.PORT_OF_ENTRY_FORM, port_of_entry_form_data),
        # Upload-only: no computed data, ops attaches the file directly
        # (see UPLOAD_ONLY_DOCUMENT_TYPES / upload_document_file below).
        (TransferDocumentType.CUSTOMS_CLEARANCE_PAPER, {}),
        (TransferDocumentType.CUSTOMS_ENTRY_SUMMARY, {}),
        (TransferDocumentType.CUSTOMS_CLEARANCE_INVOICE, {}),
    ]

    result_docs: list[TransferDocument] = []
    for doc_type, data in documents_data:
        existing_result = await db.execute(
            select(TransferDocument).where(
                TransferDocument.transfer_group_id == transfer_group_id,
                TransferDocument.document_type == doc_type,
            )
        )
        doc = existing_result.scalar_one_or_none()
        if doc is not None:
            if doc.status == TransferDocumentStatus.FINAL:
                log.info(
                    "build_drafts: skipping regeneration of finalized %s for group %s",
                    doc_type.value,
                    transfer_group_id,
                )
                result_docs.append(doc)
                continue
            doc.data = data
            doc.reference_number = reference_number
            db.add(doc)
        else:
            doc = TransferDocument(
                transfer_group_id=transfer_group_id,
                document_type=doc_type,
                status=TransferDocumentStatus.DRAFT,
                reference_number=reference_number,
                data=data,
            )
            db.add(doc)
        result_docs.append(doc)

    await sync_paps_entry_documents(db, transfer_group_id)

    await db.commit()
    for doc in result_docs:
        await db.refresh(doc)
    return result_docs


async def sync_paps_entry_documents(
    db: AsyncSession, transfer_group_id: UUID, actor_user_id: UUID | None = None
) -> None:
    """Keep PAPS_FORM / PORT_OF_ENTRY_FORM in sync with the transfer's
    current paps_number / port_of_entry_number.

    Unlike every other document type, these two aren't meant to be
    manually reviewed and finalized once -- they're a direct reflection of
    a plain field. As soon as the number is present, render + finalize the
    document immediately (no Generate/Edit/Finalize clicks needed). If the
    number is cleared, revert the document to draft rather than leaving it
    finalized with stale data.

    Called both from build_drafts (initial generation) and from the
    transfer PATCH route whenever paps_number/port_of_entry_number changes.
    No-op if documents haven't been generated for this group yet, or if
    generating the PDF fails (logged, not raised -- a rendering hiccup
    shouldn't block saving the transfer's number itself).

    Caller commits (this only flushes).
    """
    rows = await _load_transfer_rows(db, transfer_group_id)
    if not rows:
        return
    first = rows[0][0]
    reference_number = first.name or str(transfer_group_id)
    ship_date = _fmt_date(first.shipped_at or first.planned_date)
    from_location = await db.get(Location, first.from_location_id)
    to_location = await db.get(Location, first.to_location_id)
    from_code = from_location.code if from_location else None
    to_code = to_location.code if to_location else None

    targets: list[tuple[TransferDocumentType, dict[str, Any], bool]] = [
        (
            TransferDocumentType.PAPS_FORM,
            {
                "reference_number": reference_number,
                "shipment_title": first.name,
                "paps_number": first.paps_number,
                "from_code": from_code,
                "to_code": to_code,
                "ship_date": ship_date,
            },
            bool(first.paps_number and first.paps_number.strip()),
        ),
        (
            TransferDocumentType.PORT_OF_ENTRY_FORM,
            {
                "reference_number": reference_number,
                "shipment_title": first.name,
                "port_of_entry_number": first.port_of_entry_number,
                "from_code": from_code,
                "to_code": to_code,
                "ship_date": ship_date,
            },
            bool(first.port_of_entry_number and first.port_of_entry_number.strip()),
        ),
    ]

    for doc_type, data, number_present in targets:
        existing_result = await db.execute(
            select(TransferDocument).where(
                TransferDocument.transfer_group_id == transfer_group_id,
                TransferDocument.document_type == doc_type,
            )
        )
        doc = existing_result.scalar_one_or_none()
        if doc is None:
            # Not generated yet for this shipment -- nothing to sync until
            # ops clicks Generate documents at least once.
            continue

        old_storage_key = doc.storage_key
        doc.data = data
        doc.reference_number = reference_number

        if number_present:
            try:
                pdf_bytes = await asyncio.to_thread(render_pdf, doc)
                storage = get_storage()
                stored = await storage.put(
                    data=io.BytesIO(pdf_bytes),
                    filename=f"{doc_type.value}.pdf",
                    content_type="application/pdf",
                    prefix=f"transfer-documents/{transfer_group_id}",
                )
            except Exception as e:
                log.exception(
                    "sync_paps_entry_documents: failed to render/upload %s for group %s",
                    doc_type.value,
                    transfer_group_id,
                )
                doc.data = {**data, "sync_error": f"{type(e).__name__}: {e}"}
                db.add(doc)
                await db.commit()
                continue
            doc.storage_key = stored.key
            doc.storage_url = stored.url
            doc.pdf_generated_at = datetime.now(timezone.utc)
            doc.status = TransferDocumentStatus.FINAL
            if actor_user_id is not None:
                doc.updated_by_user_id = actor_user_id
                if doc.generated_by_user_id is None:
                    doc.generated_by_user_id = actor_user_id
            # Every re-sync writes a fresh storage key -- clean up the file
            # it superseded so repeated edits don't leak orphaned PDFs.
            if old_storage_key and old_storage_key != doc.storage_key:
                try:
                    await get_storage().delete(old_storage_key)
                except Exception:
                    log.exception(
                        "sync_paps_entry_documents: failed to delete superseded %s file %s for group %s",
                        doc_type.value,
                        old_storage_key,
                        transfer_group_id,
                    )
        else:
            doc.status = TransferDocumentStatus.DRAFT
            doc.storage_key = None
            doc.storage_url = None
            doc.pdf_generated_at = None
            if old_storage_key:
                try:
                    await get_storage().delete(old_storage_key)
                except Exception:
                    log.exception(
                        "sync_paps_entry_documents: failed to delete cleared %s file %s for group %s",
                        doc_type.value,
                        old_storage_key,
                        transfer_group_id,
                    )

        db.add(doc)
        await db.commit()
        await db.refresh(doc)


_RENDERERS = {
    TransferDocumentType.COMMERCIAL_INVOICE: commercial_invoice.render_html,
    TransferDocumentType.PACKING_LIST: packing_list.render_html,
    TransferDocumentType.PALLET_LABELS: pallet_labels.render_html,
    TransferDocumentType.USMCA_CERTIFICATE: usmca_certificate.render_html,
    TransferDocumentType.FDA_PRODUCT_WORKSHEET: fda_product_worksheet.render_html,
    TransferDocumentType.PAPS_FORM: paps_form.render_html,
    TransferDocumentType.PORT_OF_ENTRY_FORM: port_of_entry_form.render_html,
}


def render_pdf(document: TransferDocument) -> bytes:
    """Render a TransferDocument's current `data` to PDF bytes."""
    renderer = _RENDERERS.get(document.document_type)
    if renderer is None:
        raise ValueError(f"No renderer registered for document_type={document.document_type!r}")
    html = renderer(document.data or {})

    from weasyprint import HTML  # local import: heavy dep, only needed at render time

    return HTML(string=html).write_pdf()


# Document types served as a literal admin-uploaded reference file rather
# than rendered from per-shipment data -- e.g. USMCA is a blanket
# certificate valid for a whole period, covering many shipments unchanged,
# and the FDA product worksheet is filled/edited externally by ops rather
# than computed from shipment data.
REFERENCE_DOCUMENT_TYPES = {
    TransferDocumentType.USMCA_CERTIFICATE,
    TransferDocumentType.FDA_PRODUCT_WORKSHEET,
}


def reference_document_key(document_type: TransferDocumentType) -> str:
    return f"reference-documents/{document_type.value}.pdf"


# Document types that are a plain ops-uploaded file specific to this one
# shipment -- e.g. the broker's clearance invoice for this transfer. Unlike
# REFERENCE_DOCUMENT_TYPES (one shared file reused across every shipment),
# each of these has its own upload per transfer_group_id via
# upload_document_file() below; finalize()/render_pdf() don't apply.
UPLOAD_ONLY_DOCUMENT_TYPES = {
    TransferDocumentType.CUSTOMS_CLEARANCE_PAPER,
    TransferDocumentType.CUSTOMS_ENTRY_SUMMARY,
    TransferDocumentType.CUSTOMS_CLEARANCE_INVOICE,
}


async def upload_document_file(
    db: AsyncSession,
    document_id: UUID,
    *,
    file_data: BinaryIO,
    filename: str,
    content_type: str | None,
    actor_user_id: UUID,
) -> TransferDocument:
    """Attach an ops-uploaded file as this document's final artifact --
    no rendering, no editable `data`; the uploaded file itself is the
    document. Re-uploading requires reopen() first (mirrors finalize()'s
    one-way draft->final transition for every other document type)."""
    document = await db.get(TransferDocument, document_id)
    if document is None:
        raise ValueError(f"TransferDocument {document_id} not found")
    if document.document_type not in UPLOAD_ONLY_DOCUMENT_TYPES:
        raise ValueError(f"{document.document_type.value} is not an upload-only document type")
    if document.status == TransferDocumentStatus.FINAL:
        raise ValueError("Document is already finalized; reopen it first to replace the file")

    storage = get_storage()
    stored = await storage.put(
        data=file_data,
        filename=filename,
        content_type=content_type,
        prefix=f"transfer-documents/{document.transfer_group_id}",
    )

    document.storage_key = stored.key
    document.storage_url = stored.url
    document.pdf_generated_at = datetime.now(timezone.utc)
    document.status = TransferDocumentStatus.FINAL
    document.updated_by_user_id = actor_user_id
    if document.generated_by_user_id is None:
        document.generated_by_user_id = actor_user_id
    db.add(document)
    await db.commit()
    await db.refresh(document)
    return document


async def finalize(db: AsyncSession, document_id: UUID, actor_user_id: UUID) -> TransferDocument:
    """Mark a document final -- rendering its data to PDF. For
    REFERENCE_DOCUMENT_TYPES, an admin-uploaded reference file (if one has
    been uploaded) is adopted as-is instead, overriding the rendered PDF --
    e.g. a signed USMCA blanket certificate that supersedes the computed
    default. Absent an uploaded override, these types render from computed
    data the same as every other document type."""
    document = await db.get(TransferDocument, document_id)
    if document is None:
        raise ValueError(f"TransferDocument {document_id} not found")
    if document.document_type in UPLOAD_ONLY_DOCUMENT_TYPES:
        raise ValueError(
            f"{document.document_type.value} is an upload-only document -- upload the file directly"
        )

    if document.document_type in REFERENCE_DOCUMENT_TYPES:
        storage = get_storage()
        ref_key = reference_document_key(document.document_type)
        if await storage.exists(ref_key):
            document.storage_key = ref_key
            document.storage_url = None  # resolved fresh at download time
            document.pdf_generated_at = datetime.now(timezone.utc)
            document.status = TransferDocumentStatus.FINAL
            document.updated_by_user_id = actor_user_id
            if document.generated_by_user_id is None:
                document.generated_by_user_id = actor_user_id
            db.add(document)
            await db.commit()
            await db.refresh(document)
            return document

    pdf_bytes = await asyncio.to_thread(render_pdf, document)

    storage = get_storage()
    stored = await storage.put(
        data=io.BytesIO(pdf_bytes),
        filename=f"{document.document_type.value}.pdf",
        content_type="application/pdf",
        prefix=f"transfer-documents/{document.transfer_group_id}",
    )

    document.storage_key = stored.key
    document.storage_url = stored.url
    document.pdf_generated_at = datetime.now(timezone.utc)
    document.status = TransferDocumentStatus.FINAL
    document.updated_by_user_id = actor_user_id
    if document.generated_by_user_id is None:
        document.generated_by_user_id = actor_user_id
    db.add(document)
    await db.commit()
    await db.refresh(document)
    return document


async def reopen(db: AsyncSession, document_id: UUID, actor_user_id: UUID) -> TransferDocument:
    """Revert a finalized document back to draft so it can be edited again.

    Admin-and-up only (enforced at the route level) -- this un-does a
    finalized customs document, which should be a deliberate, privileged
    action, not something available to every editor. The stale PDF's
    storage fields are cleared rather than left dangling; finalize() will
    populate a fresh storage_key/url the next time this document is
    finalized. The already-uploaded PDF object itself is left in place
    (not deleted) as an audit trail.
    """
    document = await db.get(TransferDocument, document_id)
    if document is None:
        raise ValueError(f"TransferDocument {document_id} not found")
    if document.status != TransferDocumentStatus.FINAL:
        raise ValueError("Document is not finalized; nothing to reopen")

    document.status = TransferDocumentStatus.DRAFT
    document.storage_key = None
    document.storage_url = None
    document.pdf_generated_at = None
    document.updated_by_user_id = actor_user_id
    db.add(document)
    await db.commit()
    await db.refresh(document)
    return document
