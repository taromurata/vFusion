from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db import Base


class AppSetting(Base):
    """Persistent UI-editable key/value config.

    Used today for retention windows (asset / clip / image / webhook
    event / run). Lookup goes through ``app/settings_store.py``, which
    caches reads for ~30 seconds so the cleanup cron isn't hammering
    Postgres every minute. Values are stored as strings; the helper
    layer coerces to int/etc on read.
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
