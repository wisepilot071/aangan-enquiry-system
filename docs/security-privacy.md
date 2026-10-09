# Security and privacy

## Controls implemented (and tested)

| Area | Control |
|---|---|
| Authentication | Email + password (scrypt, per-user salt, constant-time compare). Session = HS256 JWT in an **HttpOnly, SameSite=Lax** cookie (**Secure** in production), 8 h, forged/expired tokens rejected. Login rate-limited; identical response for unknown user vs wrong password |
| Authorisation | Server-side role matrix on every route: `viewer` read-only, `operator` + transcripts + operations, `admin` + settings. Pages call `requireUser`; APIs call `apiUser`. Cross-origin mutations rejected |
| Webhooks | Mock: HMAC signature + replay window. Vaani (no documented signature): secret token (constant-time, fail closed) and call data re-fetched from Vaani's authenticated API. Size cap; schema validation; idempotency; rate limiting (300/min/IP); rejected requests are recorded **without storing their content**. The token is in the URL, which hosts may log — rotate if exposed |
| Outbound calls | Operator/admin only; E.164 validation; explicit consent flag + browser confirmation; Vaani's Do-Not-Disturb check left on; 5 per 10 min per user; masked number in the audit log |
| Live-call guardrails | The voice model cannot be intercepted mid-call, so every agent line is audited after the call for price-like statements and booking/callback/transfer promises (flag + human review + audit event) |
| Secrets | Env vars only; `.env` is git-ignored; startup validation; bot token never logged/stored/returned; audit logger redacts keys like token/secret/password/authorization/signature |
| Data exposure | `/api/health` is minimal. No private endpoint is public. Pricing guide is not in the repository, bundle or any API. Telegram messages exclude transcripts, pricing and secrets |
| Injection | Drizzle parameterised queries; `%`/`_` stripped from LIKE searches; React escaping; Telegram sent as plain text (no `parse_mode`) |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store` |
| Logging | Structured JSON for unhandled errors, message-only (≤120 chars), no payloads, no full phone numbers |

## Open-access mode

`AUTH_MODE=open` removes the sign-in entirely (the production site was switched to it at the owner's request). Everyone then shares one identity with `OPEN_ACCESS_ROLE` (default **viewer**: read-only; no transcripts, no outbound calls, no cost-rate changes, no status edits). Anyone with the URL can still see caller names, phone numbers and project details. The webhook stays protected by its token. Set `AUTH_MODE=login` to restore sign-in. If you raise the role to `operator`, anyone can place calls on your Vaani credits — keep it at viewer unless the URL is private.

## What data is stored

Per call: provider call id, caller phone **from call metadata**, name (if given), project facts (type, locality, area, scope, timeline, authority), volunteered budget, qualification evidence, consultation status, transcript (restricted), summary, notification records, cost records, audit events. **Not stored:** audio recordings, payment data, email, ID documents. Referral *names* are not retained (only "personal referral" / "Instagram" etc.).

Phone numbers are masked in lists (`+91•••••123`), shown in full only on the detail page and in Telegram hand-offs (designers need to call).

## Who can access

| Data | viewer | operator | admin |
|---|:--:|:--:|:--:|
| Metrics, lists, structured details, qualification rationale | ✓ | ✓ | ✓ |
| Transcripts | – | ✓ | ✓ |
| Change status / retry / close tasks | – | ✓ | ✓ |
| Cost rates | read | read | edit |
| Database / host / secrets | – | – | infrastructure owner |

There is no in-app user-management UI (documented limitation): create users with SQL or extend `scripts/seed.ts`.

## Retention, deletion, recordings — **proposed, needs Nikhil's approval**

* **Recordings:** **not enabled and not requested from the provider.** Enable only after legal review of consent/disclosure obligations. The agent already identifies itself as a virtual assistant.
* **Transcripts:** proposed default **180 days**, then `npm run privacy -- purge-transcripts 180` (schedule it weekly). Structured records (without free text) are kept for reporting.
* **Enquiry records:** proposed 24 months. A person can ask for deletion: `npm run privacy -- delete <uuid> --confirm` removes the enquiry and its notifications, costs, tasks and assessments, detaches provider events, and leaves only an audit line with the reference (no personal data).
* **Provider data use:** unknown until the provider is chosen — confirm that call content is not used for model training and where it is stored. **Telegram** messages contain name and phone; the designer chat should have only authorised members.
* Retention automation is **not** scheduled by the app; a cron/scheduler must call the purge command.

## Known gaps

* No MFA, password reset, or per-user lockout beyond the rate limiter; sessions are not individually revocable (rotate `SESSION_SECRET` to revoke all).
* Rate limiters are in-memory (per process) — put a reverse proxy/WAF limit in front for multi-instance deployments.
* Dependencies were not formally security-audited (`npm audit` is part of the go-live checklist).
* Telegram messages are not end-to-end encrypted (Telegram bot chats are cloud chats).
