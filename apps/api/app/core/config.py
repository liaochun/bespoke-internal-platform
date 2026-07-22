# Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
import logging
from functools import lru_cache
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

_WEAK_SECRET_VALUES: frozenset[str] = frozenset(
    {"", "change-me", "dev-only-change-me-with-secrets-token-urlsafe-48"}
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "local"
    log_level: str = "INFO"
    api_secret_key: str = ""

    database_url: str = "postgresql+asyncpg://northbound:northbound_dev_pw@postgres:5432/northbound_ops"
    redis_url: str = "redis://redis:6379/0"

    app_timezone: str = "America/Toronto"

    # OAuth + auth
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    allowed_google_domain: str = "northboundops.example"
    oauth_redirect_uri: str = "http://localhost:8000/auth/google/callback"
    # Primary web origin. Additional origins may be added via
    # ALLOWED_WEB_ORIGINS (comma-separated). Hosted envs auto-include the
    # canonical ops.northboundops.example / dev-ops.northboundops.example — see main.py.
    web_origin: str = "http://localhost:3000"
    allowed_web_origins: str = ""

    # Session JWT
    session_cookie_name: str = "northbound_session"
    session_max_age_seconds: int = 60 * 60 * 24 * 7  # 7 days
    session_cookie_secure: bool = False  # True in prod
    # Cookie domain (e.g. ".northboundops.example" in hosted envs so api + web share
    # the cookie). Empty → host-only cookie, the right default for localhost.
    session_cookie_domain: str = ""
    jwt_algorithm: str = "HS256"

    # First-login auto-promotion to super_admin (comma-separated emails)
    bootstrap_super_admin_emails: str = ""

    resend_api_key: str = ""
    email_from: str = "ops@northboundops.example"

    # Recipients for unhandled-exception alert emails (comma-separated).
    # Falls back to bootstrap_super_admin_emails when unset -- see
    # app/services/error_tracking.py.
    error_alert_emails: str = ""
    # Minimum time between repeat alert emails for the same (exception
    # type + path) fingerprint, so a recurring failure pages once, not
    # once per request.
    error_alert_throttle_minutes: int = 30

    # File storage backend for uploads (discipline forms, attachments, etc).
    # `local` writes to /app/uploads (ephemeral on Render — fine for non-critical
    # blobs in staging). `supabase` is the prod target — see app/services/storage.py.
    storage_backend: str = "local"
    storage_local_dir: str = "/app/uploads"
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_storage_bucket: str = "northbound-uploads"

    # Shopify webhooks — paste the secret from your Shopify webhook settings.
    # Each `SHOPIFY_LOCATION_*` maps a Shopify location_id (numeric, as a string)
    # to one of our internal location names ("toronto" / "wavecrest" / etc).
    shopify_webhook_secret: str = ""
    shopify_location_toronto: str = ""
    shopify_location_wavecrest: str = ""
    shopify_default_location: str = "toronto"

    # ── Shopify Admin API (Phase C: 2-way CA finished SKU sync) ────────
    # Outbound writes target the Inventory REST API. Set:
    #   SHOPIFY_SHOP_DOMAIN=demo-shop.myshopify.com
    #   SHOPIFY_ADMIN_API_TOKEN=shpat_...
    # Outbound is in shadow mode by default — no HTTP calls are made,
    # actions are only logged. Flip SHOPIFY_INVENTORY_PUSH_ENABLED=true
    # after reconciler drift is < 0.5% for 7 days.
    shopify_shop_domain: str = ""
    shopify_admin_api_token: str = ""
    shopify_admin_api_version: str = "2024-10"
    shopify_inventory_push_enabled: bool = False
    # OAuth credentials for Dev Dashboard apps (Partners flow)
    shopify_client_id: str = ""
    shopify_client_secret: str = ""

    # ── Drift reconciler scheduler ─────────────────────────────────────
    reconciler_enabled: bool = False
    reconciler_interval_minutes: int = 60
    reconciler_drift_tolerance: int = 0

    # ── Shopify US auto-sync scheduler ─────────────────────────────────
    shopify_us_sync_enabled: bool = False
    shopify_us_sync_interval_minutes: int = 30

    # ── Unpaid breaks ──────────────────────────────────────────────────
    # When enabled, CLOSED break_start→break_end durations are deducted from
    # worked/payroll totals (breaks become unpaid). Default OFF: totals are
    # byte-for-byte identical to today (breaks effectively paid). Env var
    # UNPAID_BREAKS_ENABLED. Open/in-progress breaks are never deducted.
    unpaid_breaks_enabled: bool = False

    # ── Sales aggregation scheduler ────────────────────────────────────
    sales_aggregator_enabled: bool = False
    sales_aggregator_interval_minutes: int = 720
    sales_aggregator_lookback_days: int = 7

    # ── Tardiness report scheduler ─────────────────────────────────────
    # Emails a weekly tardiness summary to admin/managers every Monday at 8am
    # Toronto time. Idempotent per ISO week via app_config. Enabled by default.
    tardiness_report_enabled: bool = True
    stat_holiday_reminder_enabled: bool = True

    # ── PIPS digest scheduler ──────────────────────────────────────────
    # Emails a weekly summary of staff flagged for PIPS review every Monday
    # at 8am Toronto time, only if at least one person was flagged that
    # week. Replaces the old real-time per-flag email. Enabled by default.
    pips_digest_enabled: bool = True

    # ── Timesheet dispatch scheduler ───────────────────────────────────
    # Emails the completed semi-monthly pay period CSV to accountant-role
    # users on the 8th (covers 22nd prev month → 7th) and the 22nd (covers
    # 8th → 21st), Toronto time. Idempotent per period via app_config.
    timesheet_dispatch_enabled: bool = True
    timesheet_dispatch_check_minutes: int = 60
    # Comma-separated extra recipient emails beyond accountant-role users.
    timesheet_dispatch_extra_recipients: str = ""

    # ── Auto clock-out scheduler (#e18f33a6) ───────────────────────────────
    # When enabled, inserts a CLOCK_OUT punch (marked auto_clocked_out=True)
    # for any user who is still clocked in 60+ minutes after their scheduled
    # shift end time. The clock-out is backdated to the shift end time.
    # A system-generated PunchCorrectionRequest (add_punch) is also created
    # so managers see a pending review item in the corrections queue.
    # Set AUTO_CLOCKOUT_ENABLED=true in Render to activate.
    auto_clockout_enabled: bool = False
    # How often the scheduler polls, in seconds (default 15 minutes).
    auto_clockout_check_interval_seconds: int = 900
    # How many minutes past shift end before auto clock-out fires (default 60).
    auto_clockout_grace_minutes: int = 60

    # ── Auto-break scheduler ───────────────────────────────────────────────
    # When enabled, inserts BREAK_START punches automatically for clocked-in
    # staff at the configured break times. Employees must manually clock back
    # in (insert BREAK_END). Open breaks at clock-out are auto-closed.
    # Set AUTO_BREAK_ENABLED=true in Render to activate.
    auto_break_enabled: bool = False
    # Lunch break fires at clock_in + auto_break_lunch_offset_hours. Duration in minutes.
    auto_break_lunch_offset_hours: float = 4.0
    auto_break_lunch_duration_minutes: int = 30
    # Afternoon break fires at a fixed HH:MM in app_timezone. Duration in minutes.
    auto_break_afternoon_time: str = "15:30"
    auto_break_afternoon_duration_minutes: int = 15
    # How often the scheduler polls, in seconds.
    auto_break_check_interval_seconds: int = 300

    # ── Scheduler replica guard ────────────────────────────────────────────────
    # Set SCHEDULERS_DISABLED=true on every replica beyond the first to prevent
    # duplicate scheduler execution across processes.
    # Full fix: implement Redis SETNX leader election (see TODO in main.py).
    schedulers_disabled: bool = False

    # ── Kiosk device restriction ───────────────────────────────────────────────
    # When set to any non-empty value, staff-role users can only authenticate
    # from a device that a manager/admin has paired via
    # POST /kiosk/admin/devices/pair (which sets a signed, HttpOnly
    # `northbound_kiosk_device` cookie on that browser — see
    # app/services/kiosk_auth.py issue_device_token()/verify_device_token()).
    # This value itself is now just the on/off flag; it is no longer compared
    # against a client-supplied device_id (that comparison was forgeable —
    # see go-live audit finding re: kiosk device binding). Managers and above
    # bypass the restriction entirely. Leave empty (default) to allow any
    # device.
    kiosk_central_device_id: str = ""

    # Public URL of the API service itself — used to build tokenized action links
    # inside notification emails (e.g. the one-click "Find a sub" button). Set
    # API_ORIGIN to the Render service URL in hosted environments. Falls back to
    # deriving the origin from oauth_redirect_uri if not set.
    api_origin: str = ""

    @property
    def api_origin_url(self) -> str:
        if self.api_origin:
            return self.api_origin.rstrip("/")
        from urllib.parse import urlparse
        parsed = urlparse(self.oauth_redirect_uri)
        return f"{parsed.scheme}://{parsed.netloc}"

    # Airtable — used for the migration sync (Phase 1: pull only, Phase 2: push).
    # API key is a Personal Access Token from https://airtable.com/create/tokens
    # with `data.records:read` (and later `data.records:write`) scope on the base.
    airtable_api_key: str = ""
    airtable_base_id: str = ""
    airtable_items_table: str = "Master Items"
    # KILL-SWITCH: push to Airtable is disabled by default. Airtable is the
    # source of truth — we never write back unless the operator opts in by
    # setting AIRTABLE_PUSH_ENABLED=true. Local edits still save to our DB.
    airtable_push_enabled: bool = False
    # When true, manual log-in and log-out from the ops platform creates new
    # records in Airtable's Incoming/Outgoing Transactions tables so Airtable's
    # formula-based inventory levels reflect the change. Requires push scope on
    # the PAT (data.records:write). Defaults OFF until explicitly enabled.
    airtable_transaction_write_enabled: bool = False
    # Auto-sync: pulls every N minutes in the background. Disabled by default.
    # Default 60 minutes — matches production setting. Kept conservative to
    # avoid high egress if the env var is ever removed from Render.
    airtable_auto_sync_enabled: bool = False
    airtable_auto_sync_interval_minutes: int = 60
    # Webhook receiver shared secret. External trigger (Make/Zapier/Airtable
    # automation) must send this in `X-Airtable-Webhook-Secret`. Empty disables
    # the endpoint — we won't accept unauthenticated triggers.
    airtable_webhook_secret: str = ""

    @property
    def bootstrap_super_admin_email_set(self) -> set[str]:
        return {
            e.strip().lower()
            for e in self.bootstrap_super_admin_emails.split(",")
            if e.strip()
        }

    @property
    def is_hosted(self) -> bool:
        return self.environment.lower() in {"staging", "production"}

    @model_validator(mode="after")
    def _warn_weak_secret(self) -> "Settings":
        """Log a warning in non-hosted envs when API_SECRET_KEY is missing or weak.

        Does NOT raise so local dev without a .env still starts (albeit loudly).
        Hosted envs are handled by _validate_hosted_secrets which raises.
        """
        if not self.is_hosted and self.api_secret_key in _WEAK_SECRET_VALUES:
            logger.warning(
                "API_SECRET_KEY is not set or is a well-known placeholder value. "
                "All JWTs will be signed with a weak key. "
                "Set API_SECRET_KEY in your .env file before running the server."
            )
        return self

    @model_validator(mode="after")
    def _validate_hosted_secrets(self) -> "Settings":
        if not self.is_hosted:
            return self
        errors: list[str] = []
        if self.api_secret_key in _WEAK_SECRET_VALUES:
            errors.append("API_SECRET_KEY must be set to a strong random value in hosted environments")
        if not self.google_oauth_client_id:
            errors.append("GOOGLE_OAUTH_CLIENT_ID is required in hosted environments")
        if not self.google_oauth_client_secret:
            errors.append("GOOGLE_OAUTH_CLIENT_SECRET is required in hosted environments")
        if self.shopify_inventory_push_enabled and not self.shopify_admin_api_token:
            errors.append("SHOPIFY_ADMIN_API_TOKEN is required when SHOPIFY_INVENTORY_PUSH_ENABLED=true")
        if self.airtable_auto_sync_enabled and not self.airtable_api_key:
            errors.append("AIRTABLE_API_KEY is required when AIRTABLE_AUTO_SYNC_ENABLED=true")
        if self.airtable_auto_sync_enabled and not self.airtable_base_id:
            errors.append("AIRTABLE_BASE_ID is required when AIRTABLE_AUTO_SYNC_ENABLED=true")
        if errors:
            raise ValueError("Hosted environment misconfiguration:\n" + "\n".join(f"  - {e}" for e in errors))
        return self

    @property
    def allowed_web_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_web_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
