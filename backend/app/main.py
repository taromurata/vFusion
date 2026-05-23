from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import (
    auth as auth_api,
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
from app.auth import SESSION_COOKIE, verify_session_token
from app.config import settings
from app.pricing.gemini import refresh_gemini_pricing
from app.queue import make_pool
from app.reclassify import reclassify_unknowns


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Resolve / auto-generate the Fernet key eagerly at boot so the
    # "I generated a new key" warning shows up in startup logs (vs
    # waiting for the first encryption op). Also catches volume-mount
    # or permission problems at boot rather than on first Connection
    # save.
    from app.crypto import _fernet
    _fernet()
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


from app.brand import BRAND_NAME

app = FastAPI(title=BRAND_NAME, version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Routes that bypass the session-cookie gate. Webhooks are public by
# design (signature-verified, not cookie-verified) and the auth + tiny
# public-config + health endpoints must work before the operator has
# anything resembling a session.
_PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/hooks",
    "/api/auth",
    "/api/config",
    "/api/health",
    # FastAPI's interactive docs — handy in dev, harmless in prod since
    # they only describe the API surface, not its data.
    "/docs",
    "/redoc",
    "/openapi.json",
)


@app.middleware("http")
async def require_session(request: Request, call_next):
    """Enforce the admin session cookie on every non-public route.

    The frontend's ``AuthGate`` reads ``/api/auth/status`` first to
    decide whether to show the setup wizard, the login form, or the app
    proper. Any other request without a valid cookie gets a clean 401
    so the frontend can react (e.g. on session expiry mid-session).
    """
    # CORS preflight requests carry no cookies — let them through so
    # the actual request can be evaluated on its own merits.
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if any(path.startswith(p) for p in _PUBLIC_PATH_PREFIXES):
        return await call_next(request)
    token = request.cookies.get(SESSION_COOKIE)
    if not verify_session_token(token):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)


app.include_router(auth_api.router)
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
