# Telegram designer hand-off

Telegram is the notification channel; **the database is the system of record**, so an enquiry exists even if Telegram is down.

## Setup (5 minutes, no code changes)

1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Create a group for designers, add the bot, and send any message in the group.
3. Find the group's **chat id**: open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id` (group ids are negative).
4. Put both in `.env` (or your host's secret store):
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
5. Restart. **System status** now shows "Telegram configured". The first *real* qualified call (or an operator **Retry delivery**) is the first real send — configuration alone proves nothing, so test it with one controlled call before relying on it.

Never commit the token. It is only used to build the request URL and is never logged, stored in a notification record, or included in an error.

## Messages

* **New qualified enquiry** — only for `QUALIFIED`: ID, time (IST), caller, phone, project, location, scope, area, timeline, site readiness, decision-maker status, uncertainties, requested next step, source. A link to the login-protected enquiry page is added only if `APP_BASE_URL` is set.
* **Urgent escalation** — for complaints/"speak to a person": priority, type, caller, project reference, who was asked for, summary, and an explicit reminder that **no callback time was promised**.
* **Missed / disconnected call** — time and number; states that no transcript exists and no automatic callback is made.

Never included: pricing data, the caller's budget figure, full transcripts, secrets. Rejected leads are never sent.

## Delivery behaviour

| Situation | Result |
|---|---|
| Sent | `sent`, Telegram message id stored, `notified_at` set |
| 5xx / network / timeout | retried up to 3× with exponential backoff |
| 429 | waits the `retry_after` (capped at 30 s) then retries |
| 400/401/403/404 | **permanent** — not retried |
| Still failing | `failed` + a `failed_handoff` task in the Urgent queue; the enquiry is untouched |
| No credentials | `unavailable` + task ("hand off manually") |
| Demo/mock enquiry | `mock_sent` — shown as **SIMULATED — not delivered**; never reaches Telegram, even if credentials exist |

Duplicates are prevented by a unique `(enquiry, category)` key, so a replayed webhook cannot send a second handoff. Operators (or admins) can press **Retry delivery** on a failed/unavailable notification.

## Tested vs untested

Tested with mocked HTTP: success, retries, backoff, rate limit, permanent errors, timeouts, token never leaking. **Not tested against the real Telegram service.**
