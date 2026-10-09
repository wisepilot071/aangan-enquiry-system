# Metric definitions

One implementation: `src/modules/analytics/metrics.ts` (pure functions, unit-tested). The dashboard, `/api/metrics` and the tests all call it; rows come from `queries.ts`, so every number is traceable to stored records. Period = `coalesce(call_started_at, created_at)` in IST; scope = demo **or** production, never both.

| Metric | Definition |
|---|---|
| Incoming calls | Count of unique `(provider, provider_call_id)` enquiries. Duplicate webhooks never add a call |
| Successfully handled | Completed calls with a disposition, excluding "no usable data captured" |
| Missed / failed / disconnected | Counted separately by `call_status`; *disconnected* means the caller dropped mid-call |
| Qualified / unqualified | `QUALIFIED` / (`CLOSED_NOT_FORWARDED` + `DECLINED`) |
| Qualified rate | qualified ÷ (qualified + unqualified). Escalations, clarifications and human-review cases are in **neither** side; numerator and denominator are shown. `N/A` when the denominator is 0 |
| Needs human review | `needs_human_review = true AND human_review_status = open` |
| Urgent complaints | `priority = urgent` |
| First response time | `first_response_at − call_started_at`, **provider timestamps only**. Rows lacking either (or negative) are *unmeasurable* |
| ≤ 5 min (measured) | within 300 s ÷ calls with measurable timestamps |
| ≤ 5 min (strict) | within 300 s ÷ (measurable + missed + failed) — a missed call is a broken five-minute promise |
| Unmeasurable | calls with no usable response timestamp (excluded from "measured", never assumed compliant) |
| Time to completed record | `record_completed_at − call_started_at` |
| Time to qualification | `qualified_at − call_started_at` |
| Time to designer notification | `notified_at − call_started_at`, set only on a **real** Telegram delivery |
| Handoff success rate | `sent` ÷ (`sent` + `failed` + `unavailable`) for qualified-handoff and urgent-escalation notifications. `pending` and `mock_sent` are excluded; demo-only data shows `N/A` |
| Consultations requested / confirmed | `requested` = caller asked (not booked). `confirmed` is set only by a person |
| Conversion rate | converted ÷ (converted + lost) among enquiries with a recorded outcome. `Not yet recorded` otherwise. Qualified ≠ converted |
| Revenue influenced | Σ `project_value_inr` of converted enquiries that have a recorded value; `Not yet recorded` otherwise. The case's average project value is never used |
| Cost metrics | See [cost-methodology.md](cost-methodology.md) |

These five times are different measurements; the dashboard never calls a metric "response time" unless it came from provider timestamps. The application does **not** claim every call meets five minutes because an AI could answer quickly — the figure will read *unmeasurable* until a real provider supplies timestamps.
