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

## Messages (what designers receive)

Every call taken by the AI produces **one** Telegram message, so designers always know what happened and what to do next:

| Message | When | Contains |
|---|---|---|
| **NEW QUALIFIED ENQUIRY** | the call passed Nikhil's checks | ID, time (IST), caller, phone, project, location, scope, area, timeline, site readiness, who decides, open questions, requested next step, **what happened**, **next action** |
| **CALL UPDATE** | every other completed call (closed as not a fit, declined, needs a person, nothing captured) | outcome, **why**, **what happened**, whether a consultation was asked for (never "booked"), **next action** |
| **URGENT ESCALATION** | complaint / "I want a person" | priority, who was asked for, summary, next action, and a reminder that no callback time was promised |
| **MISSED / DISCONNECTED CALL** | nobody was reached | time, number, no transcript exists |
| **CONSULTATION SCHEDULED** | a person confirms a consultation on the dashboard (Enquiry → Operator actions → Scheduled + date/time → *Save & notify*) | date and time (IST), who/where, **Add to Google Calendar** link, next action |

The AI alone never schedules anything: a consultation is only announced as scheduled after a person records it. Saving the same time again does not repeat the message; changing the time announces the new one. A requested-but-unconfirmed consultation is always labelled "NOT booked yet".

Never included: pricing data, **any money figure** (a budget the caller mentioned is replaced by "[amount]"; it stays on the dashboard), full transcripts, secrets. A link to the enquiry page is added when `APP_BASE_URL` is set.

### Making the bot answer (so it doesn't look broken)

Send `/start` (or any message) to the bot: it replies with its purpose and **this chat's ID**, and says whether this chat is the connected one. This works through a webhook registered with `npm run telegram:webhook -- https://<your-app>/api/telegram/webhook` (authenticated by Telegram's secret-token header, derived from the bot token). While a webhook is set, Telegram's `getUpdates` is disabled by design; the chat id is read from the reply or the dashboard's audit log (`telegram.chat_seen`).

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

## Google Calendar scheduling (automatic, after a qualified call)

When a call is **QUALIFIED**, the app places a **tentative** 60-minute design consultation on the studio's Google Calendar and sends the designer a Telegram message ("DESIGN CONSULTATION PENCILLED IN") with the calendar event link.

* The **caller is not promised a time** on the call (the agent only says the team will confirm). The enquiry stays "requested" until a person confirms it on the dashboard.
* Slot rule (defaults, to be confirmed with Nikhil): next free hour Mon–Sat, 10 AM–7 PM IST, at least 24 hours ahead, within 14 days, avoiding existing events.
* One event per enquiry (idempotent). If Google fails, the designer gets a "NOT SCHEDULED AUTOMATICALLY" message with the reason and schedules manually.

### One-time Google setup
1. Google Cloud Console → create/select a project → enable **Google Calendar API**.
2. IAM → Service accounts → create one → Keys → **Add key → JSON** (download).
3. In Google Calendar, share the studio calendar with the service account's `client_email` using **Make changes to events**.
4. Copy the calendar's ID (Calendar settings → Integrate calendar).
5. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON or base64) and `GOOGLE_CALENDAR_ID` in `.env` and in Vercel (as sensitive variables). Never commit the key.
