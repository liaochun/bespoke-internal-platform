# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Service helpers for the sick-call + first-to-claim workflow."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.availability import UserAvailability
from app.models.availability_override import AvailabilityOverride
from app.models.shift import ShiftStatus, StaffShift
from app.models.sick_call import (
    SICK_FILLED,
    SICK_FILLING,
    ShiftClaimCandidate,
    ShiftClaimOffer,
)
from app.models.time_off import TimeOffRequest, TimeOffStatus
from app.models.user import User, UserRole
from app.services import notifications

settings = get_settings()


def _new_token() -> str:
    return secrets.token_urlsafe(32)[:64]


async def find_eligible_candidates(db: AsyncSession, *, shift: StaffShift) -> list[User]:
    """Compute candidates for a sick-called shift.

    v1: a user is eligible iff
      - is_active=true AND terminated_at IS NULL
      - suspended_until IS NULL OR suspended_until < now()
      - role != 'accountant'
      - id != shift.user_id
      - effective availability for shift's local weekday is_available=true
        (rolling/one-off availability_override row for that date wins over
         the weekday user_availability row when present)
        Note: this is flag-agnostic. Full-time staff (rolling not required)
        are matched off their weekday user_availability row; part-time staff
        (rolling required) maintain per-date overrides that win for that date.
        With no availability data at all the user is simply unavailable.
      - no overlapping non-cancelled shift in [starts_at, ends_at]
      - not on an approved time-off request spanning the shift date
    """
    tz = ZoneInfo(settings.app_timezone)
    local_start = shift.starts_at.astimezone(tz)
    shift_date = local_start.date()
    weekday = local_start.weekday()  # 0=Mon..6=Sun

    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(User).where(
            User.is_active.is_(True),
            User.terminated_at.is_(None),
            User.role != UserRole.ACCOUNTANT.value,
            User.id != shift.user_id,
            User.eligible_for_shift_offers.is_(True),
        )
    )
    candidates = list(result.scalars())
    if not candidates:
        return []

    # Drop suspended.
    candidates = [
        u
        for u in candidates
        if u.suspended_until is None or u.suspended_until < now
    ]
    if not candidates:
        return []
    cand_ids = [u.id for u in candidates]

    # Availability — weekday baseline.
    avail_q = await db.execute(
        select(UserAvailability).where(
            UserAvailability.user_id.in_(cand_ids),
            UserAvailability.weekday == weekday,
        )
    )
    weekday_by_user: dict = {row.user_id: row for row in avail_q.scalars()}

    # Availability — one-off / rolling override for the exact date wins.
    ov_q = await db.execute(
        select(AvailabilityOverride).where(
            AvailabilityOverride.user_id.in_(cand_ids),
            AvailabilityOverride.date == shift_date,
        )
    )
    override_by_user: dict = {row.user_id: row for row in ov_q.scalars()}

    def _is_available(u: User) -> bool:
        ov = override_by_user.get(u.id)
        if ov is not None:
            return ov.is_available
        wk = weekday_by_user.get(u.id)
        if wk is not None:
            return wk.is_available
        # No row at all. If user opted into rolling availability we want a
        # positive opt-in for the day; otherwise default unavailable.
        return False

    candidates = [u for u in candidates if _is_available(u)]
    if not candidates:
        return []
    cand_ids = [u.id for u in candidates]

    # Drop anyone with an overlapping scheduled/in_progress shift.
    overlap_q = await db.execute(
        select(StaffShift.user_id).where(
            StaffShift.user_id.in_(cand_ids),
            StaffShift.status.in_([ShiftStatus.SCHEDULED, ShiftStatus.IN_PROGRESS]),
            StaffShift.id != shift.id,
            StaffShift.starts_at < shift.ends_at,
            StaffShift.ends_at > shift.starts_at,
        )
    )
    busy_ids = {row[0] for row in overlap_q.all()}
    candidates = [u for u in candidates if u.id not in busy_ids]
    if not candidates:
        return []
    cand_ids = [u.id for u in candidates]

    # Drop anyone on approved OOO spanning the shift date.
    oo_q = await db.execute(
        select(TimeOffRequest.user_id).where(
            TimeOffRequest.user_id.in_(cand_ids),
            TimeOffRequest.status == TimeOffStatus.APPROVED,
            TimeOffRequest.start_date <= shift_date,
            TimeOffRequest.end_date >= shift_date,
        )
    )
    ooo_ids = {row[0] for row in oo_q.all()}
    return [u for u in candidates if u.id not in ooo_ids]


async def open_offer(
    db: AsyncSession, *, shift: StaffShift, opener: User
) -> tuple[ShiftClaimOffer, list[ShiftClaimCandidate]]:
    """Create the offer + candidate rows, send emails, mark shift filling.
    Caller is responsible for db.commit()."""
    now = datetime.now(timezone.utc)
    # Offer expires at min(shift start, opened_at + 24h). The claim endpoint
    # checks expires_at, so no background sweeper needed for v1.
    expires_at = min(shift.starts_at, now + timedelta(hours=24))

    offer = ShiftClaimOffer(
        shift_id=shift.id,
        opened_by_user_id=opener.id,
        expires_at=expires_at,
    )
    db.add(offer)
    await db.flush()

    eligibles = await find_eligible_candidates(db, shift=shift)
    candidates: list[ShiftClaimCandidate] = []
    for u in eligibles:
        c = ShiftClaimCandidate(
            offer_id=offer.id,
            user_id=u.id,
            claim_token=_new_token(),
        )
        db.add(c)
        candidates.append(c)
    await db.flush()

    shift.sick_call_status = SICK_FILLING
    db.add(shift)

    if candidates:
        await notifications.notify_shift_offer_to_candidates(
            db, offer, candidates, shift
        )

    return offer, candidates


async def accept_claim(
    db: AsyncSession, *, token: str, claimer: User
) -> tuple[StaffShift, ShiftClaimOffer, User | None]:
    """Atomic claim. Caller is responsible for db.commit() AND for sending
    the post-claim notifications (see the three notify_shift_claimed_* /
    notify_shift_filled_to_manager calls) -- kept out of this function so
    the caller can defer them to a background task instead of holding the
    client's request open for however long the notification fan-out takes
    (one candidate list here can mean half a dozen sequential Resend calls)."""
    cand_q = await db.execute(
        select(ShiftClaimCandidate).where(ShiftClaimCandidate.claim_token == token)
    )
    candidate = cand_q.scalar_one_or_none()
    if candidate is None:
        raise ClaimError(404, "Claim link not recognised")
    if candidate.user_id != claimer.id:
        raise ClaimError(403, "This claim link isn't yours")

    # Lock the offer row to serialise concurrent claims for the same shift.
    locked_q = await db.execute(
        select(ShiftClaimOffer)
        .where(ShiftClaimOffer.id == candidate.offer_id)
        .with_for_update()
    )
    offer = locked_q.scalar_one_or_none()
    if offer is None:
        raise ClaimError(404, "Offer not found")
    if offer.cancelled_at is not None:
        raise ClaimError(409, "Offer was cancelled")
    if offer.claimed_by_user_id is not None:
        raise ClaimError(409, "This shift has already been claimed")
    now = datetime.now(timezone.utc)
    if offer.expires_at <= now:
        raise ClaimError(410, "Offer has expired")

    shift = await db.get(StaffShift, offer.shift_id)
    if shift is None:
        raise ClaimError(404, "Shift not found")

    offer.claimed_by_user_id = claimer.id
    offer.claimed_at = now
    db.add(offer)

    # Reassign + restore the shift's scheduled state.
    shift.user_id = claimer.id
    shift.status = ShiftStatus.SCHEDULED
    shift.sick_call_status = SICK_FILLED
    db.add(shift)
    await db.flush()

    opener = await db.get(User, offer.opened_by_user_id)
    return shift, offer, opener


async def cancel_offer(
    db: AsyncSession, *, offer: ShiftClaimOffer, reason: str | None = None
) -> ShiftClaimOffer:
    if offer.claimed_by_user_id is not None:
        raise ClaimError(409, "Cannot cancel an already-claimed offer")
    if offer.cancelled_at is not None:
        return offer
    offer.cancelled_at = datetime.now(timezone.utc)
    offer.cancel_reason = reason
    db.add(offer)
    return offer


class ClaimError(Exception):
    """Internal error used by accept_claim — the route turns it into an HTTPException."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
