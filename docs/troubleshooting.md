# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid configuration: …` at start | A variable failed validation (message names it). `VOICE_PROVIDER` must be `mock` or `vaani`; `SESSION_SECRET` ≥ 32 chars |
| `DATABASE_URL is required in production` | `next start` runs with `NODE_ENV=production`. Set `DATABASE_URL` (PostgreSQL). For local demos use `npm run dev` |
| `SESSION_SECRET is required in production` | Set a 32+ char secret |
| Can't sign in | Run `npm run db:seed` (prints a dev password once). If the admin exists the script does nothing — reset by deleting `./data/pglite` in dev, or insert a new user hash (`npm run admin:hash`) |
| Dev page reloads endlessly / `Compiled in 1ms` repeating | A stale `.next` folder (e.g. after `npm run build`, or after switching `NEXT_DIST_DIR`) confused the dev server. Stop it, delete `.next`, start again |
| Signed out after every restart (dev) | No `SESSION_SECRET` set — a random per-process key is used. Set one in `.env` |
| `Another next dev server is already running` | Stop the other dev server in this folder (or set `NEXT_DIST_DIR`) |
| Dashboard empty | You are looking at the other scope. In mock mode use **Demo data**; production stays empty until real calls arrive. Run a call in **Call simulator** |
| Simulator link missing / `simulator_disabled_in_live_mode` | Simulator exists only when `VOICE_PROVIDER=mock`, and needs operator/admin role |
| Webhook returns 401 | (`vaani`) `?token=` missing/wrong or `VAANI_WEBHOOK_TOKEN` unset; (`mock`) signature missing/stale or `MOCK_WEBHOOK_SECRET` unset. The reason is in the response and in `call_events.error_category` |
| Webhook returns 400 | Malformed JSON or payload doesn't match the event schema (see [api.md](api.md)) |
| Webhook returns 503 | Database unreachable. Providers should retry; check `GET /api/health` |
| Telegram status `unavailable` | Token/chat id not set. After configuring, press **Retry delivery** on the enquiry |
| Telegram status `failed` | Look at the error category on the notification: `telegram_http_401/403/404` = wrong token / bot not in chat / wrong chat id; 5xx/timeouts retried 3× already. Fix, then **Retry delivery** |
| "SIMULATED — not delivered" | Expected for demo enquiries; they never reach Telegram |
| Response-time cards show N/A / "unmeasurable" | The provider supplied no first-response timestamp (always the case in the simulator with "no timestamp"). Nothing is guessed |
| Cost shows "Unknown" | No provider cost and no verified rate. Add rates (admin) — only affects new calls |
| A call is `HUMAN_REVIEW` unexpectedly | The call ended while a clarification was open, the provider's structured output was invalid, or no usable data was received. Reasons are listed on the enquiry |
| Windows: tsx script cannot find `.env` | Scripts use `--env-file-if-exists=.env` (Node 20.6+) |
| E2E test fails to start | Ports 3199 must be free; the test builds into `.next-e2e` (git-ignored); first run compiles pages and can take a minute |
| Place call → "No phone number is assigned…" / `vaani_rejected` | No number is linked to the agent. Vaani dashboard → Settings → Telephony, then link it to the agent |
| Place call → `vaani_auth` | The API key is wrong/revoked. Update `VAANI_API_KEY` |
| Place call → `agent_not_configured` | Run `npm run vaani:setup` and set `VAANI_AGENT_ID` |
| Call happened but nothing appears locally | Vaani cannot reach `localhost`. Use **Vaani calls → Import call** with the call id, or deploy and register the webhook |
| Vaani call-history returns 500 | A Vaani-side fault seen on the first account; cost then shows "unknown" (never guessed) |
| Enquiry flagged "GUARDRAIL: …" | The agent's transcript contained a price-like statement or a booking/callback/transfer promise. Read the transcript, then tighten the prompt in `vaani-agent-config.ts` and re-run `npm run vaani:setup` |
