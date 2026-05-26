"""Brew-Your-Own-Analytics — a one-shot test runner.

Lets the user wire up a camera + prompt + Gemini model directly without
building a Flow. Reuses the same Run/RunEvent/step infrastructure so the
existing Runs page renders the captured clip/image, the per-phase
checklist, and the log stream identically.

The user-facing intent: "let me see if Gemini can answer X from this
camera right now, before I bake it into a real flow."
"""

from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Connection, Run


router = APIRouter(prefix="/api/byoa", tags=["byoa"])


class ByoaRunRequest(BaseModel):
    connection_id: UUID
    gemini_connection_id: UUID
    camera_id: str
    mode: Literal["live", "historical"]
    prompt: str
    model: str | None = None
    # Historical mode only:
    start_epoch: int | None = None
    duration_sec: float | None = None
    pre_roll_sec: float | None = None
    # Optional Helix post-step: when enabled, the worker runs a second
    # step after the analyze that POSTs to Verkada Helix with the AI
    # text in the chosen attribute. event_type_uid is required when
    # post_to_helix is true.
    post_to_helix: bool = False
    helix_event_type_uid: str | None = None
    helix_attribute: str | None = None
    # Paired-prompt multi-field mapping: {"Animal": "{{ output.json.animal }}",
    # "Behavior": "{{ output.json.behavior }}"}. When present, the worker
    # ignores ``helix_attribute`` and posts each field individually. Without
    # this declared on the model, Pydantic strips the field from the body
    # and BYOA quietly stuffs the entire JSON blob into a "Summary"
    # attribute that doesn't exist on the paired event type.
    helix_attribute_mapping: dict[str, str] | None = None


class ByoaRunResponse(BaseModel):
    run_id: UUID


@router.post("/run-once", response_model=ByoaRunResponse)
async def run_once(
    payload: ByoaRunRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> ByoaRunResponse:
    verkada = await session.get(Connection, payload.connection_id)
    if verkada is None or verkada.type != "verkada":
        raise HTTPException(status_code=404, detail="Verkada connection not found")
    gemini = await session.get(Connection, payload.gemini_connection_id)
    if gemini is None or gemini.type != "gemini":
        raise HTTPException(status_code=404, detail="Gemini connection not found")
    if not payload.camera_id.strip():
        raise HTTPException(status_code=400, detail="camera_id is required")
    if not payload.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    if payload.mode == "historical" and not payload.start_epoch:
        raise HTTPException(
            status_code=400, detail="start_epoch is required for historical mode"
        )
    if payload.post_to_helix and not payload.helix_event_type_uid:
        raise HTTPException(
            status_code=400,
            detail="helix_event_type_uid is required when post_to_helix is true",
        )

    # Store the BYOA params on the Run as its "input" so the Runs page can
    # show what was requested. flow_id stays null — this is a one-off, not
    # tied to any flow.
    input_blob: dict[str, Any] = {
        "byoa": True,
        "mode": payload.mode,
        "camera_id": payload.camera_id,
        "prompt": payload.prompt,
        "model": payload.model,
        "connection_id": str(payload.connection_id),
        "gemini_connection_id": str(payload.gemini_connection_id),
    }
    if payload.mode == "historical":
        input_blob["start_epoch"] = payload.start_epoch
        input_blob["duration_sec"] = payload.duration_sec or 10
        input_blob["pre_roll_sec"] = payload.pre_roll_sec if payload.pre_roll_sec is not None else 2
    if payload.post_to_helix:
        input_blob["post_to_helix"] = True
        input_blob["helix_event_type_uid"] = payload.helix_event_type_uid
        if payload.helix_attribute_mapping:
            # Paired prompt — let the worker post each field separately.
            # Don't seed a fallback ``helix_attribute`` here; the worker
            # prefers the mapping when present and the legacy single-field
            # path would just be dead weight in the input blob.
            input_blob["helix_attribute_mapping"] = payload.helix_attribute_mapping
        else:
            input_blob["helix_attribute"] = payload.helix_attribute or "Summary"
    run = Run(
        flow_id=None,
        webhook_event_id=None,
        status="pending",
        input=input_blob,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    pool = getattr(request.app.state, "arq_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="worker queue unavailable")
    await pool.enqueue_job("run_byoa", str(run.id))
    return ByoaRunResponse(run_id=run.id)
