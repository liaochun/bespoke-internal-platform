# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""webhook_events table for Shopify + future integrations

Revision ID: 0011_webhook_events
Revises: 0010_inventory_velocity
Create Date: 2026-05-04

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011_webhook_events"
down_revision: Union[str, None] = "0010_inventory_velocity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "webhook_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("topic", sa.String(128), nullable=False),
        sa.Column("external_event_id", sa.String(128), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="received"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.UniqueConstraint(
            "source", "external_event_id", name="uq_webhook_source_event"
        ),
    )
    op.create_index("ix_webhook_events_source_topic", "webhook_events", ["source", "topic"])
    op.create_index("ix_webhook_events_received_at", "webhook_events", ["received_at"])


def downgrade() -> None:
    op.drop_table("webhook_events")
