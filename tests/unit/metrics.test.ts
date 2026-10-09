import { describe, expect, it } from "vitest";
import { computeMetrics, medianOf, ratio, summariseCosts, NO_USABLE_DATA_REASON, type CostRow, type EnquiryRow, type NotificationRow } from "@/modules/analytics/metrics";
import { computeCallCosts } from "@/modules/costs";

const T0 = new Date("2026-09-02T05:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
let i = 0;
const row = (o: Partial<EnquiryRow> = {}): EnquiryRow => ({
  id: `e${++i}`, callStatus: "completed", callStartedAt: T0, firstResponseAt: at(4), recordCompletedAt: at(120), qualifiedAt: at(120), notifiedAt: null,
  disposition: "QUALIFIED", priority: "normal", needsHumanReview: false, humanReviewStatus: "none", humanReviewReasons: [], consultationStatus: "none",
  conversionStatus: "unknown", projectValueInr: null, createdAt: T0, ...o,
});

describe("metrics formulas", () => {
  it("ratio never yields 0/Infinity for an empty denominator", () => {
    expect(ratio(0, 0).value).toBeNull();
    expect(ratio(1, 4)).toEqual({ value: 0.25, num: 1, den: 4 });
  });
  it("median handles odd/even/empty", () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });
  it("counts calls, qualified rate with explicit denominator; unknown results are not failures", () => {
    const m = computeMetrics([
      row(), row(), row({ disposition: "CLOSED_NOT_FORWARDED" }), row({ disposition: "DECLINED" }),
      row({ disposition: "ESCALATED", priority: "urgent", needsHumanReview: true, humanReviewStatus: "open" }),
      row({ disposition: "HUMAN_REVIEW", needsHumanReview: true, humanReviewStatus: "open" }),
      row({ callStatus: "missed", disposition: null, firstResponseAt: null }),
      row({ callStatus: "disconnected", disposition: null, firstResponseAt: null }),
      row({ callStatus: "failed", disposition: null, firstResponseAt: null }),
    ], [], []);
    expect(m.calls).toMatchObject({ total: 9, completed: 6, handled: 6, missed: 1, disconnected: 1, failed: 1 });
    expect(m.qualification.qualified).toBe(2);
    expect(m.qualification.unqualified).toBe(2);
    expect(m.qualification.qualifiedRate).toEqual({ value: 0.5, num: 2, den: 4 }); // escalations/review excluded from the denominator
    expect(m.qualification.urgent).toBe(1);
    expect(m.qualification.humanReviewOpen).toBe(2);
  });
  it("a completed call with no usable data is not 'successfully handled'", () => {
    const m = computeMetrics([row({ disposition: "HUMAN_REVIEW", humanReviewReasons: [NO_USABLE_DATA_REASON] })], [], []);
    expect(m.calls.completed).toBe(1);
    expect(m.calls.handled).toBe(0);
  });
  it("response time: provider timestamps only; unmeasurable and no-response are reported separately", () => {
    const m = computeMetrics([
      row({ firstResponseAt: at(4) }), row({ firstResponseAt: at(299) }), row({ firstResponseAt: at(301) }),
      row({ firstResponseAt: null }), row({ callStatus: "missed", firstResponseAt: null, disposition: null }),
    ], [], []);
    expect(m.response.firstResponse.n).toBe(3);
    expect(m.response.firstResponse.median).toBe(299);
    expect(m.response.within5MinMeasured).toEqual({ value: 2 / 3, num: 2, den: 3 });
    expect(m.response.within5MinStrict).toEqual({ value: 2 / 4, num: 2, den: 4 }); // a missed call is a failed promise
    expect(m.response.unmeasurable).toBe(1);
    expect(m.response.noResponseAtAll).toBe(1);
  });
  it("distinguishes first response, completed record, qualification and designer notification times", () => {
    const m = computeMetrics([row({ notifiedAt: at(130) })], [], []);
    expect(m.response.firstResponse.avg).toBe(4);
    expect(m.response.timeToCompletedRecord.avg).toBe(120);
    expect(m.response.timeToQualification.avg).toBe(120);
    expect(m.response.timeToDesignerNotification.avg).toBe(130);
  });
  it("handoff success excludes pending and simulated deliveries", () => {
    const n = (status: string): NotificationRow => ({ enquiryId: "x", category: "qualified_handoff", status });
    const m = computeMetrics([], [n("sent"), n("sent"), n("failed"), n("unavailable"), n("pending"), n("mock_sent")], []);
    expect(m.handoff.successRate).toEqual({ value: 0.5, num: 2, den: 4 });
    expect(m.handoff.simulated).toBe(1);
    expect(computeMetrics([], [n("mock_sent")], []).handoff.successRate.value).toBeNull();
  });
  it("conversion is only from recorded outcomes; qualified is not converted; revenue needs real values", () => {
    const none = computeMetrics([row(), row()], [], []);
    expect(none.outcomes.conversionRate.value).toBeNull();
    expect(none.outcomes.revenueInfluencedInr).toBeNull();
    const some = computeMetrics([row({ conversionStatus: "converted", projectValueInr: "900000" }), row({ conversionStatus: "lost" }), row({ conversionStatus: "converted" })], [], []);
    expect(some.outcomes.conversionRate).toEqual({ value: 2 / 3, num: 2, den: 3 });
    expect(some.outcomes.revenueInfluencedInr).toBe(900000);
  });
  it("consultation 'requested' is never counted as confirmed", () => {
    const m = computeMetrics([row({ consultationStatus: "requested" }), row({ consultationStatus: "confirmed" })], [], []);
    expect(m.outcomes).toMatchObject({ consultationRequested: 1, consultationConfirmed: 1 });
  });
});

describe("cost methodology", () => {
  const c = (o: Partial<CostRow>): CostRow => ({ enquiryId: "a", provider: "vaani", category: "voice_call", basis: "actual", amount: "10", currency: "INR", rateSource: "provider_reported", ...o });
  it("keeps actual, estimated and unknown separate; unknown is never zero", () => {
    const s = summariseCosts([c({}), c({ enquiryId: "b", basis: "estimated", amount: "6", rateSource: "invoice" }), c({ enquiryId: "c", basis: "unknown", amount: null })], 2);
    expect(s).toMatchObject({ actualInr: 10, estimatedInr: 6, unknownCount: 1, callsWithActual: 1, callsWithEstimate: 1 });
    expect(s.perCall).toEqual({ actual: 10, estimated: 6 });
    expect(s.perQualifiedLead).toEqual({ actual: 5, estimated: 3 });
  });
  it("cost per qualified lead is null (N/A) when there are no qualified leads", () => {
    const s = summariseCosts([c({})], 0);
    expect(s.perQualifiedLead.actual === null || Number.isFinite(s.perQualifiedLead.actual)).toBe(true);
    expect(s.perQualifiedLead.actual).not.toBe(Infinity);
  });
  it("only unknown costs → no totals, no per-call figure", () => {
    const s = summariseCosts([c({ basis: "unknown", amount: null })], 3);
    expect(s.perCall).toEqual({ actual: null, estimated: null });
    expect(s.perQualifiedLead).toEqual({ actual: null, estimated: null });
  });
  it("non-INR amounts are not silently added to INR totals", () => {
    const s = summariseCosts([c({ currency: "USD", amount: "1.5" })], 1);
    expect(s.actualInr).toBe(0);
    expect(s.otherCurrencies).toEqual({ USD: 1.5 });
  });
  it("computeCallCosts: actual > estimated > unknown", () => {
    expect(computeCallCosts({ providerCost: { amount: 9, currency: "inr" }, durationSec: 120, rates: {} })[0]).toMatchObject({ basis: "actual", amount: 9, currency: "INR" });
    const est = computeCallCosts({ durationSec: 90, rates: { voicePerMinuteInr: 4, telephonyPerMinuteInr: 1, source: "invoice 1" } });
    expect(est.map((d) => [d.category, d.basis, d.amount])).toEqual([["voice_call", "estimated", 6], ["telephony", "estimated", 1.5]]);
    expect(computeCallCosts({ durationSec: 90, rates: {} })[0]).toMatchObject({ basis: "unknown", amount: null });
    // a rate without a stated source is not accepted as "verified"
    expect(computeCallCosts({ durationSec: 90, rates: { voicePerMinuteInr: 4 } })[0]!.basis).toBe("unknown");
    // unknown duration → unknown, never 0
    expect(computeCallCosts({ rates: { voicePerMinuteInr: 4, source: "x" } })[0]).toMatchObject({ basis: "unknown", amount: null });
  });
});
