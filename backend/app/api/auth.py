"""Auth API — single-user admin password.

Four endpoints, all public (no auth middleware on ``/api/auth/*``):

  - ``GET  /api/auth/status``  — what state is the install in?
  - ``POST /api/auth/setup``   — set the initial password (first-run only)
  - ``POST /api/auth/login``   — exchange password for a session cookie
  - ``POST /api/auth/logout``  — clear the cookie

The login + setup endpoints both mint a session cookie on success so
the operator lands in the app without a second redirect.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    ADMIN_PASSWORD_HASH_KEY,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    SESSION_COOKIE,
    SESSION_LIFETIME_SEC,
    hash_password,
    make_session_token,
    validate_password_strength,
    verify_password,
    verify_session_token,
)
from app.db import get_session
from app.settings_store import get_str, set_value


router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthStatus(BaseModel):
    # True once a password has been set. Until then, the frontend shows
    # the setup wizard and gates everything behind it.
    password_set: bool
    # True if the current request carried a valid session cookie.
    authenticated: bool
    min_password_length: int = MIN_PASSWORD_LENGTH
    max_password_length: int = MAX_PASSWORD_LENGTH


class PasswordBody(BaseModel):
    password: str


def _set_session_cookie(response: Response) -> None:
    """Issue a fresh signed session cookie on the response.

    SameSite=Lax + HttpOnly. Secure flag is left off so the cookie also
    works for the local-LAN ``http://<host>:15173`` access pattern; in
    production deploys behind Cloudflare/HTTPS the operator can add a
    reverse proxy that upgrades cookies if they want strict Secure.
    """
    response.set_cookie(
        SESSION_COOKIE,
        make_session_token(),
        max_age=SESSION_LIFETIME_SEC,
        httponly=True,
        samesite="lax",
        path="/",
    )


@router.get("/status", response_model=AuthStatus)
async def auth_status(request: Request) -> AuthStatus:
    stored = await get_str(ADMIN_PASSWORD_HASH_KEY)
    password_set = bool(stored)
    token = request.cookies.get(SESSION_COOKIE)
    authenticated = password_set and verify_session_token(token)
    return AuthStatus(password_set=password_set, authenticated=authenticated)


@router.post("/setup", response_model=AuthStatus)
async def setup_password(
    body: PasswordBody,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> AuthStatus:
    """Set the initial admin password. Refuses if one is already set —
    rotating the password should never go through the open setup path
    (a future ``/change-password`` endpoint will require the old one)."""
    existing = await get_str(ADMIN_PASSWORD_HASH_KEY)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="A password is already set. Use the change-password flow or reset via the database.",
        )
    err = validate_password_strength(body.password)
    if err is not None:
        raise HTTPException(status_code=400, detail=err)
    await set_value(session, ADMIN_PASSWORD_HASH_KEY, hash_password(body.password))
    await session.commit()
    _set_session_cookie(response)
    return AuthStatus(password_set=True, authenticated=True)


@router.post("/login", response_model=AuthStatus)
async def login(
    body: PasswordBody,
    response: Response,
) -> AuthStatus:
    stored = await get_str(ADMIN_PASSWORD_HASH_KEY)
    if not stored:
        # Force the frontend to show the setup wizard instead.
        raise HTTPException(
            status_code=409,
            detail="No password is set yet — run the setup wizard first.",
        )
    if not verify_password(body.password, stored):
        # Single generic 401 — don't leak whether the password was close.
        raise HTTPException(status_code=401, detail="Invalid password.")
    _set_session_cookie(response)
    return AuthStatus(password_set=True, authenticated=True)


@router.post("/logout", status_code=204)
async def logout(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
