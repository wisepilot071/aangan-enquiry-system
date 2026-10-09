# Cost methodology

No provider prices are assumed or pre-filled anywhere in the code, tests, seed data or demo. Cost rows are written when a call **completes** (`costs` table).

## Three states

| Basis | When | `amount` |
|---|---|---|
| **actual** | The provider reports a cost on the completed event (`cost: { amount, currency }`) — rate source `provider_reported` | the reported figure |
| **estimated** | No provider cost, but an admin has entered a **verified unit rate with its source** and the call duration is known: `rate × (duration ÷ 60)` | computed, rounded to paise |
| **unknown** | Neither of the above (or no duration) | **NULL** — a database check constraint forbids a number on an unknown row, so unknown can never become ₹0 |

A rate without a source is not accepted as "verified" (`computeCallCosts` returns *unknown*, and the settings API returns 400). Estimated and actual figures are never added together; every table and card shows them side by side with the rate source and period.

## Configuring verified rates

Admin → **Costs → Verified unit rates**, or `PUT /api/settings/cost-rates`:

```json
{ "voicePerMinuteInr": 0, "telephonyPerMinuteInr": 0, "source": "e.g. provider invoice no. / contract clause / published price page + date" }
```
(Replace the zeros with figures you have actually verified; leave a field out if unknown.) Rates apply to calls completed **after** the change; history is not rewritten. Clearing the form returns new calls to *unknown*. Each change is audited.

## Reporting rules

* **Cost per call** = known cost of that basis ÷ calls that have that basis. `N/A` if none.
* **Cost per qualified lead** = known cost of that basis in the period ÷ qualified leads in the period; `N/A` when there are no qualified leads or no known cost (never ∞ or 0). Because unknown costs are excluded from the numerator, the dashboard shows the count of unknown records beside it.
* **Per known conversion** is shown as "Not yet recorded" until a conversion exists (and cost data is complete enough to be meaningful).
* Non-INR provider amounts are listed separately and not converted.
* Breakdowns by provider and by category (voice call / telephony) are on the Costs page for any date range.
* Demo costs (including any simulated provider cost typed into the simulator) live in the demo scope only.

## What is not tracked yet

LLM/token costs, Telegram (free), hosting, and any provider fee not delivered per call. Add a new `category` and a recording call in `ingest.ts` when those are known.
