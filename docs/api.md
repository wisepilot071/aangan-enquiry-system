# HTTP API

JSON over HTTPS. Private endpoints require the `aangan_session` cookie (HttpOnly, SameSite=Lax, Secure in production). Mutations also reject cross-origin browsers. Roles: `viewer` (read), `operator` (+ transcripts, operate), `admin` (+ settings).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | Status of database, provider (mock/live/pending), Telegram configured; no customer data or secrets. 503 when the database is down |
| `POST /api/webhooks/voice` | signature | Provider events (see below) |
| `POST /api/auth/login` · `/logout` | — | Session. 8 attempts / 5 min per client+email, identical error for unknown user vs wrong password |
| `GET /api/metrics?scope=demo\|production&from=&to=` | viewer | All dashboard metrics + daily series. `scope` defaults to `demo` in mock mode, `production` in live mode — **never mixed** |
| `GET /api/enquiries` | viewer | Filters: `q, disposition, callStatus, notificationStatus, review, projectCategory, location, from, to, sort, page, pageSize (≤100)` |
| `GET /api/enquiries/{id}` | viewer | Detail; transcript only for operator/admin |
| `PATCH /api/enquiries/{id}` | operator | `humanReviewStatus, consultationStatus, conversionStatus, projectValueInr (only with converted), disposition+reason`. Strict schema; audited |
| `POST /api/notifications/{id}/retry` | operator | Only for `failed`/`unavailable` (409 otherwise) |
| `POST /api/tasks/{id}/complete` | operator | Close a follow-up task |
| `GET/PUT /api/settings/cost-rates` | viewer / **admin** | Verified unit rates; a rate requires a `source` |
| `GET /api/scenarios` · `POST /api/simulate` | viewer / operator | Mock mode only (403 in live mode). Creates DEMO records |
| `POST /api/calls/outbound` | operator | Live Vaani mode only. `{contactNumber (E.164), name, consent:true}` → real outbound **test** call; 5 per 10 min per user |
| `POST /api/calls/sync` | operator | Live Vaani mode only. `{callId}` → imports a finished call from Vaani's API; idempotent |

Errors are `{ "error": "<code>" }` (+ `issues[]` for validation). Bodies are capped (64 KB; webhooks 256 KB). Payload contents are never echoed back or stored on rejection.

## Webhook contract (internal, provider-neutral)

A real adapter maps the provider's verified payloads to this shape (`ProviderEventSchema`):

```jsonc
{
  "eventId": "optional-unique-id",          // dedupe key; if absent, sha256(body) is used
  "type": "call.started | call.responded | call.completed | call.missed | call.disconnected | call.failed",
  "providerCallId": "string",                // one enquiry per (provider, providerCallId)
  "occurredAt": "2026-09-02T04:53:00.000Z",  // ISO-8601 with offset
  "fromNumber": "+91…", "toNumber": "+91…",   // verified caller metadata
  "startedAt": "…", "endedAt": "…", "durationSec": 252,
  "firstAgentResponseAt": "…",               // only if the provider reports it — never inferred
  "transcript": [{ "role": "agent|caller", "text": "…" }],
  "structuredFacts": { /* validated against FactsSchema; invalid ⇒ ignored + human review */ },
  "summary": "…", "cost": { "amount": 12.5, "currency": "INR" }, "failureReason": "…"
}
```

**Order of checks:** size limit → signature (fail closed, 401) → JSON/schema validation (400) → idempotency → processing. Out-of-order delivery is tolerated; terminal states never regress. A failed processing attempt returns 500 and **is retried** when the provider redelivers the same event id. Duplicates return 200 `{"status":"duplicate"}`.

### Mock provider signature (our own scheme — not Vaani's)

Vaani webhooks are authenticated differently: `POST /api/webhooks/voice?token=<VAANI_WEBHOOK_TOKEN>` (or `x-webhook-token` / Bearer header) — see [vaani-integration.md](vaani-integration.md).

Headers `x-mock-timestamp` (ms) and `x-mock-signature` = hex `HMAC-SHA256(MOCK_WEBHOOK_SECRET, "<timestamp>.<rawBody>")`; 5-minute replay window, constant-time compare. Without `MOCK_WEBHOOK_SECRET` the endpoint rejects everything.

```bash
body='{"eventId":"demo-1","type":"call.missed","providerCallId":"demo-call-1","occurredAt":"2026-10-01T05:00:00.000Z","fromNumber":"+919900012345"}'
ts=$(node -e "console.log(Date.now())")
sig=$(node -e "console.log(require('crypto').createHmac('sha256',process.env.MOCK_WEBHOOK_SECRET).update('$ts.'+process.argv[1]).digest('hex'))" "$body")
curl -X POST http://localhost:3000/api/webhooks/voice -H "x-mock-timestamp: $ts" -H "x-mock-signature: $sig" -d "$body"
```
