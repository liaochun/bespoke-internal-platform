# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"""Email-notification dispatch helpers.

Wraps the transactional `send_email` service with per-user opt-in checks
against `user_notification_prefs`. Every call is best-effort: failures
are logged and swallowed so the underlying workforce mutation
(shift create/update/cancel, time-off decision, punch correction
decision) is never aborted by a broken email pipeline.

Templates are inline HTML — short, scannable, and link back to the
relevant /me/* page on the web origin.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.notification_prefs import UserNotificationPrefs
from app.models.user import User
from app.services.email import send_email

settings = get_settings()
log = logging.getLogger(__name__)


async def _get_or_create_prefs(
    db: AsyncSession, user_id: UUID
) -> UserNotificationPrefs:
    """Fetch the user's prefs row, creating a default-true row on miss.

    We commit nothing here — caller's transaction owns it. If a caller
    is in the middle of a mutation, the prefs row gets persisted with
    the rest of the unit of work."""
    prefs = await db.get(UserNotificationPrefs, user_id)
    if prefs is None:
        prefs = UserNotificationPrefs(user_id=user_id)
        db.add(prefs)
        await db.flush()
    return prefs


def _fmt_dt_safe(dt: datetime) -> str:
    """Render a tz-aware UTC datetime in the app's local timezone.

    %-d / %-I aren't portable across platforms (no Windows support), so
    we fall back to zero-padded with a manual strip."""
    if dt.tzinfo is None:
        return dt.isoformat()
    tz = ZoneInfo(settings.app_timezone)
    local = dt.astimezone(tz)
    try:
        return local.strftime("%a %b %-d, %Y · %-I:%M %p")
    except ValueError:
        return local.strftime("%a %b %d, %Y · %I:%M %p")


def _deep_link(path: str) -> str:
    base = settings.web_origin.rstrip("/")
    suffix = path if path.startswith("/") else f"/{path}"
    return f"{base}{suffix}"


# TEMPORARY (per explicit request): non-production environments have fake
# test user accounts with no real inbox, so every notification email is
# redirected here instead, tagged with who it was really for -- lets a real
# person see exactly what each notification looks like without needing a
# separate "would have sent" UI indicator yet. Remove this override (and
# just log the would-have-sent case) once that's built, or once real test
# inboxes exist in staging.
_DEV_EMAIL_OVERRIDE = "dev-override@northboundops.example"

# Notifications that fan out to many recipients (every manager on a sick
# call, every eligible candidate on a shift offer) share one subject line
# per event. Redirecting every one of those to the same single dev inbox
# means one test action produces a wall of near-duplicate emails. Instead,
# batch every call sharing a subject within a short window, then send ONE
# real email (the first recipient's version, as a representative sample)
# with a footer listing every user who would have received it.
_DEV_BATCH_WINDOW_SECONDS = 2.0
_dev_pending_batches: dict[str, dict] = {}  # subject -> {"to": str, "html": str, "recipients": list[str]}


async def _flush_dev_batch(subject: str) -> None:
    await asyncio.sleep(_DEV_BATCH_WINDOW_SECONDS)
    batch = _dev_pending_batches.pop(subject, None)
    if batch is None:
        return
    recipients = batch["recipients"]
    footer = (
        "<hr style='margin-top:24px'>"
        "<p style='color:#888;font-size:12px'>[DEV] This notification would have been sent to "
        f"{len(recipients)} user(s): {', '.join(recipients)}</p>"
    )
    dev_subject = f"[DEV — {len(recipients)} recipient(s)] {subject}"
    try:
        ok = await send_email(to=_DEV_EMAIL_OVERRIDE, subject=dev_subject, html=batch["html"] + footer)
        if not ok:
            log.warning("dev-batched notification email NOT sent subject=%r recipients=%s", subject, recipients)
        else:
            log.info("dev-batched notification email sent subject=%r recipients=%s", subject, recipients)
    except Exception:
        log.exception("dev-batched notification email crashed subject=%r recipients=%s", subject, recipients)


async def _safe_send(*, to: str, subject: str, html: str) -> None:
    """Wrap send_email so a transport-level error never propagates."""
    original_to = to
    redirected = settings.environment.lower() != "production"
    if redirected:
        batch = _dev_pending_batches.get(subject)
        if batch is None:
            _dev_pending_batches[subject] = {"to": original_to, "html": html, "recipients": [original_to]}
            asyncio.create_task(_flush_dev_batch(subject))
        else:
            batch["recipients"].append(original_to)
        return
    try:
        ok = await send_email(to=to, subject=subject, html=html)
        if not ok:
            log.warning("notification email NOT sent to=%s subject=%r", original_to, subject)
        else:
            log.info("notification email sent to=%s subject=%r", original_to, subject)
    except Exception:
        log.exception("notification email crashed to=%s subject=%r", original_to, subject)


# ── Shift category ────────────────────────────────────────────────────


async def notify_shift_assigned(
    db: AsyncSession,
    *,
    user: User,
    starts_at: datetime,
    ends_at: datetime,
    location: str,
    role_label: str | None,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_shift_assigned:
        return
    role_line = f"<p><strong>Role:</strong> {role_label}</p>" if role_label else ""
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>A new shift has been scheduled for you.</p>"
        f"<p><strong>When:</strong> {_fmt_dt_safe(starts_at)} → {_fmt_dt_safe(ends_at)}</p>"
        f"<p><strong>Location:</strong> {location}</p>"
        f"{role_line}"
        f"<p><a href=\"{_deep_link('/me/schedule')}\">View your schedule</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject="Shift assigned",
        html=html,
    )


async def notify_shift_changed(
    db: AsyncSession,
    *,
    user: User,
    starts_at: datetime,
    ends_at: datetime,
    location: str,
    role_label: str | None,
    summary: str,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_shift_changed:
        return
    role_line = f"<p><strong>Role:</strong> {role_label}</p>" if role_label else ""
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>One of your shifts was updated. Changes: {summary}.</p>"
        f"<p><strong>When:</strong> {_fmt_dt_safe(starts_at)} → {_fmt_dt_safe(ends_at)}</p>"
        f"<p><strong>Location:</strong> {location}</p>"
        f"{role_line}"
        f"<p><a href=\"{_deep_link('/me/schedule')}\">View your schedule</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject="Shift updated",
        html=html,
    )


async def notify_shift_cancelled(
    db: AsyncSession,
    *,
    user: User,
    starts_at: datetime,
    ends_at: datetime,
    location: str,
    permanent: bool = False,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_shift_cancelled:
        return
    word = "removed" if permanent else "cancelled"
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>Your shift on <strong>{_fmt_dt_safe(starts_at)}</strong> "
        f"at {location} has been {word}.</p>"
        f"<p><a href=\"{_deep_link('/me/schedule')}\">View your schedule</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject=f"Shift {word}",
        html=html,
    )


# ── Request decisions (time off + punch corrections) ──────────────────


async def notify_time_off_decision(
    db: AsyncSession,
    *,
    user: User,
    approved: bool,
    start_date,
    end_date,
    reviewer_note: str | None,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_request_decisions:
        return
    verb = "approved" if approved else "denied"
    note_block = (
        f"<p><strong>Note from manager:</strong> {reviewer_note}</p>"
        if reviewer_note
        else ""
    )
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>Your time off request for "
        f"<strong>{start_date.isoformat()} → {end_date.isoformat()}</strong> "
        f"has been <strong>{verb}</strong>.</p>"
        f"{note_block}"
        f"<p><a href=\"{_deep_link('/me/time-off')}\">View your time off</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject=f"Time off {verb}",
        html=html,
    )


async def notify_punch_correction_decision(
    db: AsyncSession,
    *,
    user: User,
    approved: bool,
    request_type: str,
    reviewer_note: str | None,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_request_decisions:
        return
    verb = "approved" if approved else "denied"
    note_block = (
        f"<p><strong>Note from manager:</strong> {reviewer_note}</p>"
        if reviewer_note
        else ""
    )
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>Your punch correction request "
        f"(<em>{request_type}</em>) has been <strong>{verb}</strong>.</p>"
        f"{note_block}"
        f"<p><a href=\"{_deep_link('/me/hours')}\">View your hours</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject=f"Punch correction {verb}",
        html=html,
    )


async def notify_time_off_modification_decision(
    db: AsyncSession,
    *,
    user: User,
    approved: bool,
    original_start,
    original_end,
    new_start,
    new_end,
    reviewer_note: str | None,
) -> None:
    if not user.email:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_request_decisions:
        return
    verb = "approved" if approved else "denied"
    note_block = (
        f"<p><strong>Note from manager:</strong> {reviewer_note}</p>"
        if reviewer_note
        else ""
    )
    html = (
        f"<p>Hi {user.full_name.split(' ')[0]},</p>"
        f"<p>Your time off modification request "
        f"(was <strong>{original_start.isoformat()} → {original_end.isoformat()}</strong>, "
        f"now <strong>{new_start.isoformat()} → {new_end.isoformat()}</strong>) "
        f"has been <strong>{verb}</strong>.</p>"
        f"{note_block}"
        f"<p><a href=\"{_deep_link('/me/time-off')}\">View your time off</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject=f"Time off modification {verb}",
        html=html,
    )


# ── Sick-call + shift-claim ───────────────────────────────────────────


def _local(dt: datetime) -> str:
    """Short local-time formatter for sick-call email bodies."""
    return _fmt_dt_safe(dt)


async def _managers_for_schedule(db: AsyncSession) -> list[User]:
    """All active users whose effective capabilities include manage_schedule."""
    from sqlalchemy import select

    from app.services.capabilities import compute_effective_capabilities

    result = await db.execute(select(User).where(User.is_active.is_(True)))
    out: list[User] = []
    for u in result.scalars():
        caps = await compute_effective_capabilities(db, u)
        if "manage_schedule" in caps:
            out.append(u)
    return out


async def notify_sick_call_to_managers(db: AsyncSession, shift) -> None:
    """Email every manager when a staff member calls in sick.

    Each email includes a one-click 'Find a sub' button that triggers the
    open-offer flow without requiring the manager to log into the platform.
    A unique SickCallActionToken is created per manager and embedded in their
    personal email link — tokens are single-use and expire with the shift.
    """
    try:
        from app.models.sick_call import SickCallActionToken

        caller = await db.get(User, shift.user_id)
        if caller is None:
            return
        managers = await _managers_for_schedule(db)

        # One action token per manager — generated and flushed before sending
        # so the URLs are ready when we compose the emails.
        now = datetime.now(timezone.utc)
        token_expires = min(shift.starts_at, now + timedelta(hours=24))
        manager_tokens: dict[UUID, str] = {}
        for m in managers:
            raw = secrets.token_urlsafe(32)[:64]
            db.add(SickCallActionToken(
                shift_id=shift.id,
                manager_user_id=m.id,
                token=raw,
                expires_at=token_expires,
            ))
            manager_tokens[m.id] = raw
        await db.flush()

        subject = f"Sick call: {caller.full_name} — {_local(shift.starts_at)}"
        note_html = (
            f"<p><strong>Note from {caller.full_name.split(' ')[0]}:</strong> "
            f"{shift.sick_call_note}</p>"
            if shift.sick_call_note
            else ""
        )
        api_base = settings.api_origin_url

        for m in managers:
            raw_token = manager_tokens.get(m.id, "")
            action_url = f"{api_base}/sick-call-action/{raw_token}" if raw_token else ""
            find_sub_btn = (
                f'<p style="margin-top:20px">'
                f'<a href="{action_url}" style="display:inline-block;padding:12px 24px;'
                f'background:#c97a5a;color:#fff;text-decoration:none;border-radius:6px;'
                f'font-weight:600;font-size:15px;">Find a sub</a></p>'
                f'<p style="margin-top:6px;font-size:12px;color:#999;">'
                f'Sends the shift to all eligible, unscheduled staff. First to reply wins.</p>'
            ) if action_url else ""
            html = (
                f"<p><strong>{caller.full_name}</strong> called in sick for "
                f"<strong>{_local(shift.starts_at)} → {_local(shift.ends_at)}</strong> "
                f"({shift.location}).</p>"
                f"{note_html}"
                f"{find_sub_btn}"
                f"<p style='margin-top:16px'>"
                f"<a href=\"{_deep_link('/admin/sick-calls')}\">Open sick-call queue</a></p>"
            )
            await _safe_send(to=m.email, subject=subject, html=html)
    except Exception:
        log.exception("notify_sick_call_to_managers: top-level failure")


async def notify_sick_call_dismissed(db: AsyncSession, shift, manager: User) -> None:
    """Email the sick caller that their sick-call was dismissed (shift stays cancelled)."""
    try:
        caller = await db.get(User, shift.user_id)
        if caller is None:
            return
        subject = f"Sick call closed for {_local(shift.starts_at)}"
        html = (
            f"<p>Hi {caller.full_name.split(' ')[0]},</p>"
            f"<p>Your sick call for the shift on <strong>{_local(shift.starts_at)} → "
            f"{_local(shift.ends_at)}</strong> was closed by {manager.full_name}. "
            f"The shift remains cancelled. Feel better soon.</p>"
        )
        await _safe_send(to=caller.email, subject=subject, html=html)
    except Exception:
        log.exception("notify_sick_call_dismissed: top-level failure")


async def notify_shift_offer_to_candidates(
    db: AsyncSession, offer, candidates, shift
) -> None:
    """Send the tokenized claim link to each eligible candidate."""
    try:
        subject = f"Shift up for grabs — {_local(shift.starts_at)}"
        for c in candidates:
            user = await db.get(User, c.user_id)
            if user is None or not user.email:
                continue
            link = _deep_link(f"/shifts/claim/{c.claim_token}")
            html = (
                f"<p>Hi {user.full_name.split(' ')[0]},</p>"
                f"<p>A shift just opened up that you're eligible for:</p>"
                f"<p><strong>{_local(shift.starts_at)} → {_local(shift.ends_at)}</strong>"
                f" — {shift.location}"
                f"{(' · ' + shift.role_label) if shift.role_label else ''}</p>"
                f"<p>First to claim wins. Tap below to take it:</p>"
                f"<p><a href=\"{link}\">Claim this shift</a></p>"
                f"<p>Offer expires {_local(offer.expires_at)}.</p>"
            )
            await _safe_send(to=user.email, subject=subject, html=html)
    except Exception:
        log.exception("notify_shift_offer_to_candidates: top-level failure")


async def notify_shift_claimed_claimer(
    db: AsyncSession, claimer: User, shift
) -> None:
    try:
        if not claimer.email:
            return
        subject = f"You picked up the shift — {_local(shift.starts_at)}"
        html = (
            f"<p>Hi {claimer.full_name.split(' ')[0]},</p>"
            f"<p>You claimed the shift on <strong>{_local(shift.starts_at)} → "
            f"{_local(shift.ends_at)}</strong> ({shift.location}). It's on "
            f"<a href=\"{_deep_link('/me/schedule')}\">your schedule</a> now. Thanks!</p>"
        )
        await _safe_send(to=claimer.email, subject=subject, html=html)
    except Exception:
        log.exception("notify_shift_claimed_claimer: top-level failure")


async def notify_shift_claimed_other_candidates(
    db: AsyncSession, offer, claimer: User, shift
) -> None:
    """Tell every other candidate that the shift is gone — skip the claimer.
    Also bumps each notified candidate's notified_filled_at column."""
    try:
        from datetime import timezone as _tz
        from sqlalchemy import select

        from app.models.sick_call import ShiftClaimCandidate

        result = await db.execute(
            select(ShiftClaimCandidate).where(ShiftClaimCandidate.offer_id == offer.id)
        )
        subject = f"Shift filled — {_local(shift.starts_at)}"
        now = datetime.now(tz=_tz.utc)
        for c in result.scalars():
            if c.user_id == claimer.id:
                continue
            user = await db.get(User, c.user_id)
            if user is None or not user.email:
                continue
            html = (
                f"<p>Hi {user.full_name.split(' ')[0]},</p>"
                f"<p>The shift on <strong>{_local(shift.starts_at)} → "
                f"{_local(shift.ends_at)}</strong> has been claimed by "
                f"{claimer.full_name}. Thanks for being on standby!</p>"
            )
            await _safe_send(to=user.email, subject=subject, html=html)
            c.notified_filled_at = now
            db.add(c)
    except Exception:
        log.exception("notify_shift_claimed_other_candidates: top-level failure")


async def notify_shift_filled_to_manager(
    db: AsyncSession, claimer: User, shift, opener: User
) -> None:
    """Tell the manager who opened the offer that the shift is filled."""
    try:
        if not opener.email:
            return
        subject = f"Shift filled by {claimer.full_name} — {_local(shift.starts_at)}"
        html = (
            f"<p><strong>{claimer.full_name}</strong> claimed the open shift on "
            f"<strong>{_local(shift.starts_at)} → {_local(shift.ends_at)}</strong> "
            f"({shift.location}).</p>"
            f"<p>You opened this offer. Other candidates have been notified.</p>"
        )
        await _safe_send(to=opener.email, subject=subject, html=html)
    except Exception:
        log.exception("notify_shift_filled_to_manager: top-level failure")


async def notify_bulk_shifts_assigned(
    db: AsyncSession,
    *,
    user: User,
    shifts: list[tuple[datetime, datetime, str, str | None]],
) -> None:
    """Send a single digest email listing all newly-created shifts for `user`.

    `shifts` is a list of (starts_at, ends_at, location, role_label) tuples,
    all in UTC. Respects the notify_shift_assigned preference.
    """
    if not user.email or not shifts:
        return
    prefs = await _get_or_create_prefs(db, user.id)
    if not prefs.notify_shift_assigned:
        return

    tz = ZoneInfo(settings.app_timezone)

    def _fmt_shift(starts_at: datetime, ends_at: datetime, location: str, role_label: str | None) -> str:
        local_start = starts_at.astimezone(tz)
        local_end = ends_at.astimezone(tz)
        day = local_start.strftime("%A, %B")
        try:
            day += f" {local_start.strftime('%-d')}"
        except ValueError:
            day += f" {local_start.strftime('%d').lstrip('0') or '0'}"
        try:
            t_start = local_start.strftime("%-I:%M %p")
            t_end = local_end.strftime("%-I:%M %p")
        except ValueError:
            t_start = local_start.strftime("%I:%M %p").lstrip("0") or local_start.strftime("%I:%M %p")
            t_end = local_end.strftime("%I:%M %p").lstrip("0") or local_end.strftime("%I:%M %p")
        line = f"{day} · {t_start} – {t_end} @ {location}"
        if role_label:
            line += f" ({role_label})"
        return line

    shift_items = "".join(
        f"<li style='margin:4px 0'>{_fmt_shift(s, e, loc, role)}</li>"
        for s, e, loc, role in shifts
    )
    first_name = user.full_name.split(" ")[0]
    count = len(shifts)
    noun = "shift" if count == 1 else "shifts"
    html = (
        f"<p>Hi {first_name},</p>"
        f"<p>{count} new {noun} have been added to your schedule:</p>"
        f"<ul style='padding-left:20px'>{shift_items}</ul>"
        f"<p><a href=\"{_deep_link('/me/schedule')}\">View your full schedule</a></p>"
    )
    await _safe_send(
        to=user.email,
        subject="Your new shifts at Northbound Ops",
        html=html,
    )


