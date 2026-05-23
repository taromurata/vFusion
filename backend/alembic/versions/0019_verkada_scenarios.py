"""verkada_scenarios cache + connections.scenarios_last_synced_at

Revision ID: 0019
Revises: 0018
Create Date: 2026-05-23

Adds per-connection cache of Verkada Access scenarios (the named
arming / access state machines configured in Command). Mirrors the
cameras / doors / helix-event-types pattern so the rest of the app can
resolve scenario UUIDs to friendly names without a live API call.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "connections",
        sa.Column(
            "scenarios_last_synced_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.create_table(
        "verkada_scenarios",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "connection_id",
            UUID(as_uuid=True),
            sa.ForeignKey("connections.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("scenario_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=True),
        # Scenario type — Verkada surfaces e.g. arming / access modes.
        # Stored loosely as a string so future types don't require a
        # migration.
        sa.Column("scenario_type", sa.String(64), nullable=True),
        sa.Column("site_id", sa.String(64), nullable=True),
        sa.Column("site_name", sa.String(255), nullable=True),
        sa.Column("raw", JSONB, nullable=True),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_verkada_scenarios_connection_id",
        "verkada_scenarios",
        ["connection_id"],
    )
    op.create_index(
        "ix_verkada_scenarios_scenario_id",
        "verkada_scenarios",
        ["scenario_id"],
    )
    op.create_unique_constraint(
        "uq_verkada_scenarios_conn_scenario",
        "verkada_scenarios",
        ["connection_id", "scenario_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_verkada_scenarios_conn_scenario", "verkada_scenarios", type_="unique"
    )
    op.drop_index("ix_verkada_scenarios_scenario_id", table_name="verkada_scenarios")
    op.drop_index(
        "ix_verkada_scenarios_connection_id", table_name="verkada_scenarios"
    )
    op.drop_table("verkada_scenarios")
    op.drop_column("connections", "scenarios_last_synced_at")
