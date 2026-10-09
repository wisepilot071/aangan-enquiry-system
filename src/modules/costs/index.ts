import { eq } from "drizzle-orm";
import { costs, settings } from "@/db/schema";
import type { Db } from "@/db/client";

/** Verified unit rates, entered by an admin. Nothing here is pre-filled: no provider prices are invented. */
export interface CostRates {
  voicePerMinuteInr?: number;
  telephonyPerMinuteInr?: number;
  /** Where the rate came from, e.g. "Vaani invoice INV-123, Oct 2026". Required when any rate is set. */
  source?: string;
}

export interface CostDraft {
  category: "voice_call" | "telephony";
  basis: "actual" | "estimated" | "unknown";
  amount: number | null;
  currency: string;
  quantity: number | null;
  unit: string | null;
  rateValue: number | null;
  rateSource: string;
}

export const RATES_KEY = "cost_rates";

/**
 * Cost methodology (see docs/cost-methodology.md):
 *  - provider-reported cost → basis "actual"
 *  - else configured verified rate × billed minutes → basis "estimated"
 *  - else basis "unknown" with NULL amount (never zero)
 */
export function computeCallCosts(input: {
  providerCost?: { amount: number; currency: string };
  durationSec?: number;
  rates: CostRates;
}): CostDraft[] {
  const { providerCost, durationSec, rates } = input;
  const minutes = durationSec === undefined ? null : Math.round((durationSec / 60) * 10000) / 10000;
  const out: CostDraft[] = [];

  if (providerCost) {
    out.push({ category: "voice_call", basis: "actual", amount: providerCost.amount, currency: providerCost.currency.toUpperCase(),
      quantity: minutes, unit: minutes === null ? null : "minute", rateValue: null, rateSource: "provider_reported" });
  } else if (rates.voicePerMinuteInr !== undefined && rates.source && minutes !== null) {
    out.push({ category: "voice_call", basis: "estimated", amount: round2(rates.voicePerMinuteInr * minutes), currency: "INR",
      quantity: minutes, unit: "minute", rateValue: rates.voicePerMinuteInr, rateSource: rates.source });
  } else {
    out.push({ category: "voice_call", basis: "unknown", amount: null, currency: "INR", quantity: minutes,
      unit: minutes === null ? null : "minute", rateValue: null, rateSource: "no_provider_cost_and_no_verified_rate" });
  }

  if (rates.telephonyPerMinuteInr !== undefined && rates.source && minutes !== null) {
    out.push({ category: "telephony", basis: "estimated", amount: round2(rates.telephonyPerMinuteInr * minutes), currency: "INR",
      quantity: minutes, unit: "minute", rateValue: rates.telephonyPerMinuteInr, rateSource: rates.source });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getRates(db: Db): Promise<CostRates> {
  const [row] = await db.select().from(settings).where(eq(settings.key, RATES_KEY));
  return (row?.value as CostRates | undefined) ?? {};
}

export async function recordCosts(
  db: Db,
  ctx: { enquiryId: string; providerCallId: string; provider: string; isDemo: boolean },
  drafts: CostDraft[],
): Promise<void> {
  for (const d of drafts) {
    await db.insert(costs).values({
      enquiryId: ctx.enquiryId, providerCallId: ctx.providerCallId, provider: ctx.provider, category: d.category,
      quantity: d.quantity === null ? null : String(d.quantity), unit: d.unit, rateSource: d.rateSource,
      rateValue: d.rateValue === null ? null : String(d.rateValue), currency: d.currency,
      amount: d.amount === null ? null : String(d.amount), basis: d.basis, isDemo: ctx.isDemo,
    }).onConflictDoNothing();
  }
}
