# Requirements → implementation → tests

Seed files (all four read in full): `services.md` and `qualified.md` are copied unchanged into `knowledge/` (parsed at runtime for the service-area list); `pricing.md` is intentionally **not** copied (its only usable content is one fixed sentence, hard-coded and verified by `npm run verify:seed`); `Aangan_Sep 2026_Enquiries.pdf` — Section 1 (T01–T20, phone) is the regression set in `src/modules/demo/phone-scenarios.ts`; WhatsApp (W01–W10) and web-form (F01–F10) items were used only to understand rules and are **not** counted as phone calls.

| Requirement | Module | Tests |
|---|---|---|
| Service catalogue & full service-area list (not just examples) | `business-knowledge/service-area.ts` | `rules.test.ts › service area` |
| Five criteria, states, evidence, precedence | `qualification/criteria.ts`, `engine.ts` | `rules.test.ts` (boundary rules), `phone-scenarios.test.ts` |
| Timeline: services vs qualified distinction, boundaries | `criteria.ts › assessTimeline`, `policy.ts` | `rules.test.ts › timeline policy` |
| Budget: only if volunteered, never probed, obvious mismatch only | `criteria.ts › assessBudget` | `rules.test.ts › budget rule`, T10 |
| Authorised representative / unclear authority | `assessDecisionMaker` | `rules.test.ts`, T05/T14/T15 |
| Exact pricing response, repeats, injection, no leaks | `pricing-guardrails`, `conversation/session.ts` | `rules.test.ts › pricing guardrail`, `ingest.test.ts › notification previews`, e2e |
| Existing-client complaint → urgent escalation | `engine.detectEscalation`, `ingest.ts` | `rules.test.ts`, `ingest.test.ts`, T09, e2e |
| Missed / disconnected / failed calls; reconnect linking | `ingest.ts` | `ingest.test.ts › missed, disconnected…` |
| Provider abstraction, mock, pending Vaani, fail-closed | `voice-provider/*` | `ingest.test.ts`, `platform.test.ts` |
| Webhook security: signature, replay, size, malformed, dedupe | `mock.ts`, `ingest.ts`, webhook route | `ingest.test.ts`, `api.test.ts`, e2e |
| Telegram adapter: formats, retries, dedupe, retry, no secrets | `notifications/*` | `platform.test.ts`, `ingest.test.ts › Telegram delivery` |
| Cost: actual/estimated/unknown, never zero | `costs`, schema check constraint | `metrics.test.ts`, `db.test.ts`, `ingest.test.ts` |
| Metrics formulas, honest empty states | `analytics/metrics.ts` | `metrics.test.ts`, `api.test.ts › metrics equal DB`, e2e |
| Dashboard, auth, roles, transcript restriction | `app/(app)/*`, `authentication` | `api.test.ts`, e2e |
| Audit trail, secret redaction | `audit` | `ingest.test.ts › audit`, `platform.test.ts` |
| Invalid AI/provider structured output | `qualifyCompletedCall` | `ai-safety.test.ts`, `platform.test.ts` |
| Database failure | `lib/http.ts › safe` | `api.test.ts › database connection loss` |
| Retention / deletion | `enquiries/privacy.ts` | `privacy.test.ts` |
| Mock-mode experience, DEMO labelling, no contamination | simulator, `is_demo` columns, scope handling | `api.test.ts`, e2e |

## Required regression scenarios (brief §13.4) — coverage

| Scenario | Where |
|---|---|
| Qualified full-home, Kothrud · suitable large residential · villa · Magarpatta | T01 · T05 · T12 · T20 |
| Customer asks price · repeated pricing · injection | T02, T13 · `rules.test.ts` · e2e |
| Nashik · advice only · restaurant · small commercial (180 sq ft) | T03 · T04 · T19 · T18 |
| Commercial office, Baner | T06 |
| Unrealistic 3-week deadline | T07 |
| Missed call after hours | T08 → `ingest.test.ts` missed call |
| Existing-client complaint wanting senior person | T09 |
| Volunteered insufficient budget · budget undisclosed | T10 · T01/T20 |
| Rented apartment | T11 |
| Frustrated repeat caller | T16 |
| Disconnected call then reconnection | T17 → `ingest.test.ts` reconnect |
| Authorised/represented owner | T14, T15 |
| Unclear location · unclear timeline · asks for a human | `platform.test.ts › conversation edge cases` |
| Voice-provider failure · Telegram failure | `ingest.test.ts` (`call.failed`, Telegram section) |
| Duplicate completion webhook · malformed event · missing cost | `ingest.test.ts`, `api.test.ts`, `metrics.test.ts` |

T17 is split into its two calls: the first (dropped, 72 s, no transcript) and the second (completed, `T17b`).

## Unknowns and external dependencies

Exact Vaani product/API/credentials/number routing (blocked); real Telegram bot; real provider timestamps and cost reporting; PostgreSQL host; legal position on recording; Nikhil's decisions listed in [business-rules.md](business-rules.md#decisions-needed-from-nikhil).
