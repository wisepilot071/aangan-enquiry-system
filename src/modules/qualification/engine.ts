import { RULE_VERSION } from "../business-knowledge/policy";
import {
  assessBudget, assessDecisionMaker, assessRealProject, assessServiceArea, assessTimeline,
} from "./criteria";
import type { Facts } from "./facts";
import type { Assessment, CriterionResult, EscalationKind, Priority } from "./types";

/** qualified.md → "At the boundary": exact documented wording for two-or-more failures. */
export const DOCUMENTED_DECLINE_MESSAGE =
  "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.";

const QUESTIONS = {
  project: "Thank you. Are you looking for a complete design-and-execution project, rather than advice alone?",
  location: "May I know which area the property is in, and whether it is in Pune or PCMC, please?",
  // Wording from qualified.md ("Ask: ...") — kept exactly.
  timeline: "When would you need the project complete?",
  timelineTight: "When would you need the project complete, and is there any flexibility on that date, please?",
} as const;

/** Short, humble, respectful closes. No prices, no comparisons with our costs, no promises. */
const CLOSING_BY_REASON: Record<string, string> = {
  OUTSIDE_SERVICE_AREA:
    "I am sorry, we work only in Pune and PCMC, because our execution needs our own contractors on site. Thank you very much for calling.",
  PROPERTY_TYPE_OUT_OF_SCOPE:
    "I am sorry, restaurants, hotels, retail stores and gyms are outside what we do. A specialist studio would serve you better. Thank you very much for calling.",
  ENGAGEMENT_ADVICE_ONLY:
    "Thank you for asking. We take only full design-and-execution projects, so I am sorry we cannot offer advice-only visits. Please do call us if you plan a full redesign.",
  ENGAGEMENT_FURNITURE_ONLY:
    "Thank you for asking. We do not source furniture on its own; it comes with a design-and-execution project. I am sorry we cannot help with that alone.",
  ENGAGEMENT_VASTU_ONLY:
    "Thank you for asking. We include Vastu in our designs but do not offer it as a standalone service. I am sorry we cannot help with that alone.",
  SINGLE_ROOM_NOT_COMPLETE:
    "Thank you. Our minimum is a complete room redesign with execution. Please do call us if you decide to go ahead with that.",
  STRUCTURAL_WORK_REQUESTED:
    "I am sorry, we are interior designers, not architects, so we cannot take on structural changes. Please do call us if the project can work without them.",
  COMMERCIAL_BELOW_MINIMUM:
    "I am sorry, our team is set up for larger commercial spaces, so we could not do a space of that size justice. A designer who specialises in smaller spaces would suit you better. Thank you for calling.",
  COMMERCIAL_ABOVE_MAXIMUM:
    "I am sorry, our commercial work is limited to spaces up to about 3,000 sq ft, so this is beyond what we can do well. Thank you for calling.",
  NEEDED_BEFORE_MIN_LEAD_TIME:
    "I am sorry, design and execution need more time than that, and we would not want to rush your project. Please do call us if your timeline can be more flexible.",
  BUDGET_CLEARLY_INSUFFICIENT:
    "Thank you for being open about that. For the scope you describe, I am sorry, I do not think we would be the right fit, and I would rather be honest now. Thank you for calling.",
  EXPLICITLY_NOT_AUTHORISED:
    "Thank you for calling. We work directly with the people who will decide on the project, so please ask the owners to contact us when they are ready.",
};

export function detectEscalation(f: Facts): { kind: EscalationKind; requestedRecipient?: string } | null {
  if (f.isComplaint || (f.callerType === "existing_client" && f.requestedHuman)) {
    return { kind: "existing_client_complaint", requestedRecipient: f.requestedEscalationTo };
  }
  if (f.requestedHuman) return { kind: "human_requested", requestedRecipient: f.requestedEscalationTo };
  return null;
}

/**
 * The central qualification decision. Pure and deterministic: the same facts always give the same
 * result, regardless of any model-generated prose. Mirrors qualified.md "At the boundary".
 */
export function assess(f: Facts): Assessment {
  const escalation = detectEscalation(f);
  const frustrated = f.frustratedPriorEnquiry === true;

  const criteria: CriterionResult[] = [
    assessRealProject(f), assessServiceArea(f), assessTimeline(f), assessBudget(f), assessDecisionMaker(f),
  ];
  const fails = criteria.filter((c) => c.state === "FAIL");
  const unclear = criteria.filter((c) => c.state === "UNCLEAR");

  const uncertainties = unclear.filter((c) => c.number >= 4).map((c) => c.evidence);
  const reviewReasons: string[] = [];
  if (frustrated) reviewReasons.push("Caller reports an earlier enquiry was not followed up — handle with care.");

  const common = {
    ruleVersion: RULE_VERSION,
    criteria,
    uncertainties,
  };

  if (escalation) {
    const urgent = escalation.kind === "existing_client_complaint";
    const bypassed: CriterionResult[] = criteria.map((c) => ({
      id: c.id, number: c.number, state: "NOT_APPLICABLE", reasonCode: "SALES_QUALIFICATION_BYPASSED",
      evidence: `Sales qualification bypassed: ${urgent ? "existing-project complaint" : "caller asked for a person"} goes straight to a human.`,
    }));
    return {
      ...common, criteria: bypassed, uncertainties: [],
      disposition: "ESCALATED",
      reasonCodes: [urgent ? "EXISTING_CLIENT_COMPLAINT" : "HUMAN_REQUESTED"],
      escalation,
      priority: urgent ? "urgent" : "high",
      humanReviewRequired: true,
      humanReviewReasons: [urgent ? "Existing-project complaint / escalation request." : "Caller asked to speak to a person.", ...reviewReasons],
      forwardToDesigner: false,
    };
  }

  const priority: Priority = frustrated ? "high" : "normal";

  if (fails.length >= 2) {
    return {
      ...common, disposition: "DECLINED", reasonCodes: fails.map((c) => c.reasonCode), priority: "normal",
      humanReviewRequired: false, humanReviewReasons: [], closingMessage: DOCUMENTED_DECLINE_MESSAGE, forwardToDesigner: false,
    };
  }
  if (fails.length === 1) {
    const only = fails[0]!;
    return {
      ...common, disposition: "CLOSED_NOT_FORWARDED", reasonCodes: [only.reasonCode], priority: "normal",
      humanReviewRequired: false, humanReviewReasons: [],
      closingMessage: CLOSING_BY_REASON[only.reasonCode] ?? DOCUMENTED_DECLINE_MESSAGE, forwardToDesigner: false,
    };
  }

  const open = unclear.filter((c) => c.number <= 3);
  if (open.length > 0) {
    const keyOf = (n: number) => (n === 1 ? "project" : n === 2 ? "location" : "timeline") as "project" | "location" | "timeline";
    const askableAll = open.filter((c) => !c.reviewFlag || c.reasonCode === "TIGHT_TIMELINE_NEEDS_REVIEW");
    const askable = askableAll.find((c) => !f.clarificationsAsked.includes(keyOf(c.number)));
    const alreadyAsked = askable === undefined;

    if (askable && !alreadyAsked) {
      const text = askable.reasonCode === "TIGHT_TIMELINE_NEEDS_REVIEW" ? QUESTIONS.timelineTight : QUESTIONS[keyOf(askable.number)];
      return {
        ...common, disposition: "NEEDS_CLARIFICATION", reasonCodes: [askable.reasonCode], priority,
        nextQuestion: { criterion: keyOf(askable.number), text },
        humanReviewRequired: false, humanReviewReasons: reviewReasons, forwardToDesigner: false,
      };
    }
    // Asked already (or an edge case the documents don't resolve): a human decides. Never loop.
    const reasons = open.map((c) => (c.reviewFlag ? c.evidence : `${c.evidence} (asked once; still unclear)`));
    return {
      ...common, disposition: "HUMAN_REVIEW", reasonCodes: open.map((c) => c.reasonCode), priority: "high",
      humanReviewRequired: true, humanReviewReasons: [...reasons, ...reviewReasons], forwardToDesigner: false,
    };
  }

  // Everything resolved or only criteria 4/5 are unclear => qualified, uncertainty recorded.
  return {
    ...common, disposition: "QUALIFIED", reasonCodes: criteria.filter((c) => c.state !== "NOT_APPLICABLE").map((c) => c.reasonCode),
    priority, humanReviewRequired: reviewReasons.length > 0, humanReviewReasons: reviewReasons, forwardToDesigner: true,
  };
}
