# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_capability
from app.db.session import get_db
from app.models.shift import ShiftStatus, StaffShift
from app.models.sick_call import (
    SICK_DISMISSED,
    SICK_FILLING,
    SICK_FILLED,
    SICK_PENDING,
    ShiftClaimCandidate,
    ShiftClaimOffer,
    SickCallActionToken,
)
from app.models.user import User
from app.schemas.shift import ShiftPublic, ShiftWithStaff, StaffMini
from app.schemas.sick_call import (
    CancelOfferBody,
    CandidatePublic,
    ClaimOfferPublic,
    ClaimPreview,
    ClaimResult,
    DismissBody,
    OpenOfferResult,
    SickCallBody,
    SickCallPublic,
    SubHistoryEntry,
    SubLeaderboardEntry,
)
from app.services import notifications, sick_call as sick_call_svc
from app.services.event_log import record_event

router = APIRouter(tags=["workforce"])


async def _load_shift_with_user(db: AsyncSession, shift_id: UUID) -> StaffShift:
    result = await db.execute(
        select(StaffShift).options(selectinload(StaffShift.user)).where(StaffShift.id == shift_id)
    )
    s = result.scalar_one_or_none()
    if s is None:
        raise HTTPException(404, "Shift not found")
    return s


async def _serialize_sick_call(db: AsyncSession, shift: StaffShift) -> SickCallPublic:
    """Build a SickCallPublic with the optional called_in_by mini-user hydrated."""
    from app.schemas.shift import StaffMini

    base = SickCallPublic.model_validate(shift)
    if shift.called_in_by_user_id is not None:
        caller = await db.get(User, shift.called_in_by_user_id)
        if caller is not None:
            base.called_in_by = StaffMini(
                id=caller.id, full_name=caller.full_name, email=caller.email
            )
    return base


# ───────── Staff: call in sick ─────────


@router.post("/me/shifts/{shift_id}/sick", response_model=SickCallPublic)
async def call_in_sick(
    shift_id: UUID,
    body: SickCallBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> StaffShift:
    shift = await db.get(StaffShift, shift_id)
    if shift is None or shift.user_id != user.id:
        raise HTTPException(404, "Shift not found")
    if shift.status != ShiftStatus.SCHEDULED:
        raise HTTPException(400, "Only scheduled shifts can be called in sick")
    if shift.starts_at <= datetime.now(timezone.utc):
        raise HTTPException(400, "Can't call in sick for a past or in-progress shift")
    if shift.sick_call_status is not None:
        raise HTTPException(409, "This shift is already a sick call")

    shift.sick_called_at = datetime.now(timezone.utc)
    shift.sick_call_note = body.note
    shift.sick_call_status = SICK_PENDING
    shift.status = ShiftStatus.CANCELLED
    db.add(shift)
    await db.flush()

    await record_event(
        db,
        category="workforce",
        event_type="sick_call_opened",
        actor=user.email,
        entity_table="staff_shifts",
        entity_id=shift.id,
        payload={
            "note": body.note,
            "starts_at": shift.starts_at.isoformat(),
        },
    )
    await notifications.notify_sick_call_to_managers(db, shift)
    await db.commit()
    return await _load_shift_with_user(db, shift.id)


# ───────── Manager: mark someone's shift sick ─────────


@router.post("/admin/shifts/{shift_id}/sick", response_model=SickCallPublic)
async def admin_mark_sick(
    shift_id: UUID,
    body: SickCallBody,
    actor: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SickCallPublic:
    """Manager marks a staff member's shift as sick. Cancels the shift but
    records the sick reason, so the staff member still sees the cancellation
    and why (same shape as a self-reported sick call).

    Always logs who submitted the call via called_in_by_user_id (the actor)."""
    shift = await db.get(StaffShift, shift_id)
    if shift is None:
        raise HTTPException(404, "Shift not found")
    if shift.status != ShiftStatus.SCHEDULED:
        raise HTTPException(400, "Only scheduled shifts can be marked sick")
    if shift.sick_call_status is not None:
        raise HTTPException(409, "This shift is already a sick call")

    shift.sick_called_at = datetime.now(timezone.utc)
    shift.sick_call_note = body.note
    shift.sick_call_status = SICK_PENDING
    shift.status = ShiftStatus.CANCELLED
    shift.called_in_by_user_id = actor.id
    db.add(shift)
    await db.flush()

    await record_event(
        db,
        category="workforce",
        event_type="sick_call_opened",
        actor=actor.email,
        entity_table="staff_shifts",
        entity_id=shift.id,
        payload={
            "note": body.note,
            "marked_by_manager": True,
            "called_in_by": str(actor.id),
            "starts_at": shift.starts_at.isoformat(),
        },
    )
    await notifications.notify_sick_call_to_managers(db, shift)
    await db.commit()
    shift = await _load_shift_with_user(db, shift.id)
    return await _serialize_sick_call(db, shift)


# ───────── Manager: queue + actions ─────────


@router.get("/admin/sick-calls", response_model=list[SickCallPublic])
async def list_sick_calls(
    _: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
    status: str | None = Query(None),
    user_id: UUID | None = Query(None),
    from_date: datetime | None = Query(None),
    to_date: datetime | None = Query(None),
    sort_by: str = Query("date_desc"),
) -> list[SickCallPublic]:
    q = (
        select(StaffShift)
        .options(selectinload(StaffShift.user))
        .where(StaffShift.sick_call_status.is_not(None))
    )
    if status:
        q = q.where(StaffShift.sick_call_status == status)
    if user_id:
        q = q.where(StaffShift.user_id == user_id)
    if from_date:
        q = q.where(StaffShift.sick_called_at >= from_date)
    if to_date:
        q = q.where(StaffShift.sick_called_at <= to_date)
    if sort_by == "date_asc":
        q = q.order_by(StaffShift.sick_called_at.asc())
    else:
        q = q.order_by(StaffShift.sick_called_at.desc())
    result = await db.execute(q)
    shifts = list(result.scalars())
    rows = [await _serialize_sick_call(db, s) for s in shifts]
    if sort_by == "staff_name":
        rows.sort(key=lambda r: r.user.full_name.lower())
    return rows


@router.get("/admin/staff/{user_id}/upcoming-shifts", response_model=list[ShiftWithStaff])
async def list_staff_upcoming_shifts(
    user_id: UUID,
    _: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ShiftWithStaff]:
    """List upcoming scheduled shifts for a specific staff member.

    Used by the 'Call In Sick For Employee' form to let the admin pick which
    shift to cancel and record the reason for.
    """
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(StaffShift)
        .options(selectinload(StaffShift.user))
        .where(
            StaffShift.user_id == user_id,
            StaffShift.sick_call_status.is_(None),
            StaffShift.starts_at > now - timedelta(days=30),
        )
        .order_by(StaffShift.starts_at.asc())
    )
    shifts = list(result.scalars())
    return [ShiftWithStaff.model_validate(s) for s in shifts]


@router.post("/admin/sick-calls/{shift_id}/dismiss", response_model=SickCallPublic)
async def dismiss_sick_call(
    shift_id: UUID,
    body: DismissBody,
    manager: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> StaffShift:
    shift = await db.get(StaffShift, shift_id)
    if shift is None or shift.sick_call_status is None:
        raise HTTPException(404, "Sick call not found")
    if shift.sick_call_status != SICK_PENDING:
        raise HTTPException(409, "Sick call is no longer pending")

    shift.sick_call_status = SICK_DISMISSED
    # If a dismissal note arrives, append it so the caller's reason isn't lost.
    if body.note:
        prefix = (shift.sick_call_note + "\n\n") if shift.sick_call_note else ""
        shift.sick_call_note = f"{prefix}Manager: {body.note}"
    db.add(shift)
    await db.flush()
    await record_event(
        db,
        category="workforce",
        event_type="sick_call_dismissed",
        actor=manager.email,
        entity_table="staff_shifts",
        entity_id=shift.id,
        payload={"note": body.note},
    )
    await notifications.notify_sick_call_dismissed(db, shift, manager)
    await db.commit()
    return await _load_shift_with_user(db, shift.id)


@router.post("/admin/sick-calls/{shift_id}/open-offer", response_model=OpenOfferResult)
async def open_offer(
    shift_id: UUID,
    manager: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> OpenOfferResult:
    shift = await db.get(StaffShift, shift_id)
    if shift is None or shift.sick_call_status is None:
        raise HTTPException(404, "Sick call not found")
    if shift.sick_call_status not in (SICK_PENDING,):
        raise HTTPException(409, "Sick call is not pending review")
    # Guard against double-open: reject if an open offer already exists.
    existing = await db.execute(
        select(ShiftClaimOffer).where(
            ShiftClaimOffer.shift_id == shift.id,
            ShiftClaimOffer.claimed_by_user_id.is_(None),
            ShiftClaimOffer.cancelled_at.is_(None),
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "An open offer already exists for this shift")

    offer, candidates = await sick_call_svc.open_offer(db, shift=shift, opener=manager)
    await record_event(
        db,
        category="workforce",
        event_type="sick_call_offer_opened",
        actor=manager.email,
        entity_table="staff_shifts",
        entity_id=shift.id,
        payload={"candidate_count": len(candidates), "offer_id": str(offer.id)},
    )
    await db.commit()
    return OpenOfferResult(
        offer=await _load_offer(db, offer.id),
        candidate_count=len(candidates),
    )


@router.get("/admin/sick-calls/{shift_id}/offer", response_model=ClaimOfferPublic)
async def get_offer(
    shift_id: UUID,
    _: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ClaimOfferPublic:
    # Latest offer for this shift (claimed or not).
    result = await db.execute(
        select(ShiftClaimOffer)
        .where(ShiftClaimOffer.shift_id == shift_id)
        .order_by(ShiftClaimOffer.opened_at.desc())
        .limit(1)
    )
    offer = result.scalar_one_or_none()
    if offer is None:
        raise HTTPException(404, "No offer for this shift")
    return await _load_offer(db, offer.id)


@router.post("/admin/sick-calls/{shift_id}/cancel-offer", response_model=ClaimOfferPublic)
async def cancel_offer(
    shift_id: UUID,
    body: CancelOfferBody,
    manager: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ClaimOfferPublic:
    result = await db.execute(
        select(ShiftClaimOffer)
        .where(
            ShiftClaimOffer.shift_id == shift_id,
            ShiftClaimOffer.claimed_by_user_id.is_(None),
            ShiftClaimOffer.cancelled_at.is_(None),
        )
        .with_for_update()
    )
    offer = result.scalar_one_or_none()
    if offer is None:
        raise HTTPException(404, "No open offer to cancel")
    await sick_call_svc.cancel_offer(db, offer=offer, reason=body.reason)

    shift = await db.get(StaffShift, shift_id)
    if shift is not None:
        # Drop back to pending_review so manager can dismiss or re-open.
        shift.sick_call_status = SICK_PENDING
        db.add(shift)

    await record_event(
        db,
        category="workforce",
        event_type="sick_call_offer_cancelled",
        actor=manager.email,
        entity_table="staff_shifts",
        entity_id=shift_id,
        payload={"offer_id": str(offer.id), "reason": body.reason},
    )
    await db.commit()
    return await _load_offer(db, offer.id)


# ───────── Candidate: claim ─────────


@router.get("/shifts/claim/{token}/preview", response_model=ClaimPreview)
async def preview_claim(
    token: str,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ClaimPreview:
    """Lightweight read so the claim page can render shift details before POST.

    Unauthenticated — the claim_token itself (a 64-char random secret, one per
    candidate) is the credential, same trust model as the manager's one-click
    'Find a sub' email link. No login required so staff can act straight from
    the notification email/text on any device.
    """
    result = await db.execute(
        select(ShiftClaimCandidate).where(ShiftClaimCandidate.claim_token == token)
    )
    cand = result.scalar_one_or_none()
    if cand is None:
        raise HTTPException(404, "Claim link not recognised")
    offer = await db.get(ShiftClaimOffer, cand.offer_id)
    shift = await db.get(StaffShift, offer.shift_id) if offer else None
    if shift is None or offer is None:
        raise HTTPException(404, "Shift not found")
    return ClaimPreview(
        shift=ShiftPublic.model_validate(shift),
        expires_at=offer.expires_at,
        claimed=offer.claimed_by_user_id is not None,
        cancelled=offer.cancelled_at is not None,
        claim_is_yours=offer.claimed_by_user_id == cand.user_id,
    )


@router.post("/shifts/claim/{token}", response_model=ClaimResult)
async def claim_shift(
    token: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    background_tasks: BackgroundTasks,
) -> ClaimResult:
    """Unauthenticated claim — see preview_claim for the trust model.

    Notification emails (claimer confirmation, "shift filled" to the other
    candidates, manager heads-up) are sent as a background task AFTER the
    response is returned. A claim can fan out to half a dozen sequential
    Resend calls (one per other candidate) -- doing that inline made the
    claim POST slow enough to trip client-side request timeouts (reported
    as "Load failed" on mobile) even though the claim itself had already
    committed successfully.
    """
    result = await db.execute(
        select(ShiftClaimCandidate).where(ShiftClaimCandidate.claim_token == token)
    )
    cand = result.scalar_one_or_none()
    if cand is None:
        raise HTTPException(404, "Claim link not recognised")
    claimer = await db.get(User, cand.user_id)
    if claimer is None:
        raise HTTPException(404, "Claim link not recognised")

    try:
        shift, offer, opener = await sick_call_svc.accept_claim(db, token=token, claimer=claimer)
    except sick_call_svc.ClaimError as e:
        await db.rollback()
        raise HTTPException(e.status, e.message)

    await record_event(
        db,
        category="workforce",
        event_type="sick_call_offer_claimed",
        actor=claimer.email,
        entity_table="staff_shifts",
        entity_id=shift.id,
        payload={"claimer_id": str(claimer.id)},
    )
    await db.commit()

    async def _send_claim_emails() -> None:
        try:
            await notifications.notify_shift_claimed_claimer(db, claimer, shift)
            await notifications.notify_shift_claimed_other_candidates(db, offer, claimer, shift)
            if opener is not None:
                await notifications.notify_shift_filled_to_manager(db, claimer, shift, opener)
        except Exception:
            import logging as _log
            _log.getLogger(__name__).exception("claim_shift: background notification fan-out failed")

    background_tasks.add_task(_send_claim_emails)

    return ClaimResult(
        shift=ShiftPublic.model_validate(shift),
        message="You claimed the shift. Heads up to your manager.",
    )


# ───────── Sub tracker ─────────


@router.get("/admin/sick-calls/offer-history", response_model=list[SubHistoryEntry])
async def offer_history(
    _: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[SubHistoryEntry]:
    """Return all past offers with candidates and claimer for the sub tracker."""
    result = await db.execute(
        select(ShiftClaimOffer)
        .options(selectinload(ShiftClaimOffer.candidates))
        .order_by(ShiftClaimOffer.opened_at.desc())
        .limit(limit)
        .offset(offset)
    )
    offers = list(result.scalars())
    if not offers:
        return []

    shift_ids = list({o.shift_id for o in offers})
    shifts_q = await db.execute(select(StaffShift).where(StaffShift.id.in_(shift_ids)))
    shifts_by_id = {s.id: s for s in shifts_q.scalars()}

    user_ids: set = set()
    for o in offers:
        user_ids.add(o.opened_by_user_id)
        if o.claimed_by_user_id:
            user_ids.add(o.claimed_by_user_id)
        for c in o.candidates:
            user_ids.add(c.user_id)
    for s in shifts_by_id.values():
        user_ids.add(s.user_id)

    users_q = await db.execute(select(User).where(User.id.in_(user_ids)))
    users_by_id = {u.id: u for u in users_q.scalars()}

    def _mini(uid) -> StaffMini | None:
        u = users_by_id.get(uid)
        return StaffMini(id=u.id, full_name=u.full_name, email=u.email) if u else None

    entries: list[SubHistoryEntry] = []
    for o in offers:
        shift = shifts_by_id.get(o.shift_id)
        if not shift:
            continue
        sick_user = _mini(shift.user_id)
        opener = _mini(o.opened_by_user_id)
        if not sick_user or not opener:
            continue
        candidates = [m for c in o.candidates if (m := _mini(c.user_id))]
        entries.append(
            SubHistoryEntry(
                shift_id=o.shift_id,
                shift_starts_at=shift.starts_at,
                shift_ends_at=shift.ends_at,
                shift_location=shift.location,
                shift_role_label=shift.role_label,
                sick_user=sick_user,
                opened_by=opener,
                opened_at=o.opened_at,
                expires_at=o.expires_at,
                candidates=candidates,
                claimed_by=_mini(o.claimed_by_user_id) if o.claimed_by_user_id else None,
                claimed_at=o.claimed_at,
                cancelled=o.cancelled_at is not None,
            )
        )
    return entries


@router.get("/admin/sick-calls/sub-leaderboard", response_model=list[SubLeaderboardEntry])
async def sub_leaderboard(
    _: Annotated[User, Depends(require_capability("manage_schedule"))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[SubLeaderboardEntry]:
    """Per-staff counts: how often contacted and how many shifts claimed."""
    contact_q = await db.execute(
        select(ShiftClaimCandidate.user_id, func.count(ShiftClaimCandidate.id).label("cnt"))
        .group_by(ShiftClaimCandidate.user_id)
    )
    contact_by_user: dict = {row[0]: row[1] for row in contact_q.all()}

    claim_q = await db.execute(
        select(ShiftClaimOffer.claimed_by_user_id, func.count(ShiftClaimOffer.id).label("cnt"))
        .where(ShiftClaimOffer.claimed_by_user_id.is_not(None))
        .group_by(ShiftClaimOffer.claimed_by_user_id)
    )
    claim_by_user: dict = {row[0]: row[1] for row in claim_q.all()}

    all_user_ids = set(contact_by_user) | set(claim_by_user)
    if not all_user_ids:
        return []

    users_q = await db.execute(select(User).where(User.id.in_(all_user_ids)))
    users = list(users_q.scalars())

    entries = [
        SubLeaderboardEntry(
            user=StaffMini(id=u.id, full_name=u.full_name, email=u.email),
            times_contacted=contact_by_user.get(u.id, 0),
            shifts_claimed=claim_by_user.get(u.id, 0),
        )
        for u in users
    ]
    entries.sort(key=lambda e: (-e.shifts_claimed, -e.times_contacted))
    return entries


# ───────── Unauthenticated email action: one-click "Find a sub" ─────────


def _action_page(title: str, body: str, color: str = "#c97a5a") -> HTMLResponse:
    """Minimal mobile-friendly response page for one-click email actions."""
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} — Northbound Ops</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #faf9f7; color: #3a3028; display: flex;
         align-items: center; justify-content: center;
         min-height: 100vh; padding: 24px; }}
  .card {{ background: #fff; border-radius: 12px; padding: 36px 32px;
           max-width: 420px; width: 100%;
           box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; }}
  .icon {{ font-size: 48px; margin-bottom: 16px; }}
  h1 {{ font-size: 22px; font-weight: 700; color: {color}; margin-bottom: 12px; }}
  p {{ font-size: 15px; line-height: 1.6; color: #7a6e65; }}
  .platform {{ margin-top: 24px; font-size: 13px; color: #aaa; }}
  a {{ color: {color}; text-decoration: none; }}
</style>
</head>
<body>
<div class="card">
  {body}
  <p class="platform"><a href="/">Northbound Ops Platform</a></p>
</div>
</body>
</html>"""
    return HTMLResponse(content=html)


@router.get("/sick-call-action/{token}", include_in_schema=False)
async def sick_call_email_action(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """One-click 'Find a sub' from manager sick-call notification emails.

    Unauthenticated — validated by a single-use SickCallActionToken tied to
    a specific manager. On success calls open_offer as that manager. Concurrent
    clicks are handled gracefully: the second click sees the offer already open
    and returns an 'already handled' page.
    """
    now = datetime.now(timezone.utc)

    result = await db.execute(
        select(SickCallActionToken).where(SickCallActionToken.token == token)
    )
    action_token = result.scalar_one_or_none()

    if action_token is None:
        return _action_page(
            "Link not found",
            '<div class="icon">🔍</div>'
            "<h1>Link not found</h1>"
            "<p>This link doesn't match any sick-call action. It may have been copied incorrectly.</p>",
            color="#888",
        )

    if now > action_token.expires_at:
        return _action_page(
            "Link expired",
            '<div class="icon">⏰</div>'
            "<h1>Link expired</h1>"
            "<p>This link is no longer valid. The shift has already started or the 24-hour window has passed.</p>"
            "<p style='margin-top:12px'>Open the platform to manage sick calls directly.</p>",
            color="#888",
        )

    if action_token.used_at is not None:
        return _action_page(
            "Already handled",
            '<div class="icon">✅</div>'
            "<h1>Already handled</h1>"
            "<p>This link has already been used. Staff have been contacted about covering the shift.</p>",
            color="#4caf50",
        )

    shift = await db.get(StaffShift, action_token.shift_id)
    if shift is None:
        return _action_page(
            "Shift not found",
            '<div class="icon">🔍</div>'
            "<h1>Shift not found</h1>"
            "<p>The shift associated with this link no longer exists.</p>",
            color="#888",
        )

    if shift.sick_call_status in (SICK_FILLING, SICK_FILLED):
        return _action_page(
            "Already being handled",
            '<div class="icon">✅</div>'
            "<h1>Already being handled</h1>"
            "<p>Another manager already opened the offer for this shift. Staff are being contacted.</p>",
        )

    # Check if an open offer already exists (race with another manager's click).
    existing_offer = (await db.execute(
        select(ShiftClaimOffer).where(
            ShiftClaimOffer.shift_id == shift.id,
            ShiftClaimOffer.claimed_by_user_id.is_(None),
            ShiftClaimOffer.cancelled_at.is_(None),
        )
    )).scalar_one_or_none()
    if existing_offer is not None:
        action_token.used_at = now
        db.add(action_token)
        await db.commit()
        return _action_page(
            "Already being handled",
            '<div class="icon">✅</div>'
            "<h1>Already being handled</h1>"
            "<p>Another manager already opened the offer for this shift. Staff are being contacted.</p>",
        )

    manager = await db.get(User, action_token.manager_user_id)
    if manager is None:
        return _action_page(
            "Error",
            '<div class="icon">⚠️</div>'
            "<h1>Something went wrong</h1>"
            "<p>The manager account linked to this token could not be found.</p>",
            color="#e57373",
        )

    # Stamp used_at before open_offer so a concurrent click sees it as used.
    action_token.used_at = now
    db.add(action_token)
    await db.flush()

    try:
        _, candidates = await sick_call_svc.open_offer(db, shift=shift, opener=manager)
        await record_event(
            db,
            category="workforce",
            event_type="sick_call_offer_opened",
            actor=manager.email,
            entity_table="staff_shifts",
            entity_id=shift.id,
            payload={"candidate_count": len(candidates), "via": "email_action_token"},
        )
        await db.commit()
    except Exception:
        await db.rollback()
        return _action_page(
            "Error",
            '<div class="icon">⚠️</div>'
            "<h1>Something went wrong</h1>"
            "<p>We couldn't open the offer. Please open the platform and try from the sick-call queue.</p>",
            color="#e57373",
        )

    if not candidates:
        return _action_page(
            "No candidates available",
            '<div class="icon">😔</div>'
            "<h1>No available candidates</h1>"
            "<p>There are no eligible, unscheduled staff members to contact for this shift.</p>"
            "<p style='margin-top:12px'>You may need to reach out directly.</p>",
            color="#888",
        )

    count = len(candidates)
    word = "person" if count == 1 else "people"
    return _action_page(
        "Offer sent",
        f'<div class="icon">📨</div>'
        f"<h1>Offer sent!</h1>"
        f"<p><strong>{count} {word}</strong> {'has' if count == 1 else 'have'} been emailed about the shift. "
        f"You'll be notified once someone claims it.</p>",
        color="#c97a5a",
    )


# ───────── helpers ─────────


async def _load_offer(db: AsyncSession, offer_id: UUID) -> ClaimOfferPublic:
    """Hydrate an offer with its candidates and each candidate's user mini."""
    result = await db.execute(
        select(ShiftClaimOffer)
        .options(selectinload(ShiftClaimOffer.candidates))
        .where(ShiftClaimOffer.id == offer_id)
    )
    offer = result.scalar_one()
    cand_list: list[CandidatePublic] = []
    for c in offer.candidates:
        u = await db.get(User, c.user_id)
        cand_list.append(
            CandidatePublic(
                id=c.id,
                user_id=c.user_id,
                emailed_at=c.emailed_at,
                notified_filled_at=c.notified_filled_at,
                user={
                    "id": u.id if u else c.user_id,
                    "full_name": u.full_name if u else "(deleted)",
                    "email": u.email if u else "",
                },
            )
        )
    return ClaimOfferPublic(
        id=offer.id,
        shift_id=offer.shift_id,
        opened_by_user_id=offer.opened_by_user_id,
        opened_at=offer.opened_at,
        expires_at=offer.expires_at,
        claimed_by_user_id=offer.claimed_by_user_id,
        claimed_at=offer.claimed_at,
        cancelled_at=offer.cancelled_at,
        cancel_reason=offer.cancel_reason,
        candidates=cand_list,
    )
