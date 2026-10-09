/**
 * Central metric definitions. Dashboard, API and tests all use these functions; no formula is
 * re-implemented elsewhere. Definitions are documented in docs/metrics.md.
 */
export const FIVE_MINUTES_SEC = 300;
export const NO_USABLE_DATA_REASON = "No usable data captured from the call.";

export interface EnquiryRow {
  id: string;
  callStatus: string;
  callStartedAt: Date | null;
  firstResponseAt: Date | null;
  recordCompletedAt: Date | null;
  qualifiedAt: Date | null;
  notifiedAt: Date | null;
  disposition: string | null;
  priority: string;
  needsHumanReview: boolean;
  humanReviewStatus: string;
  humanReviewReasons: unknown;
  consultationStatus: string;
  conversionStatus: string;
  projectValueInr: string | null;
  createdAt: Date;
}
export interface NotificationRow { enquiryId: string; category: string; status: string }
export interface CostRow { enquiryId: string | null; provider: string; category: string; basis: string; amount: string | null; currency: string; rateSource: string }

export interface Stat { n: number; avg: number | null; median: number | null }

export function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
export function statOf(xs: number[]): Stat {
  return { n: xs.length, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, median: medianOf(xs) };
}
const secs = (a: Date | null, b: Date | null): number | null => (a && b && b.getTime() >= a.getTime() ? (b.getTime() - a.getTime()) / 1000 : null);
/** Ratio with an explicit denominator; null (never 0, never Infinity) when undefined. */
export const ratio = (num: number, den: number): { value: number | null; num: number; den: number } => ({ value: den > 0 ? num / den : null, num, den });

export interface Metrics {
  calls: { total: number; completed: number; handled: number; missed: number; disconnected: number; failed: number; inProgress: number };
  qualification: {
    qualified: number; unqualified: number; humanReviewOpen: number; urgent: number;
    qualifiedRate: ReturnType<typeof ratio>; escalated: number; needsClarificationOrReview: number;
  };
  response: {
    firstResponse: Stat; within5MinMeasured: ReturnType<typeof ratio>; within5MinStrict: ReturnType<typeof ratio>;
    unmeasurable: number; noResponseAtAll: number;
    timeToCompletedRecord: Stat; timeToQualification: Stat; timeToDesignerNotification: Stat;
  };
  handoff: { successRate: ReturnType<typeof ratio>; sent: number; failed: number; unavailable: number; pending: number; simulated: number };
  cost: CostSummary;
  outcomes: { consultationRequested: number; consultationConfirmed: number; converted: number; lost: number; inProgress: number;
    conversionRate: ReturnType<typeof ratio>; revenueInfluencedInr: number | null };
}

export interface CostSummary {
  actualInr: number; estimatedInr: number; unknownCount: number; callsWithActual: number; callsWithEstimate: number;
  otherCurrencies: Record<string, number>;
  perCall: { actual: number | null; estimated: number | null };
  perQualifiedLead: { actual: number | null; estimated: number | null };
  byProvider: Record<string, { actual: number; estimated: number; unknown: number }>;
  byCategory: Record<string, { actual: number; estimated: number; unknown: number }>;
  rateSources: string[];
}

export function summariseCosts(costs: CostRow[], qualified: number): CostSummary {
  let actual = 0, estimated = 0, unknown = 0;
  const actualCalls = new Set<string>(), estCalls = new Set<string>();
  const other: Record<string, number> = {};
  const byProvider: CostSummary["byProvider"] = {}, byCategory: CostSummary["byCategory"] = {};
  const sources = new Set<string>();
  for (const c of costs) {
    const p = (byProvider[c.provider] ??= { actual: 0, estimated: 0, unknown: 0 });
    const k = (byCategory[c.category] ??= { actual: 0, estimated: 0, unknown: 0 });
    sources.add(c.rateSource);
    if (c.basis === "unknown" || c.amount === null) { unknown++; p.unknown++; k.unknown++; continue; }
    const amt = Number(c.amount);
    if (c.currency !== "INR") { other[c.currency] = (other[c.currency] ?? 0) + amt; continue; }
    if (c.basis === "actual") { actual += amt; p.actual += amt; k.actual += amt; if (c.enquiryId) actualCalls.add(c.enquiryId); }
    else { estimated += amt; p.estimated += amt; k.estimated += amt; if (c.enquiryId) estCalls.add(c.enquiryId); }
  }
  const per = (sum: number, n: number) => (n > 0 ? sum / n : null);
  const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    actualInr: r2(actual)!, estimatedInr: r2(estimated)!, unknownCount: unknown, callsWithActual: actualCalls.size, callsWithEstimate: estCalls.size,
    otherCurrencies: other,
    perCall: { actual: r2(per(actual, actualCalls.size)), estimated: r2(per(estimated, estCalls.size)) },
    perQualifiedLead: { actual: actualCalls.size ? r2(per(actual, qualified)) : null, estimated: estCalls.size ? r2(per(estimated, qualified)) : null },
    byProvider, byCategory, rateSources: [...sources].sort(),
  };
}

export function computeMetrics(rows: EnquiryRow[], notes: NotificationRow[], costs: CostRow[], now = new Date()): Metrics {
  const completed = rows.filter((r) => r.callStatus === "completed");
  const isNoData = (r: EnquiryRow) => Array.isArray(r.humanReviewReasons) && (r.humanReviewReasons as string[]).includes(NO_USABLE_DATA_REASON);
  const handled = completed.filter((r) => r.disposition !== null && !isNoData(r));
  const staleBefore = now.getTime() - 2 * 3600_000;
  const inProgress = rows.filter((r) => r.callStatus === "in_progress" && (r.callStartedAt ?? r.createdAt).getTime() < staleBefore).length;

  const qualified = rows.filter((r) => r.disposition === "QUALIFIED").length;
  const unqualified = rows.filter((r) => r.disposition === "CLOSED_NOT_FORWARDED" || r.disposition === "DECLINED").length;

  // --- response time: only provider-reported timestamps; otherwise unmeasurable ---
  const rt = rows.map((r) => ({ r, s: secs(r.callStartedAt, r.firstResponseAt) }));
  const measurable = rt.filter((x) => x.s !== null).map((x) => x.s!);
  const within = measurable.filter((s) => s <= FIVE_MINUTES_SEC).length;
  const missedFailed = rows.filter((r) => r.callStatus === "missed" || r.callStatus === "failed").length;
  const unmeasurable = rows.length - measurable.length - missedFailed;

  const handoffNotes = notes.filter((n) => n.category === "qualified_handoff" || n.category === "urgent_escalation");
  const count = (st: string) => handoffNotes.filter((n) => n.status === st).length;
  const sent = count("sent"), failed = count("failed"), unavailable = count("unavailable");

  const converted = rows.filter((r) => r.conversionStatus === "converted");
  const lost = rows.filter((r) => r.conversionStatus === "lost").length;
  const valued = converted.filter((r) => r.projectValueInr !== null);

  return {
    calls: {
      total: rows.length, completed: completed.length, handled: handled.length,
      missed: rows.filter((r) => r.callStatus === "missed").length, disconnected: rows.filter((r) => r.callStatus === "disconnected").length,
      failed: rows.filter((r) => r.callStatus === "failed").length, inProgress,
    },
    qualification: {
      qualified, unqualified,
      humanReviewOpen: rows.filter((r) => r.needsHumanReview && r.humanReviewStatus === "open").length,
      urgent: rows.filter((r) => r.priority === "urgent").length,
      qualifiedRate: ratio(qualified, qualified + unqualified),
      escalated: rows.filter((r) => r.disposition === "ESCALATED").length,
      needsClarificationOrReview: rows.filter((r) => r.disposition === "HUMAN_REVIEW" || r.disposition === "NEEDS_CLARIFICATION").length,
    },
    response: {
      firstResponse: statOf(measurable),
      within5MinMeasured: ratio(within, measurable.length),
      within5MinStrict: ratio(within, measurable.length + missedFailed),
      unmeasurable, noResponseAtAll: missedFailed,
      timeToCompletedRecord: statOf(rows.map((r) => secs(r.callStartedAt, r.recordCompletedAt)).filter((x): x is number => x !== null)),
      timeToQualification: statOf(rows.map((r) => secs(r.callStartedAt, r.qualifiedAt)).filter((x): x is number => x !== null)),
      timeToDesignerNotification: statOf(rows.map((r) => secs(r.callStartedAt, r.notifiedAt)).filter((x): x is number => x !== null)),
    },
    handoff: {
      successRate: ratio(sent, sent + failed + unavailable),
      sent, failed, unavailable, pending: count("pending"), simulated: count("mock_sent"),
    },
    cost: summariseCosts(costs, qualified),
    outcomes: {
      consultationRequested: rows.filter((r) => r.consultationStatus === "requested").length,
      consultationConfirmed: rows.filter((r) => r.consultationStatus === "confirmed").length,
      converted: converted.length, lost, inProgress: rows.filter((r) => r.conversionStatus === "in_progress").length,
      conversionRate: ratio(converted.length, converted.length + lost),
      revenueInfluencedInr: valued.length ? valued.reduce((a, r) => a + Number(r.projectValueInr), 0) : null,
    },
  };
}
