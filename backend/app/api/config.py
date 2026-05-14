"""Public-config endpoint.

Tells the frontend two things:
  1. What kind of webhook ingress is active and which URL to display
     (Webhook Inbox banner + onboarding modal).
  2. Whether the install is "fresh" — i.e. needs to gate the dashboard
     behind a first-Verkada-webhook onboarding modal.

Three tunnel modes:
  - **quick**  — TryCloudflare ephemeral URL, auto-discovered from
    cloudflared's metrics endpoint. Hostname changes on every restart.
  - **named**  — operator set ``PUBLIC_WEBHOOK_BASE`` in ``.env`` (their
    own domain behind a Cloudflare named tunnel). Stable.
  - **lan**    — no tunnel running; backend is only reachable on the LAN
    or via VPN/Tailscale. ``public_webhook_base`` is null and the UI
    falls back to its local-origin guess.

Onboarding is "needed" until at least one Verkada Connection exists in
the DB. Connections are auto-created on first webhook arrival from a
real org (see ``hooks.py::_is_real_org_id``).
"""

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_session
from app.models import Connection, WebhookEvent


router = APIRouter(prefix="/api/config", tags=["config"])


# The cloudflared service in the ``quick`` compose profile binds its
# metrics server on this hostname:port inside the docker network.
_QUICK_METRICS_URL = "http://cloudflared-quick:2000/quicktunnel"


class PublicConfig(BaseModel):
    tunnel_mode: str  # "quick" | "named" | "lan"
    public_webhook_base: str | None = None
    ephemeral: bool = False  # True for quick mode — URL changes on restart
    # Onboarding state. True until a real Verkada Connection exists in
    # the DB (i.e. a real Verkada webhook has been auto-detected). The
    # frontend gates the dashboard behind a modal while this is true.
    needs_onboarding: bool = True
    # True if any webhook has been ingested, real or synthetic. Used by
    # the onboarding modal to show a "stack received its first request"
    # confirmation so users know the test-curl smoke check worked.
    any_webhook_received: bool = False


async def _try_quick_tunnel() -> str | None:
    """Ask cloudflared (quick mode) for the trycloudflare hostname.

    Returns the full ``https://<hostname>`` URL or None if the metrics
    endpoint isn't reachable (no quick-mode container) or hasn't yet
    learned a hostname.
    """
    try:
        # Short timeout — cloudflared-quick is on the same docker network,
        # so any successful probe completes in milliseconds. We poll this
        # endpoint every 2s while the page is loading, so a long timeout
        # in LAN mode (where the host isn't even resolvable) would stall
        # the UI.
        async with httpx.AsyncClient(timeout=0.5) as client:
            r = await client.get(_QUICK_METRICS_URL)
        if r.status_code != 200:
            return None
        data = r.json()
        hostname = data.get("hostname")
        if isinstance(hostname, str) and hostname:
            return f"https://{hostname}"
    except Exception:
        return None
    return None


async def _onboarding_state(session: AsyncSession) -> tuple[bool, bool]:
    """Return ``(needs_onboarding, any_webhook_received)``.

    Onboarding is "needed" until at least one Verkada Connection row exists.
    Connections are only auto-created on real-org-UUID webhooks, so this
    flag flips precisely when a legitimate Verkada webhook lands.
    """
    has_connection = await session.scalar(
        select(func.count()).select_from(Connection).where(Connection.type == "verkada")
    )
    any_webhook = await session.scalar(
        select(func.count()).select_from(WebhookEvent).limit(1)
    )
    return (not bool(has_connection), bool(any_webhook))


@router.get("", response_model=PublicConfig)
async def public_config(
    session: AsyncSession = Depends(get_session),
) -> PublicConfig:
    needs_onboarding, any_webhook_received = await _onboarding_state(session)
    quick_url = await _try_quick_tunnel()
    if quick_url:
        return PublicConfig(
            tunnel_mode="quick",
            public_webhook_base=quick_url,
            ephemeral=True,
            needs_onboarding=needs_onboarding,
            any_webhook_received=any_webhook_received,
        )
    if settings.public_webhook_base:
        return PublicConfig(
            tunnel_mode="named",
            public_webhook_base=settings.public_webhook_base,
            ephemeral=False,
            needs_onboarding=needs_onboarding,
            any_webhook_received=any_webhook_received,
        )
    return PublicConfig(
        tunnel_mode="lan",
        public_webhook_base=None,
        ephemeral=False,
        needs_onboarding=needs_onboarding,
        any_webhook_received=any_webhook_received,
    )
