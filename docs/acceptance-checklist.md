# Acceptance checklist

Legend: **PASS** verified with evidence · **BLOCKED** needs an external dependency · **FAIL** not satisfied · **NOT TESTED** not verified.
Verification run: 9 Oct 2026, Windows 11, Node 24.

## Commands actually run (final state)

| Command | Result |
|---|---|
| `npm ci` (clean copy without `node_modules`/`.next`/`data`/`.env`) | succeeded |
| `npm run lint` | 0 errors |
| `npm run typecheck` | 0 errors |
| `npm test` | **12 files, 220 tests passed, 0 failed, 0 skipped** (unit, integration, HTTP end-to-end) |
| `npm run build` | succeeded (20 routes) |
| `npm run db:seed` / `db:migrate` / `privacy` | ran; admin created; usage printed |
| `npm run verify:seed` | 5/5 PASS (knowledge files identical to supplied; approved sentence verbatim in `pricing.md`; `pricing.md` not in repo) |
| Same sequence in the clean copy | lint, typecheck, 176 tests (at that time), build, seed all passed |
| Browser check (dev server) | Sign-in, overview, urgent queue, enquiry list filter, enquiry detail, call simulator (desktop and 375 px mobile) rendered and worked |
| Secret / pricing-figure scan of `src`, `knowledge`, `scripts`, `docs`, `tests`; client-bundle grep | no secrets; no pricing figures; budget floors absent from browser bundle |

## External integrations

| Integration | Status |
|---|---|
| Vaani AI voice provider | **Implemented from docs.vaanivoice.ai; credentials work; agent created and configured (read-back verified).** Webhook mapping, auth, enrichment, outbound and sync are tested with mocked HTTP. **Not tested on a real call** (no number linked). Webhooks have no Vaani signature: protected by a secret URL token |
| Telephony number / call routing | **BLOCKED** — a number must be provisioned and linked to the agent in the Vaani dashboard (not possible via the API) |
| Telegram | **Implemented, awaiting credentials.** Tested with mocked HTTP only (never against Telegram) |
| PostgreSQL production database | Code path implemented (node-postgres + migrator); **NOT TESTED** against a real server (tests use PGlite, a real Postgres engine) |
| Mock provider / simulator | **Implemented and tested** |

## Business correctness

| Criterion | Status | Evidence |
|---|---|---|
| Service catalogue respected; full service-area list used | PASS | Parsed from `services.md`; `rules.test.ts › service area` |
| Five qualification criteria match Nikhil's rubric | PASS | `rules.test.ts` boundary tests; T01–T20 regression (`phone-scenarios.test.ts`) |
| Timeline ambiguities handled explicitly | PASS | Policy in `policy.ts`; boundary tests at 5.9/6/10 weeks; documented in business-rules.md |
| No pricing number ever disclosed | PASS (for the implemented agent) | Fixed response, output filter, injection/repeat tests, no `pricing.md` in repo/bundle. **Not tested** against a real LLM/provider prompt (none connected) |
| Existing-client complaints escalate urgently | PASS | T09, `ingest.test.ts`, e2e |
| Missed and failed calls recorded accurately | PASS | `ingest.test.ts` (no invented transcript; task; no outbound callback) |
| Out-of-scope channels not implemented | PASS | No WhatsApp/web/outbound code; DB check `channel = 'phone'` |

## Functional correctness

| Criterion | Status | Evidence |
|---|---|---|
| Events processed through the provider abstraction | PASS | Mock provider; signed webhook e2e |
| Mock mode works without credentials | PASS | Clean-copy run; `config` tests; e2e boots with no Telegram/DB URL |
| Qualified enquiries generate a handoff attempt | PASS | `ingest.test.ts` (mock_sent / sent / unavailable paths) |
| Unqualified enquiries are not forwarded | PASS | T03/T04/T10/T18/T19 assertions |
| Urgent complaints generate an escalation attempt | PASS | T09 |
| Notification status tracked | PASS | statuses `pending/sent/failed/unavailable/mock_sent`, attempts, errors |
| Costs categorised honestly | PASS | actual / estimated / unknown; NULL for unknown enforced by DB constraint |
| Dashboard data from persisted records | PASS | `api.test.ts` compares API to SQL counts; e2e checks overview HTML |
| Real call → Telegram → designer, end to end | **BLOCKED** | needs Vaani + Telegram |

## Reliability

| Criterion | Status | Evidence |
|---|---|---|
| Duplicate webhooks idempotent | PASS | replay ×3, new event id for a completed call, out-of-order delivery |
| Invalid payloads rejected safely | PASS | malformed JSON, schema errors, oversize, bad signature, stale timestamp |
| Provider failures don't silently destroy records | PASS | `call.failed`, processing-failure retry path, rejected events logged |
| Telegram failures don't destroy enquiries | PASS | transient/rate-limit/permanent/unavailable tests; operator retry |
| Database loss → safe response | PASS | route returns 503, health 503 |
| Missing costs remain unknown | PASS | tests + constraint |
| Incomplete information never invented | PASS | `ai-safety.test.ts` |
| Provider timeout / rate-limit behaviour | NOT TESTED against a real provider (Telegram variants mock-tested) |

## Security

| Criterion | Status | Evidence |
|---|---|---|
| No committed secrets | PASS | `.gitignore`, scan, `.env.example` placeholders only |
| Dashboard and sensitive APIs protected | PASS | 401/403 matrix in `api.test.ts`; e2e redirect |
| Roles enforced server-side; transcripts restricted | PASS | viewer vs operator tests |
| Webhooks verified per the provider's documented mechanism | Vaani documents **no** signature, so a secret URL token (fail closed) + re-fetch of call data from Vaani's authenticated API is used — PASS for what is implemented, but weaker than a signature; mock scheme PASS |
| Pricing data not exposed | PASS | see above |
| Customer data minimised | PASS | masked lists, restricted transcripts, minimal Telegram content, no recordings |
| MFA / password reset / user admin UI | FAIL (not built) — documented limitation |

## Quality

| Criterion | Status |
|---|---|
| Business rules unit-tested | PASS |
| API/DB integration-tested | PASS |
| Key workflows end-to-end tested over real HTTP | PASS |
| Lint and type checks | PASS |
| Production build | PASS |
| Documentation sufficient for a new developer | PASS (verified by following the README steps in a clean copy) |
| Accessibility audit with a screen reader / automated tool | NOT TESTED (semantic markup, labels, focus styles, non-colour status badges implemented) |
| Load / performance testing | NOT TESTED |
| Deployed production environment | NOT TESTED |

## Known defects and limitations (none critical for mock mode)

1. No real call has happened: link a phone number to the agent in Vaani, register the webhook, then run one controlled test call.
2. Five-minute metric will be *unmeasurable* until a provider supplies a first-agent-response timestamp.
3. The demo/regression fact extractor is rule-based and English-only; it is not the production extraction path.
4. Budget floors, 6–10-week handling, 500 sq ft commercial minimum, and the five supplementary localities are defaults awaiting Nikhil's confirmation.
5. In-memory rate limiters (per process); no MFA/reset/user management UI; sessions revoked only by rotating the secret.
6. Retention purge is a command, not a scheduled job.
7. PGlite default data folder lives inside the project (`./data`, git-ignored); a dev server that was started after a production build can loop on reload until `.next` is deleted (see troubleshooting).
8. Telegram hand-off text includes the caller's phone number by design (designers must call back).

## Decisions needed from people

Nikhil: the six items in [business-rules.md](business-rules.md#decisions-needed-from-nikhil). Studio owner: legal review of call recording and consent wording; who monitors the Urgent queue. Whoever owns the Vaani account: the checklist in [vaani-integration.md](vaani-integration.md).
