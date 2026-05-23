from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import String, DateTime, Text, Boolean
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class Connection(Base):
    __tablename__ = "connections"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    type: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255))
    # Lookup key for matching incoming webhooks to credentials (e.g. Verkada
    # org_id). Not secret — appears in plaintext on every webhook payload.
    external_id: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    encrypted_secret: Mapped[str] = mapped_column(Text)
    # False for connections auto-created on first webhook (no api_key yet).
    # Flips True once the user supplies their api_key via the finish-setup flow.
    setup_complete: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    cameras_last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    doors_last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    helix_events_last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    scenarios_last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        # Never let encrypted_secret leak into a default repr that might end up
        # in a log line, exception traceback, or REPL session.
        return (
            f"<Connection id={self.id} type={self.type!r} name={self.name!r} "
            f"external_id={self.external_id!r} setup_complete={self.setup_complete} "
            f"encrypted_secret=<redacted>>"
        )
