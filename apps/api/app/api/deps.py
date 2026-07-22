# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
import logging
from typing import Annotated
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import decode_impersonation_token, decode_session_token
from app.db.session import get_db
from app.models.user import User, UserRole
from app.services.capabilities import compute_effective_capabilities

settings = get_settings()
logger = logging.getLogger(__name__)

IMPERSONATE_COOKIE_NAME = "northbound_impersonate"


async def _resolve_session_user(db: AsyncSession, session_token: str | None) -> User:
    if not session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_session_token(session_token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")

    try:
        user_id = UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Session revocation ("log out everywhere"): the JWT carries the
    # token_version that was current at login time. Password reset/change
    # bumps user.token_version, which immediately invalidates every other
    # already-issued cookie without needing any new UI surface. Tokens issued
    # before this claim existed default to 0, matching freshly-created users.
    if payload.get("tv", 0) != user.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    if user.invite_expires_at is not None:
        from datetime import datetime, timezone

        if user.invite_expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access expired")

    return user


async def get_current_user(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    session_token: Annotated[str | None, Cookie(alias=settings.session_cookie_name)] = None,
    impersonate_token: Annotated[str | None, Cookie(alias=IMPERSONATE_COOKIE_NAME)] = None,
) -> User:
    session_user = await _resolve_session_user(db, session_token)

    # Default state — no impersonation.
    request.state.is_impersonating = False
    request.state.impersonator_user_id = None

    if not impersonate_token:
        return session_user

    payload = decode_impersonation_token(impersonate_token)
    if not payload:
        logger.warning("Impersonation cookie invalid or expired; clearing.")
        request.state.clear_impersonation_cookie = True
        return session_user

    try:
        target_id = UUID(payload["impersonated_user_id"])
        original_id = UUID(payload["original_super_admin_id"])
    except (KeyError, ValueError):
        logger.warning("Impersonation cookie payload malformed; clearing.")
        request.state.clear_impersonation_cookie = True
        return session_user

    # The original super_admin recorded in the cookie must still be a super_admin
    # AND must match the session user (prevents stealing another user's session
    # but reusing their impersonate cookie).
    original = await db.get(User, original_id)
    if (
        original is None
        or original.role != UserRole.SUPER_ADMIN.value
        or not original.is_active
        or original.id != session_user.id
    ):
        logger.warning("Impersonation cookie original_super_admin_id check failed; clearing.")
        request.state.clear_impersonation_cookie = True
        return session_user

    target = await db.get(User, target_id)
    if target is None or not target.is_active:
        logger.warning("Impersonation target missing or inactive; clearing cookie.")
        request.state.clear_impersonation_cookie = True
        return session_user

    request.state.is_impersonating = True
    request.state.impersonator_user_id = original.id
    return target


def require_role(*roles: UserRole):
    """Dependency factory: only allow users whose role is in `roles`."""

    async def _checker(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role: {', '.join(r.value for r in roles)}",
            )
        return user

    return _checker


def require_capability(capability: str):
    """Dependency factory: gate by capability. Effective set = role defaults + grants − denials."""

    async def _checker(
        user: Annotated[User, Depends(get_current_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        caps = await compute_effective_capabilities(db, user)
        if capability not in caps:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing capability: {capability}",
            )
        return user

    return _checker


def require_any_capability(*capabilities: str):
    """Pass when the user has at least one of the listed capabilities."""

    async def _checker(
        user: Annotated[User, Depends(get_current_user)],
        db: Annotated[AsyncSession, Depends(get_db)],
    ) -> User:
        caps = await compute_effective_capabilities(db, user)
        if not any(c in caps for c in capabilities):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing one of: {', '.join(capabilities)}",
            )
        return user

    return _checker


require_admin = require_role(UserRole.SUPER_ADMIN, UserRole.ADMIN)
require_super_admin = require_role(UserRole.SUPER_ADMIN)
require_manager_or_above = require_role(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER)
require_reports_access = require_role(
    UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.ACCOUNTANT
)
require_above_staff = require_role(
    UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.ACCOUNTANT
)


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email.lower()))
    return result.scalar_one_or_none()
