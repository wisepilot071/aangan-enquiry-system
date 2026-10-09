import { describe, expect, it } from "vitest";
import { entitiesToFacts } from "@/modules/voice-provider/vaani-mapper";
import { normDecisionMaker, normEngagement, normPropertyType, normScope, parseBudgetInr, parseTimeline } from "@/modules/voice-provider/vaani-normalize";
import { assess } from "@/modules/qualification/engine";
import { explain } from "@/modules/qualification/explain";
import { FactsSchema } from "@/modules/qualification/facts";
import { qualifyCompletedCall } from "@/modules/telephony-events/ingest";
import { ProviderEventSchema } from "@/modules/voice-provider/types";

const CALL = new Date("2026-10-09T17:51:00Z");

/** Values exactly as Vaani returned them on a real browser (WebRTC) test call on 9 Oct 2026 — free text, not our keywords. */
const REAL_ENTITIES = {
  caller_name: "Sagar Chodi", is_existing_client: false, is_complaint: false, asked_for_person: false, requested_person: null, project_reference: null,
  project_category: null, property_type: null, location: "near the Pune Railway Station", carpet_area_sqft: null,
  scope_kind: "interior design for a room", room_count: 1, engagement: "interior design and execution", complete_redesign: true,
  structural_work: null, is_rented: null, timeline_text: "within three months", site_ready_text: "it is level for work", decision_maker: null,
  budget_text: "50,000", wants_consultation: null, callback_time_text: null, referral_source: null, earlier_enquiry_ignored: false, asked_price: false,
};
const EMPTY_ENTITIES = Object.fromEntries(Object.keys(REAL_ENTITIES).map((k) => [k, k.startsWith("is_") || k.startsWith("asked") || k === "earlier_enquiry_ignored" ? false : null]));

describe("Vaani's free-text answers are understood (regression: real call, 9 Oct 2026)", () => {
  it("the real call is read correctly, field by field", () => {
    const f = FactsSchema.parse(entitiesToFacts(REAL_ENTITIES, CALL));
    expect(f).toMatchObject({
      callerName: "Sagar Chodi", scopeKind: "single_room", roomCount: 1, engagement: "design_and_execution", completeRedesign: true,
      locationText: "near the Pune Railway Station", statedBudgetMaxInr: 50000, decisionMaker: "unknown", siteAvailableInWeeks: 0,
    });
    expect(f.needByWeeks).toBeGreaterThan(12);
    expect(f.needByWeeks).toBeLessThan(14);
  });
  it("…and the rules decide it for the right reason: a volunteered ₹50,000 is clearly too low for a complete single-room job", () => {
    const f = FactsSchema.parse(entitiesToFacts(REAL_ENTITIES, CALL));
    const a = assess(f);
    expect(a.disposition).toBe("CLOSED_NOT_FORWARDED");
    expect(a.reasonCodes).toEqual(["BUDGET_CLEARLY_INSUFFICIENT"]);
    const byId = Object.fromEntries(a.criteria.map((c) => [c.id, c.state]));
    expect(byId).toMatchObject({ real_project: "PASS", service_area: "PASS", realistic_timeline: "PASS", budget_band: "FAIL" });
    const ex = explain({ disposition: a.disposition, criteria: a.criteria });
    expect(ex.headline).toMatch(/Not forwarded/);
    expect(ex.summary).toMatch(/budget/i);
    expect(ex.nextStep).toMatch(/No action needed/);
  });
  it("an unintelligible call is 'nothing usable captured', not a pretend open question", () => {
    const event = ProviderEventSchema.parse({ type: "call.completed", providerCallId: "webrtc-1", occurredAt: CALL.toISOString(), structuredFacts: entitiesToFacts(EMPTY_ENTITIES, CALL) });
    const q = qualifyCompletedCall(event, "vaani");
    expect(q.assessment.disposition).toBe("HUMAN_REVIEW");
    expect(q.assessment.reasonCodes).toEqual(["NO_USABLE_DATA"]);
    expect(q.assessment.humanReviewReasons).toEqual(["No usable data captured from the call."]);
    expect(q.assessment.priority).toBe("normal");
    expect(explain({ disposition: "HUMAN_REVIEW", criteria: q.assessment.criteria, humanReviewReasons: q.assessment.humanReviewReasons }).headline).toBe("Nothing usable was captured");
  });
});

describe("normalisers (Vaani's wording → our vocabulary; unknown stays unknown)", () => {
  it("engagement", () => {
    expect(normEngagement("interior design and execution")).toBe("design_and_execution");
    expect(normEngagement("full interior, turnkey")).toBe("design_and_execution");
    expect(normEngagement("just some ideas for colours")).toBe("advice_only");
    expect(normEngagement("only buy furniture")).toBe("furniture_only");
    expect(normEngagement("Vastu consultation")).toBe("vastu_only");
    expect(normEngagement("interior design")).toBeUndefined(); // ambiguous: not guessed
    expect(normEngagement("")).toBeUndefined();
    expect(normEngagement("design_and_execution")).toBe("design_and_execution");
  });
  it("scope", () => {
    expect(normScope("interior design for a room", 1)).toBe("single_room");
    expect(normScope("full home, 3BHK")).toBe("full_home");
    expect(normScope("whole flat")).toBe("full_home");
    expect(normScope("living room and kitchen", 2)).toBe("partial_home");
    expect(normScope("office fit-out")).toBe("commercial_fitout");
    expect(normScope(null, 1)).toBe("single_room");
    expect(normScope(null, 3)).toBe("partial_home");
    expect(normScope(null)).toBeUndefined();
  });
  it("property type and decision maker", () => {
    expect(normPropertyType("2BHK flat")).toBe("apartment");
    expect(normPropertyType("a villa")).toBe("villa");
    expect(normPropertyType("restaurant")).toBe("restaurant");
    expect(normPropertyType("studio apartment")).toBe("apartment");
    expect(normPropertyType("something odd")).toBeUndefined();
    expect(normDecisionMaker("I am the owner")).toBe("owner");
    expect(normDecisionMaker("calling on behalf of my parents, they authorised me")).toBe("authorised_representative");
    expect(normDecisionMaker("just researching for my parents")).toBe("researching_for_others");
    expect(normDecisionMaker("I'm not the decision maker")).toBe("not_authorised");
    expect(normDecisionMaker(null)).toBe("unknown");
  });
  it("budget: rupees, lakh, k, ranges — but a bare small number is never guessed", () => {
    expect(parseBudgetInr("50,000")).toBe(50000);
    expect(parseBudgetInr("₹50000")).toBe(50000);
    expect(parseBudgetInr("Rs. 75,000 maximum")).toBe(75000);
    expect(parseBudgetInr("50k")).toBe(50000);
    expect(parseBudgetInr("5 lakh")).toBe(500000);
    expect(parseBudgetInr("10 to 12 lakh")).toBe(1200000);
    expect(parseBudgetInr("1.5 crore")).toBe(15000000);
    expect(parseBudgetInr("5")).toBeUndefined();
    expect(parseBudgetInr("not sure")).toBeUndefined();
    expect(parseBudgetInr(null)).toBeUndefined();
  });
  it("timeline", () => {
    const none = () => ({});
    expect(parseTimeline("within three months", "", CALL, none).needByWeeks).toBeCloseTo(13.1, 0);
    expect(parseTimeline("in 6 weeks", "", CALL, none).needByWeeks).toBe(6);
    expect(parseTimeline("no rush", "", CALL, none).timelineFlexible).toBe(true);
    expect(parseTimeline("starting in two months", "", CALL, none).desiredStartWeeks).toBeCloseTo(8.7, 0);
    expect(parseTimeline("asap", "", CALL, none).desiredStartWeeks).toBe(0);
    expect(parseTimeline("", "the site is ready now", CALL, none).siteAvailableInWeeks).toBe(0);
    expect(parseTimeline("", "not ready yet", CALL, none).siteAvailableInWeeks).toBeUndefined();
    expect(parseTimeline("", "possession in about six weeks", CALL, none).siteAvailableInWeeks).toBe(6);
  });
});

describe("plain-language explanation", () => {
  const f = (o: Record<string, unknown>) => assess(FactsSchema.parse({ callerType: "new_prospect", scopeKind: "full_home", engagement: "design_and_execution", locationText: "Baner", needByWeeks: 30, decisionMaker: "owner", ...o }));
  it("good lead", () => {
    const a = f({});
    const ex = explain({ disposition: a.disposition, criteria: a.criteria, uncertainties: a.uncertainties });
    expect(ex.headline).toBe("Good lead — hand to a designer");
    expect(ex.tone).toBe("ok");
    expect(ex.checks).toHaveLength(5);
    expect(ex.checks.find((c) => c.label.startsWith("Property"))?.text).toBe("Baner is in the studio's area.");
    expect(ex.nextStep).toMatch(/Nothing has been booked/);
  });
  it("closed: names the reason in everyday words, with no file names or internal codes", () => {
    const a = f({ locationText: "Nashik" });
    const ex = explain({ disposition: a.disposition, criteria: a.criteria });
    expect(ex.short).toBe("Not forwarded: The property is outside Pune and PCMC.");
    expect(JSON.stringify(ex)).not.toMatch(/services\.md|qualified\.md|OUTSIDE_SERVICE_AREA/);
  });
  it("escalation and missed calls", () => {
    expect(explain({ disposition: "ESCALATED", criteria: [], escalationKind: "existing_client_complaint" }).tone).toBe("bad");
    const m = explain({ disposition: null, criteria: [], callStatus: "missed" });
    expect(m.headline).toBe("Missed call");
    expect(m.summary).toMatch(/no transcript/);
  });
});
