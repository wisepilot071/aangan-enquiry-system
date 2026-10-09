# Vaani AI integration

**Status: implemented from the official docs (https://docs.vaanivoice.ai) and verified against the real API for authentication, agent creation and configuration. Not yet verified on a real phone call** — no phone number is linked to the agent, so neither an inbound nor an outbound call has happened.

## What was verified against the live account (9 Oct 2026)

| Check | Result |
|---|---|
| `GET /api/agents` with the key / without a key | 200 (empty list) / 401 |
| `POST /api/create-agent` + `PATCH …/persona`, `…/analysis`, `…/experience` | Succeeded; read-back confirms the humble prompt, greeting and 25 extraction data points; Vaani returned **no warnings** |
| `GET /api/call-history` | Returned HTTP 500 ("Invalid client_id format") for this account — a Vaani-side fault. The adapter treats call history as best-effort, so cost simply stays *unknown* if it fails |
| Phone routing (`deployment_config`) | Empty — **no number is linked** |
| A real call (inbound or outbound) | **Not performed** |

Surprises relative to the docs (handled in code): `create-agent` returns the full agent object (with `agent_id`, no `success` flag); webhook payloads carry **no event id, no timestamp, no signature**; `call_ended` arrives **before** `call_postprocessing` (the only event with transcript/entities); `call_duration` is seconds in one and milliseconds in the other; `call_cost` is in **credits**, not rupees.

## What was built

| Piece | File |
|---|---|
| API client (only documented endpoints) | `src/modules/voice-provider/vaani-client.ts` |
| Agent definition: prompt, greeting, 25 extraction fields | `vaani-agent-config.ts`, applied by `npm run vaani:setup` |
| Webhook + transcript + entity mapping | `vaani-mapper.ts` |
| Provider adapter (auth, parse, enrich from API) | `vaani.ts` |
| Outbound test call + manual "import call" | `telephony-events/outbound.ts`, `/api/calls/outbound`, `/api/calls/sync`, page **Vaani calls** |

**Qualification stays server-side.** The voice model only converses and extracts raw answers. After the call, the extracted fields are mapped to facts, validated, and decided by the same rules engine (`qualified.md`). The agent's prompt carries the approved pricing sentence verbatim, but a voice model cannot be intercepted mid-call, so the guarantee is *prompt + post-call audit*: every agent line is scanned for price-like statements and booking/callback/transfer promises; a hit flags the enquiry for human review with priority raised and an audit event. A hard guarantee would need Vaani's Bring-Your-Own-LLM server (all speech routed through this app's guardrail) — not built.

## How webhooks are authenticated (Vaani has no signature)

1. A long random secret (`VAANI_WEBHOOK_TOKEN`) must be present in the webhook URL (`?token=…`), or in an `x-webhook-token` / Bearer header. Compared in constant time; missing/wrong ⇒ 401, recorded without the payload.
2. For `call_postprocessing`, transcript, entities and summary are **re-fetched from Vaani's authenticated `call_details` API** and replace the webhook's body, so a forged payload cannot inject content for a real call. If the API is unreachable the token-protected webhook data is used.
3. Caveat: the token travels in the URL, which hosting platforms may log. Rotate it if exposed (change the env var and the URL in Vaani).

## Setup steps

1. `.env`: `VOICE_PROVIDER=vaani`, `VAANI_API_KEY`, `VAANI_WEBHOOK_TOKEN` (see `.env.example`).
2. `npm run vaani:setup` — creates/updates the agent, prints `VAANI_AGENT_ID` (idempotent; re-run after editing the prompt).
3. **Vaani dashboard → Settings → Telephony**: provision a number (or connect a SIP trunk) and link it to the agent. *Not available through the API.*
4. **Vaani dashboard → Settings → Webhooks**: add `https://<your-app>/api/webhooks/voice?token=<VAANI_WEBHOOK_TOKEN>`.
5. Optional: `PATCH /api/agent/{id}/deployment` with `{"deployment":{"phone":{"call_type":{"Inbound":"+91…"}}}}` if the dashboard linking does not set inbound routing.
6. Call the number, then check **Enquiries**, **System status**, and the enquiry's timing and cost.

## Placing a call

**Vaani calls** page (live mode, operator/admin): name + number in E.164 + consent tick + browser confirmation → `POST /api/trigger-call/` with `dnd_check_skipped:false`. Limits: 5 per 10 minutes per user; audit log stores a masked number. The call is recorded as **outbound**: stored, costed, never qualified, never counted as an enquiry. The agent greets as a test call (`modify_agent`). Requires a number linked to the agent; if Vaani refuses, its message is shown.

Without a public webhook (local development), press **Import call** with the Vaani call id: the app pulls transcript/entities/cost itself (idempotent).

## Known gaps

* **First-response time is unmeasurable**: Vaani sends no first-agent-speech timestamp. Realtime events carry only our receipt time (labelled as such); call duration comes from Vaani's `call_duration`.
* **Inbound semantics unconfirmed**: whether `call_started.phone_number` is the caller's number for inbound calls, and whether inbound `room_name` equals `call_id`, is not documented. The adapter uses `data.room_name` consistently; confirm on the first real call.
* `call_cost` is credits; it is shown separately from ₹ and never converted. Vaani's price per credit is not documented, so no ₹ estimate is made (an admin may enter a verified ₹ rate on the Costs page).
* Human transfer is not configured; the agent is told never to promise one.
* Language: English default; Hindi/Marathi replies are requested in the prompt but **untested**.
* Recording URLs in webhooks are ignored and not stored.
