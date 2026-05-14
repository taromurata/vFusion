"""Settings API — UI-editable runtime knobs (retention, etc.)."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.settings_store import (
    SETTINGS,
    all_specs,
    get_str,
    set_value,
)


router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingRow(BaseModel):
    key: str
    label: str
    unit: str
    description: str
    default: str
    allow_zero: bool
    value: str | None  # the *effective* value (stored OR default if unset)


class SettingsResponse(BaseModel):
    items: list[SettingRow]


class SettingUpdate(BaseModel):
    value: str | None  # None or "" clears the override and reverts to default


@router.get("", response_model=SettingsResponse)
async def list_settings() -> SettingsResponse:
    items: list[SettingRow] = []
    for spec in all_specs():
        value = await get_str(spec["key"])
        items.append(
            SettingRow(
                key=spec["key"],
                label=spec["label"],
                unit=spec["unit"],
                description=spec["description"],
                default=spec["default"],
                allow_zero=spec["allow_zero"],
                value=value,
            )
        )
    return SettingsResponse(items=items)


@router.put("/{key}", response_model=SettingRow)
async def update_setting(
    key: str,
    body: SettingUpdate,
    session: AsyncSession = Depends(get_session),
) -> SettingRow:
    spec = SETTINGS.get(key)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown setting key: {key!r}")

    # Validate the value if non-empty — must parse as a non-negative int.
    value = body.value
    if value is not None and value != "":
        try:
            n = int(value)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail=f"value must be an integer: {e}"
            ) from e
        if n < 0:
            raise HTTPException(status_code=400, detail="value must be >= 0")
        if n == 0 and not spec.allow_zero:
            raise HTTPException(
                status_code=400,
                detail=f"setting {key!r} doesn't allow 0",
            )
    else:
        # Empty string = reset to default — store NULL.
        value = None

    await set_value(session, key, value)
    await session.commit()
    effective = await get_str(key)
    return SettingRow(
        key=spec.key,
        label=spec.label,
        unit=spec.unit,
        description=spec.description,
        default=spec.default,
        allow_zero=spec.allow_zero,
        value=effective,
    )
