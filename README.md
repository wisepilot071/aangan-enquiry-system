# Aangan Studio — AI Phone Enquiry System

MESA AI · Founder's Office · Cohort C4 · **Case 03 — Nikhil: Unanswered Enquiries**

An application that answers **incoming phone enquiries** for Aangan Studio (Pune), qualifies them with Nikhil's own five-criteria rubric, hands qualified leads to designers on Telegram, escalates complaints to a human, and gives Nikhil a dashboard of response speed, qualification, hand-off reliability and cost — replacing his manual monthly report.

> **Status at a glance** (details in [docs/acceptance-checklist.md](docs/acceptance-checklist.md))
>
> | Area | Status |
> |---|---|
> | Business rules, pricing guardrail, qualification, escalation | **Implemented and tested** (220 automated tests) |
> | Database, API, webhook ingestion, dashboard, auth, costs, audit | **Implemented and tested** |
> | Voice provider (mock) + in-app call simulator | **Works with no credentials** |
> | Placing calls | **Implemented** (Vaani calls page → outbound test call; import finished calls). Needs a linked number to ring a phone |
> | **Vaani AI (real provider)** | **Implemented from the official docs; agent created in the Vaani account and configured (humble, respectful, to-the-point prompt; 25 extraction fields).** Verified: API key, agent creation, configuration. **Not yet verified on a real call** — a phone number must be linked in the Vaani dashboard. See [docs/vaani-integration.md](docs/vaani-integration.md) |
> | **Telegram** | **Implemented; tested with mocked HTTP only.** Needs a real bot token + chat id; never exercised against Telegram's live service |
> | Production deployment | Not deployed. Needs PostgreSQL, secrets, HTTPS hosting |

The product is the **incoming phone** channel. Outbound calling exists only as an operator-triggered **test call** (never counted as an enquiry, never automatic callbacks). WhatsApp, website forms, CRM, payments and booking are deliberately **not** built.

---

## 1. Quick start (no accounts or API keys needed)

Requires Node.js 20+ (developed on 24).

```bash
npm install
cp .env.example .env          # then set SESSION_SECRET (see below); everything else can stay empty
npm run db:seed               # creates the first admin; prints a random dev password ONCE
npm run dev                   # http://localhost:3000
```

On Windows PowerShell use `Copy-Item .env.example .env`.

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Sign in as `admin@aangan.local` with the password printed by `db:seed`. Open **Call simulator** to walk simulated calls through the real pipeline: conversation → qualification → stored record → Telegram preview → dashboard.

Without `DATABASE_URL` the app uses an **embedded PostgreSQL (PGlite)** stored in `./data/pglite` — real Postgres semantics, nothing to install. That is for development and demos only; production **requires** PostgreSQL ([docs/deployment.md](docs/deployment.md)).

### Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Next.js dev / production build / production server |
| `npm test` | All tests (unit, integration, HTTP end-to-end) |
| `npm run test:unit` · `test:integration` · `test:e2e` | A single layer |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |
| `npm run db:generate` | Create a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (also applied automatically at start-up) |
| `npm run db:seed` | Create the first admin (never seeds fake production data) |
| `npm run admin:hash -- '<password>'` | Produce `ADMIN_PASSWORD_HASH` for production |
| `npm run verify:seed` | Check `knowledge/*.md` matches the supplied seed files and that `pricing.md` is *not* in the repo (`SEED_DIR` env var points at the folder) |
| `npm run vaani:setup` | Create/update the enquiry agent in your Vaani account (needs `VAANI_API_KEY`) |
| `npm run privacy -- purge-transcripts <days>` / `-- delete <uuid> --confirm` | Retention and deletion tooling |

Tests use isolated in-memory databases and never touch `./data`. The E2E suite boots the real server on port 3199.

---

## 2. What the system does

```
 Caller ──► Voice provider (Vaani — PENDING; mock today)
                │  signed webhooks (call.started / responded / completed / missed / disconnected / failed)
                ▼
        POST /api/webhooks/voice ──► verify signature (fail closed) ──► validate ──► dedupe (idempotent)
                │
                ▼
   ┌──────────────────────── ingestion (one DB transaction) ────────────────────────┐
   │ enquiry upsert · reconnect linking · qualification engine · assessment rows      │
   │ costs (actual/estimated/unknown) · follow-up tasks · audit events · notifications│
   └──────────────────────────────────────────────────────────────────────────────────┘
                │ after commit
                ▼
        Telegram adapter (bounded retries, dedupe key, status tracking) ──► designers
                │
                ▼
        Dashboard (Next.js, server-rendered from the database) ◄── Nikhil / staff
```

Key design choices (full reasoning in [docs/business-rules.md](docs/business-rules.md)):

* **The rules engine decides, never the model.** `src/modules/qualification` is pure, deterministic and independent of the UI. Model/provider text is evidence; structured output is validated with a schema and falls back to *human review* when invalid.
* **Pricing is a fixed sentence.** `pricing.md` is never read, copied, bundled or sent to any provider. Every pricing question — including repeated asks and prompt-injection attempts — gets the approved response verbatim; an output filter also replaces any reply that looks like it quotes money.
* **Honest states everywhere.** A consultation is *requested* until a person confirms it. Unknown cost is `NULL`, never ₹0. Unmeasurable response times are excluded, not guessed. A simulated Telegram message is labelled *SIMULATED — not delivered*. Demo data is flagged and kept out of production metrics.
* **Nothing is silently lost.** Failed Telegram sends keep the enquiry and open a follow-up task; a call that ends mid-question goes to human review; missed and dropped calls become tasks.

### Modules (`src/modules`)

| Module | Responsibility |
|---|---|
| `business-knowledge` | Policy constants with sources; service-area list parsed from `knowledge/services.md` |
| `qualification` | Fact schema, five criteria, decision engine, demo/regression fact extractor |
| `pricing-guardrails` | Approved response, pricing/injection detection, outbound leak filter |
| `conversation` | Dialogue manager used by mock calls and tests (same engine as real calls) |
| `voice-provider` | Provider-neutral event contract; mock adapter; Vaani client, agent definition, webhook mapper and adapter |
| `telephony-events` | Webhook ingestion, idempotency, reconnect correlation, simulator |
| `notifications` | Telegram sender, message formats, delivery tracking and retry |
| `costs` | Actual/estimated/unknown cost calculation and storage |
| `analytics` | Metric formulas (pure) and database loaders |
| `enquiries` | Detail view, operator mutations, privacy tooling |
| `authentication` | scrypt passwords, signed sessions, roles, rate limiting |
| `audit` · `health` · `demo` | Audit log with secret redaction · health report · PDF scenarios |

---

## 3. Business rules in one page

**Qualification** (`knowledge/qualified.md`, rule version `qualified-md-v1.0`): five criteria, each `PASS / FAIL / UNCLEAR / NOT_APPLICABLE` with evidence.

1. Real design-and-execution project (not advice only) · 2. Pune city or PCMC · 3. Realistic timeline · 4. Budget broadly suitable *only if volunteered* · 5. Decision-maker present or represented.

* Unclear on 1/2/3 → **one** direct question, never repeated; if still unclear → human review.
* Unclear on 4/5 → **do not push**; qualify and note the uncertainty in the hand-off.
* One clear fail → close gracefully, **not forwarded**. Two or more → the documented decline sentence.
* Budget absent, price asked, after-hours, rented flat, single complete room, authorised representative → **never** disqualifying.
* Existing-client complaint or request for a person → bypass sales qualification, **urgent escalation**.

**Timeline** keeps two documented rules separate: `services.md` ("cannot begin execution if needed in under 6 weeks") and `qualified.md` ("site available within 8–10 weeks of consultation"). The band the documents don't resolve becomes *ask once, then human review* — never a silent decision. No completion date is ever promised. See [docs/business-rules.md](docs/business-rules.md#timeline-policy).

---

## 4. Configuration

All variables are documented in [.env.example](.env.example); only variables the code reads are listed. Start-up validation (`src/lib/config.ts`) fails fast on invalid values, requires `DATABASE_URL` + `SESSION_SECRET` in production, and prints clear warnings (not crashes) for missing optional integrations. The dashboard banner and **System status** page show mock mode, provider state and Telegram configuration prominently.

## 5. Documentation index

| Document | Contents |
|---|---|
| [docs/requirements-matrix.md](docs/requirements-matrix.md) | Requirement → module → test traceability, unknowns, document conflicts |
| [docs/business-rules.md](docs/business-rules.md) | Qualification, timeline policy, pricing guardrail, escalation, documented divergences |
| [docs/vaani-integration.md](docs/vaani-integration.md) | What was researched, what is unverified, checklist and steps to finish |
| [docs/telegram-setup.md](docs/telegram-setup.md) | Bot creation, chat id, testing, failure handling |
| [docs/api.md](docs/api.md) | HTTP API and the internal webhook event contract |
| [docs/metrics.md](docs/metrics.md) · [docs/cost-methodology.md](docs/cost-methodology.md) | Every dashboard formula; actual vs estimated vs unknown cost |
| [docs/security-privacy.md](docs/security-privacy.md) | Threat model, data stored, retention, access, deletion, recordings |
| [docs/deployment.md](docs/deployment.md) | PostgreSQL, hosting, secrets, migrations, backup/restore, go-live checklist |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms and fixes |
| [docs/acceptance-checklist.md](docs/acceptance-checklist.md) | Acceptance criteria with evidence, limitations, decisions needed |

## 6. Known limitations (summary)

* No real call (inbound or outbound) has reached this system yet: Vaani needs a phone number linked to the agent in its dashboard.
* The 5-minute response metric depends on provider timestamps that have never been observed; until then it will read "unmeasurable", not "100%".
* Live transfer to a human and appointment booking are not configured; callers are told the truth and a tracked task is created.
* The demo fact-extractor is rule-based and English-only; live mode relies on validated structured output from the provider.
* Several thresholds are conservative defaults awaiting Nikhil's confirmation (listed in [docs/business-rules.md](docs/business-rules.md#decisions-needed-from-nikhil)).
