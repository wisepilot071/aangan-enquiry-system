import { checkServiceArea } from "../business-knowledge/service-area";
import {
  OUT_OF_SCOPE_PROPERTY_TYPES, budgetFloorPolicy, scopePolicy, timelinePolicy,
} from "../business-knowledge/policy";
import type { Facts } from "./facts";
import type { CriterionResult } from "./types";

const lakh = (n: number) => (n < 100_000 ? `₹${n.toLocaleString("en-IN")}` : `₹${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)} lakh`);

/** Criterion 1 — a real design-and-execution project that is within Aangan's services. */
export function assessRealProject(f: Facts): CriterionResult {
  const base = { id: "real_project", number: 1 } as const;

  if (f.propertyType && (OUT_OF_SCOPE_PROPERTY_TYPES as readonly string[]).includes(f.propertyType)) {
    return { ...base, state: "FAIL", reasonCode: "PROPERTY_TYPE_OUT_OF_SCOPE",
      evidence: `Property type "${f.propertyType}" is listed as out of scope in services.md (restaurants, hotels, retail, gyms).` };
  }
  if (f.engagement === "advice_only" || f.engagement === "furniture_only" || f.engagement === "vastu_only") {
    return { ...base, state: "FAIL", reasonCode: `ENGAGEMENT_${f.engagement.toUpperCase()}`,
      evidence: `Caller wants ${f.engagement.replace(/_/g, " ")}; minimum engagement is a room redesign with execution (services.md).` };
  }
  if (f.structuralWork === true) {
    return { ...base, state: "FAIL", reasonCode: "STRUCTURAL_WORK_REQUESTED",
      evidence: "Structural changes / architecture are outside the studio's scope (services.md)." };
  }

  const isCommercial = f.projectCategory === "commercial" || f.scopeKind === "commercial_fitout";
  if (isCommercial && f.carpetAreaSqft !== undefined) {
    const max = scopePolicy.commercialMaxSqft.value;
    const reviewMax = max * (1 + scopePolicy.commercialToleranceFraction.value);
    if (f.carpetAreaSqft < scopePolicy.commercialMinSqft.value) {
      return { ...base, state: "FAIL", reasonCode: "COMMERCIAL_BELOW_MINIMUM",
        evidence: `Commercial space of ${f.carpetAreaSqft} sq ft is below the minimum scope the studio takes on (${scopePolicy.commercialMinSqft.source}).` };
    }
    if (f.carpetAreaSqft > reviewMax) {
      return { ...base, state: "FAIL", reasonCode: "COMMERCIAL_ABOVE_MAXIMUM",
        evidence: `Commercial space of ${f.carpetAreaSqft} sq ft exceeds the ~${max} sq ft limit (services.md).` };
    }
    if (f.carpetAreaSqft > max) {
      return { ...base, state: "UNCLEAR", reasonCode: "COMMERCIAL_NEAR_MAXIMUM", reviewFlag: true,
        evidence: `Commercial space of ${f.carpetAreaSqft} sq ft is slightly above "approximately ${max} sq ft"; a human should decide.` };
    }
  }

  if (f.engagement === "design_and_execution") {
    return { ...base, state: "PASS", reasonCode: "DESIGN_AND_EXECUTION_CONFIRMED", evidence: "Caller wants design with execution." };
  }
  if (f.scopeKind === "full_home" || f.scopeKind === "partial_home" || f.scopeKind === "commercial_fitout") {
    return { ...base, state: "PASS", reasonCode: "COMPLETE_PROJECT_SCOPE",
      evidence: `Scope "${f.scopeKind.replace(/_/g, " ")}" is a complete project with execution; no advice-only signals.` };
  }
  if (f.scopeKind === "single_room") {
    if (f.completeRedesign === true) {
      return { ...base, state: "PASS", reasonCode: "SINGLE_ROOM_COMPLETE_REDESIGN",
        evidence: "Single room with complete redesign and execution is accepted (services.md)." };
    }
    if (f.completeRedesign === false) {
      return { ...base, state: "FAIL", reasonCode: "SINGLE_ROOM_NOT_COMPLETE",
        evidence: "Single room without a complete redesign is not accepted (services.md)." };
    }
  }
  return { ...base, state: "UNCLEAR", reasonCode: "PROJECT_TYPE_UNCLEAR",
    evidence: "Not yet clear whether the caller wants a complete design-and-execution project." };
}

/** Criterion 2 — Pune city or PCMC. */
export function assessServiceArea(f: Facts): CriterionResult {
  const base = { id: "service_area", number: 2 } as const;
  const v = checkServiceArea(f.locationText);
  if (v.state === "PASS") return { ...base, state: "PASS", reasonCode: "IN_SERVICE_AREA", evidence: `"${v.matched}" is within Pune/PCMC (services.md).` };
  if (v.state === "FAIL") return { ...base, state: "FAIL", reasonCode: "OUTSIDE_SERVICE_AREA", evidence: `"${v.matched}" is outside Pune/PCMC; no vendor network there (qualified.md).` };
  return { ...base, state: "UNCLEAR", reasonCode: v.reason,
    evidence: v.reason === "LOCATION_UNKNOWN" ? "Location not yet provided." : `Location "${f.locationText}" not recognised as Pune/PCMC.` };
}

/**
 * Criterion 3 — realistic timeline.
 * Two separate documented tests are kept separate (see README "Timeline policy"):
 *  (a) services.md minimum lead time: needing the project ready in under 6 weeks => fail.
 *  (b) qualified.md: site available for execution within 8–10 weeks of the consultation.
 * The documents do not resolve the band between (a) and the design+execution minimum, nor a site
 * that becomes available after 10 weeks; those are UNCLEAR + review flag — never silently decided.
 * No completion date is ever promised.
 */
export function assessTimeline(f: Facts): CriterionResult {
  const base = { id: "realistic_timeline", number: 3 } as const;
  const minLead = timelinePolicy.minLeadWeeks.value;
  const tight = timelinePolicy.tightBelowWeeks.value;
  const siteMax = timelinePolicy.siteAvailabilityMaxWeeks.value;

  if (f.needByWeeks !== undefined && f.needByWeeks < minLead) {
    return { ...base, state: "FAIL", reasonCode: "NEEDED_BEFORE_MIN_LEAD_TIME",
      evidence: `Needs the project ready in ~${f.needByWeeks} weeks; execution cannot begin for projects needed in under ${minLead} weeks (services.md).` };
  }
  if (f.needByWeeks !== undefined && f.needByWeeks < tight) {
    return { ...base, state: "UNCLEAR", reasonCode: "TIGHT_TIMELINE_NEEDS_REVIEW", reviewFlag: true,
      evidence: `Needs completion in ~${f.needByWeeks} weeks; design (3–4 wk) plus execution (8+ wk) usually takes longer. Documents do not clearly resolve this window.` };
  }
  if (f.siteAvailableInWeeks !== undefined && f.siteAvailableInWeeks > siteMax) {
    return { ...base, state: "UNCLEAR", reasonCode: "SITE_AVAILABLE_AFTER_WINDOW", reviewFlag: true,
      evidence: `Site available in ~${f.siteAvailableInWeeks} weeks; qualified.md expects site availability within ${siteMax} weeks of consultation.` };
  }
  const timelineKnown = f.needByWeeks !== undefined || f.timelineFlexible === true || f.desiredStartWeeks !== undefined ||
    (f.siteAvailableInWeeks !== undefined && f.siteAvailableInWeeks <= siteMax);
  if (!timelineKnown) {
    return { ...base, state: "UNCLEAR", reasonCode: "TIMELINE_UNKNOWN", evidence: "Desired completion / start timing not yet provided." };
  }
  const note = f.siteAvailableInWeeks === undefined && f.siteReadinessText === undefined ? " Site readiness not confirmed." : "";
  return { ...base, state: "PASS", reasonCode: "TIMELINE_REALISTIC", evidence: `Timeline is workable under the documented policy.${note}` };
}

/** Criterion 4 — budget, only if voluntarily stated; never probed. */
export function assessBudget(f: Facts): CriterionResult {
  const base = { id: "budget_band", number: 4 } as const;
  if (f.statedBudgetMaxInr === undefined) {
    return { ...base, state: "NOT_APPLICABLE", reasonCode: "BUDGET_NOT_DISCLOSED",
      evidence: "Caller did not mention a budget (not probed by design; treated as qualified per qualified.md)." };
  }
  const floor = budgetFloor(f);
  if (floor === null) {
    return { ...base, state: "NOT_APPLICABLE", reasonCode: "SCOPE_TOO_VAGUE_TO_COMPARE",
      evidence: "Budget stated but scope is not specific enough to judge a mismatch." };
  }
  if (f.statedBudgetMaxInr < floor) {
    return { ...base, state: "FAIL", reasonCode: "BUDGET_CLEARLY_INSUFFICIENT",
      evidence: `Caller volunteered a budget of up to ${lakh(f.statedBudgetMaxInr)}, which is clearly below what a project of the described scope would require.` };
  }
  return { ...base, state: "PASS", reasonCode: "BUDGET_NOT_OBVIOUSLY_MISALIGNED", evidence: "Volunteered budget is not obviously misaligned with the described scope." };
}

function budgetFloor(f: Facts): number | null {
  const isCommercial = f.projectCategory === "commercial" || f.scopeKind === "commercial_fitout";
  if (isCommercial) return f.carpetAreaSqft ? f.carpetAreaSqft * budgetFloorPolicy.commercialPerSqftInr.value : null;
  const rooms = f.scopeKind === "single_room" ? 1 : f.roomCount;
  const byRooms = rooms ? rooms * budgetFloorPolicy.perRoomInr.value : null;
  const bySqft = f.scopeKind === "full_home" && f.carpetAreaSqft ? f.carpetAreaSqft * budgetFloorPolicy.residentialPerSqftInr.value : null;
  if (byRooms === null && bySqft === null) return null;
  return Math.max(byRooms ?? 0, bySqft ?? 0);
}

/** Criterion 5 — decision-maker present or represented. Never pushed. */
export function assessDecisionMaker(f: Facts): CriterionResult {
  const base = { id: "decision_maker", number: 5 } as const;
  switch (f.decisionMaker) {
    case "owner":
      return { ...base, state: "PASS", reasonCode: "CALLER_IS_DECISION_MAKER", evidence: "Caller is the owner / decision-maker." };
    case "authorised_representative":
      return { ...base, state: "PASS", reasonCode: "AUTHORISED_REPRESENTATIVE", evidence: "Caller confirmed they are authorised to act for the owner." };
    case "not_authorised":
      return { ...base, state: "FAIL", reasonCode: "EXPLICITLY_NOT_AUTHORISED", evidence: "Caller stated they are not the decision-maker and not authorised." };
    case "researching_for_others":
      return { ...base, state: "UNCLEAR", reasonCode: "RESEARCHING_FOR_OTHERS", reviewFlag: true,
        evidence: "Caller is doing initial research for the owners; authorisation not confirmed (qualified.md: not sufficient on its own). Not pushed." };
    default:
      return { ...base, state: "UNCLEAR", reasonCode: "DECISION_MAKER_UNKNOWN", reviewFlag: true,
        evidence: "Decision-maker status not stated. Not pushed; noted for the designer." };
  }
}
