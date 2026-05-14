from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    byoa,
    config as config_api,
    connections,
    flows,
    hooks,
    prompt_templates,
    runs,
    settings as settings_api,
    stats,
    taxonomy,
    triggers,
    verkada_catalog,
    verkada_resources,
    webhook_events,
)
from app.config import settings
from app.pricing.gemini import refresh_gemini_pricing
from app.queue import make_pool
from app.reclassify import reclassify_unknowns


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Re-classify unknowns against the latest taxonomy.
    await reclassify_unknowns()
    # Seed Gemini pricing so cost_for() has rows on first request, even
    # before the worker's daily cron runs for the first time.
    try:
        await refresh_gemini_pricing()
    except Exception:  # noqa: BLE001 — pricing failure must not block boot
        pass
    # arq pool for enqueuing flow runs.
    app.state.arq_pool = await make_pool()
    try:
        yield
    finally:
        await app.state.arq_pool.close()


app = FastAPI(title="vSplice", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(hooks.router)
app.include_router(webhook_events.router)
app.include_router(connections.router)
app.include_router(taxonomy.router)
app.include_router(flows.router)
app.include_router(runs.router)
app.include_router(verkada_resources.router)
app.include_router(verkada_catalog.router)
app.include_router(triggers.router)
app.include_router(stats.router)
app.include_router(prompt_templates.router)
app.include_router(byoa.router)
app.include_router(config_api.router)
app.include_router(settings_api.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
