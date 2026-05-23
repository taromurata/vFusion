"""Flow templates — ready-to-use starter flows shipped with the app.

Templates live as plain JSON files in ``backend/app/data/flow_templates/``
so they're easy to edit and version without DB migrations. Each file
matches the shape::

    {
      "id": "slug",
      "name": "Display name",
      "category": "AI analytics" | "Scheduled" | "Access automation",
      "description": "...",
      "summary": "short one-liner",
      "default_name": "What to name the flow when applied",
      "flow": {
        "trigger_type": "verkada_webhook" | "schedule",
        "trigger_config": {...},
        "nodes": [...],
        "edges": [...]
      }
    }

Connection IDs inside the template are intentionally ``null`` — the user
picks their own Verkada / Gemini connection on first edit.

Two endpoints:
  - ``GET  /api/flow-templates``         — list (no nodes/edges in payload).
  - ``GET  /api/flow-templates/{id}``    — full template incl. nodes/edges.

The "use this template" UX is implemented purely client-side: the
frontend GETs the full template, then POSTs to ``/api/flows`` with the
template's flow body. No new write endpoint here — reuses the existing
flow-create path so validation stays in one place.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException


_TEMPLATES_DIR = Path(__file__).parent.parent / "data" / "flow_templates"


def _load_all() -> dict[str, dict[str, Any]]:
    """Read every JSON file in the templates dir. Cheap (a handful of
    small files) and called fresh per request — keeps shipping a new
    template a matter of dropping a file and reloading."""
    templates: dict[str, dict[str, Any]] = {}
    if not _TEMPLATES_DIR.is_dir():
        return templates
    for path in sorted(_TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        tid = data.get("id")
        if isinstance(tid, str) and tid:
            templates[tid] = data
    return templates


router = APIRouter(prefix="/api/flow-templates", tags=["flow-templates"])


@router.get("")
async def list_flow_templates() -> list[dict[str, Any]]:
    """Lightweight index for the Templates page — no nodes/edges."""
    return [
        {
            "id": tpl["id"],
            "name": tpl.get("name", tpl["id"]),
            "category": tpl.get("category"),
            "description": tpl.get("description"),
            "summary": tpl.get("summary"),
            "trigger_type": tpl.get("flow", {}).get("trigger_type"),
            "default_name": tpl.get("default_name", tpl.get("name", tpl["id"])),
        }
        for tpl in _load_all().values()
    ]


@router.get("/{template_id}")
async def get_flow_template(template_id: str) -> dict[str, Any]:
    """Full template body — frontend uses this to populate the
    ``POST /api/flows`` request that creates the new flow."""
    templates = _load_all()
    if template_id not in templates:
        raise HTTPException(status_code=404, detail=f"Unknown flow template: {template_id!r}")
    return templates[template_id]
