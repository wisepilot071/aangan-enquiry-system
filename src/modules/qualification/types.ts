export type CriterionState = "PASS" | "FAIL" | "UNCLEAR" | "NOT_APPLICABLE";
export type CriterionId = "real_project" | "service_area" | "realistic_timeline" | "budget_band" | "decision_maker";

export interface CriterionResult {
  id: CriterionId;
  number: 1 | 2 | 3 | 4 | 5;
  state: CriterionState;
  reasonCode: string;
  /** Concise, evidence-based explanation (no hidden reasoning, never contains internal price data). */
  evidence: string;
  /** Raised for human review even if the lead proceeds. */
  reviewFlag?: boolean;
}

export type Disposition =
  | "QUALIFIED"
  | "NEEDS_CLARIFICATION"
  | "CLOSED_NOT_FORWARDED" // exactly one criterion clearly failed
  | "DECLINED" // two or more criteria clearly failed
  | "HUMAN_REVIEW" // edge case the documents do not resolve
  | "ESCALATED"; // complaint / human requested — bypasses sales qualification

export type EscalationKind = "existing_client_complaint" | "human_requested";
export type Priority = "normal" | "high" | "urgent";

export interface Assessment {
  ruleVersion: string;
  disposition: Disposition;
  criteria: CriterionResult[];
  reasonCodes: string[];
  uncertainties: string[];
  /** The single direct question to ask next (only for NEEDS_CLARIFICATION). */
  nextQuestion?: { criterion: "project" | "location" | "timeline"; text: string };
  escalation?: { kind: EscalationKind; requestedRecipient?: string };
  priority: Priority;
  humanReviewRequired: boolean;
  humanReviewReasons: string[];
  /** Customer-facing close text for CLOSED_NOT_FORWARDED / DECLINED. */
  closingMessage?: string;
  /** Forward to a designer with the normal hand-off? */
  forwardToDesigner: boolean;
}
