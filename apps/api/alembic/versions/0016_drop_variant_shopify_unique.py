# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""drop UNIQUE on master_item_variants.shopify_variant_id

Airtable is source of truth and contains records that legitimately share the
same Shopify variant id (likely stale duplicates the operator hasn't dedup'd
yet). We mirror faithfully — keep the lookup index, drop uniqueness.

`airtable_record_id` remains unique (Airtable record ids ARE unique by
definition).

Revision ID: 0016_drop_variant_shopify_unique
Revises: 0015_master_item_variants
Create Date: 2026-05-04

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_drop_variant_shopify_unique"
down_revision: Union[str, None] = "0015_master_item_variants"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ux_variants_shopify_variant_id", table_name="master_item_variants")
    op.create_index(
        "ix_variants_shopify_variant_id",
        "master_item_variants",
        ["shopify_variant_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_variants_shopify_variant_id", table_name="master_item_variants")
    op.create_index(
        "ux_variants_shopify_variant_id",
        "master_item_variants",
        ["shopify_variant_id"],
        unique=True,
        postgresql_where=sa.text("shopify_variant_id IS NOT NULL"),
    )
