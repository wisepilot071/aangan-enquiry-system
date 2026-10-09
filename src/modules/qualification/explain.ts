import type { CriterionResult, CriterionState } from "./types";

/**
 * Turns the rules engine's result into a plain-language explanation for people who are not reading JSON:
 * what was decided, the five checks in everyday words, and what a human should do next.
 * Pure and deterministic — it only rephrases the stored assessment, it never re-decides anything.
 */
export interface ExplainInput {
  disposition: string | null;
  criteria: CriterionResult[];
  uncertainties?: string[];
  humanReviewReasons?: string[];
  callStatus?: string;
  escalationKind?: string | null;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
export interface Explanation {
  headline: string;
  tone: Tone;
  /** One line, for tables. */
  short: string;
  summary: string;
  checks: { label: string; state: CriterionState; text: string }[];
  nextStep: string;
}

const LABELS: Record<string, string> = {
  real_project: "Wants design + execution",
  service_area: "Property in Pune / PCMC",
  realistic_timeline: "Realistic timeline",
  budget_band: "Budget (never asked)",
  decision_maker: "Decision-maker",
};

const FRIENDLY: Record<string, string> = {
  DESIGN_AND_EXECUTION_CONFIRMED: "Wants design with execution.",
  COMPLETE_PROJECT_SCOPE: "A complete project, not advice only.",
  SINGLE_ROOM_COMPLETE_REDESIGN: "One room, complete redesign with execution.",
  PROJECT_TYPE_UNCLEAR: "It was not clear whether they want full design and execution.",
  ENGAGEMENT_ADVICE_ONLY: "They want advice only; the studio does design and execution together.",
  ENGAGEMENT_FURNITURE_ONLY: "They want furniture on its own, which the studio does not offer.",
  ENGAGEMENT_VASTU_ONLY: "They want Vastu advice on its own, which the studio does not offer.",
  PROPERTY_TYPE_OUT_OF_SCOPE: "This kind of property (restaurant, hotel, shop or gym) is outside what the studio does.",
  SINGLE_ROOM_NOT_COMPLETE: "A single room without a complete redesign is below the studio's minimum.",
  STRUCTURAL_WORK_REQUESTED: "They want structural changes; the studio does interiors only.",
  COMMERCIAL_BELOW_MINIMUM: "The commercial space is smaller than the studio takes on.",
  COMMERCIAL_ABOVE_MAXIMUM: "The commercial space is larger than the studio takes on.",
  COMMERCIAL_NEAR_MAXIMUM: "The commercial space is slightly above the usual limit; a person should decide.",
  LOCATION_UNKNOWN: "The location was not given.",
  LOCATION_NOT_RECOGNISED: "The place mentioned could not be matched to Pune or PCMC.",
  OUTSIDE_SERVICE_AREA: "The property is outside Pune and PCMC.",
  NEEDED_BEFORE_MIN_LEAD_TIME: "They need it done sooner than the studio can start execution (under 6 weeks).",
  TIGHT_TIMELINE_NEEDS_REVIEW: "The deadline is tight (6–10 weeks); a person should judge whether it is workable.",
  SITE_AVAILABLE_AFTER_WINDOW: "The site will not be available for more than 10 weeks.",
  TIMELINE_UNKNOWN: "When they need it done was not captured.",
  TIMELINE_REALISTIC: "The timeline is workable.",
  BUDGET_NOT_DISCLOSED: "No budget was mentioned. The agent never asks, so this does not count against the lead.",
  SCOPE_TOO_VAGUE_TO_COMPARE: "A budget was mentioned but the scope was too vague to compare.",
  BUDGET_NOT_OBVIOUSLY_MISALIGNED: "The budget they mentioned is not obviously too low.",
  CALLER_IS_DECISION_MAKER: "The caller is the owner or decision-maker.",
  AUTHORISED_REPRESENTATIVE: "The caller is authorised to act for the owner.",
  DECISION_MAKER_UNKNOWN: "Not stated who decides. The agent does not press; the designer will confirm.",
  RESEARCHING_FOR_OTHERS: "The caller is researching for family; the owner's go-ahead is not confirmed yet.",
  EXPLICITLY_NOT_AUTHORISED: "The caller said they are not the decision-maker.",
  SALES_QUALIFICATION_BYPASSED: "Not a sales enquiry, so the lead checks were skipped.",
};

const strip = (s: string) => s.replace(/\s*\((?:services|qualified)\.md[^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();

function textFor(c: CriterionResult): string {
  if (c.reasonCode === "BUDGET_CLEARLY_INSUFFICIENT") return strip(c.evidence);
  if (c.reasonCode === "IN_SERVICE_AREA") return `${strip(c.evidence).replace(/ is within Pune\/PCMC\.?/, "").replace(/"/g, "")} is in the studio's area.`;
  return FRIENDLY[c.reasonCode] ?? strip(c.evidence);
}

export function explain(i: ExplainInput): Explanation {
  const checks = i.criteria.map((c) => ({ label: LABELS[c.id] ?? c.id, state: c.state, text: textFor(c) }));
  const fails = i.criteria.filter((c) => c.state === "FAIL");
  const unclear = i.criteria.filter((c) => c.state === "UNCLEAR");
  const failText = fails.map(textFor);

  switch (i.disposition) {
    case "QUALIFIED": {
      const notes = [...(i.uncertainties ?? [])];
      return {
        headline: "Good lead — hand to a designer", tone: "ok", short: "Good lead: passes the studio's checks",
        summary: `Every check that matters passed${unclear.length ? `; ${unclear.length === 1 ? "one detail is" : "a few details are"} still unknown and noted for the designer` : ""}.${notes.length ? ` Open points: ${notes.join(" ")}` : ""}`,
        checks, nextStep: "A designer should contact the caller and confirm a consultation time. Nothing has been booked yet.",
      };
    }
    case "CLOSED_NOT_FORWARDED":
      return {
        headline: "Not forwarded — does not fit", tone: "neutral", short: `Not forwarded: ${failText[0] ?? "does not fit"}`.slice(0, 140),
        summary: `One clear check failed, so the caller was thanked politely and no designer was bothered. ${failText.join(" ")}`,
        checks, nextStep: "No action needed. If you disagree, open the transcript and change the outcome with a reason.",
      };
    case "DECLINED":
      return {
        headline: "Declined — more than one check failed", tone: "neutral", short: `Declined: ${failText.join(" ")}`.slice(0, 140),
        summary: `Two or more checks clearly failed. ${failText.join(" ")}`,
        checks, nextStep: "No action needed.",
      };
    case "HUMAN_REVIEW":
    case "NEEDS_CLARIFICATION": {
      const reasons = (i.humanReviewReasons ?? []).filter(Boolean);
      const nothing = reasons.some((r) => /No usable data/i.test(r));
      return {
        headline: nothing ? "Nothing usable was captured" : "Needs a person to decide", tone: "warn",
        short: nothing ? "Nothing usable captured (audio unclear or caller left)" : `Needs review: ${reasons[0] ?? unclear.map(textFor)[0] ?? "details unclear"}`.slice(0, 140),
        summary: nothing ? "The call ended without enough information to judge it. Listen to or read the transcript, and call back if it looks like a real enquiry."
          : `The rules could not decide on their own. ${reasons.join(" ")}${fails.length ? ` ${failText.join(" ")}` : ""}`.trim(),
        checks, nextStep: "Read the transcript, decide, then press “Mark human review resolved”. Call the person back if they look genuine.",
      };
    }
    case "ESCALATED":
      return {
        headline: i.escalationKind === "existing_client_complaint" ? "Urgent — existing client needs a person" : "A person was requested",
        tone: "bad", short: i.escalationKind === "existing_client_complaint" ? "Urgent: existing-client complaint" : "Caller asked for a person",
        summary: "This was not treated as a sales lead. The caller asked for, or needs, a human response. No callback time was promised to them.",
        checks: [], nextStep: "Call back as soon as possible and close the follow-up task afterwards.",
      };
    default:
      return {
        headline: i.callStatus === "missed" ? "Missed call" : i.callStatus === "disconnected" ? "Call dropped" : i.callStatus === "failed" ? "Call failed" : "Call in progress or not yet processed",
        tone: i.callStatus === "in_progress" ? "info" : "warn",
        short: i.callStatus === "in_progress" ? "No decision yet (call not finished or still processing)" : `No decision: call ${i.callStatus ?? "unprocessed"}`,
        summary: "There is no transcript, so nothing could be assessed.", checks: [],
        nextStep: i.callStatus === "in_progress" ? "Wait a minute or two for the call to finish processing, or use “Import this call”." : "Follow up manually if this was a real caller; no automatic callback is made.",
      };
  }
}
