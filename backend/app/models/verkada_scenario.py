from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class VerkadaScenario(Base):
    """Cached Access scenario metadata pulled from /access/v1/scenarios.

    Verkada Access scenarios are named arming / lockdown / access modes
    configured in Command. Mirroring the VerkadaDoor / VerkadaCamera
    pattern so the UI can offer scenario pickers that show
    ``Lockdown — HQ`` instead of bare UUIDs, and so flow actions can
    activate one by id without re-listing every time.

    The ``raw`` column keeps the full upstream payload around — the
    public API for "activate" hasn't been wired yet, so until we know
    exactly which fields it accepts we keep everything available for
    later use.
    """

    __tablename__ = "verkada_scenarios"
    __table_args__ = (
        UniqueConstraint(
            "connection_id",
            "scenario_id",
            name="uq_verkada_scenarios_conn_scenario",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("connections.id", ondelete="CASCADE"),
        index=True,
    )
    scenario_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    scenario_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    site_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    site_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
