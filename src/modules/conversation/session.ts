import { APPROVED_PRICING_RESPONSE, isPricingFollowUp, requiresPricingResponse, sanitizeOutbound } from "../pricing-guardrails";
import { assess } from "../qualification/engine";
import { extractFacts } from "../qualification/extractor";
import { FactsSchema, type Facts } from "../qualification/facts";
import type { Assessment } from "../qualification/types";

export const OPENING_MESSAGE =
  "Namaste, and a warm welcome to Aangan Studio. I am the studio's virtual assistant, and it is a pleasure to speak with you. How may I help you today, please?";

export interface Turn {
  role: "agent" | "caller";
  text: string;
}

export interface SessionState {
  facts: Facts;
  turns: Turn[];
  pricingAsks: number;
  /** Set when a pricing answer was given and the next question is still owed. */
  lastAgentQuestion?: string;
  closed: boolean;
}

export interface TurnResult {
  state: SessionState;
  /** Spoken in order. For pricing questions messages[0] is exactly the approved response. */
  messages: string[];
  assessment: Assessment;
  pricingGuardrailTriggered: boolean;
  outboundSanitized: boolean;
}

export function newSession(): SessionState {
  return { facts: FactsSchema.parse({}), turns: [{ role: "agent", text: OPENING_MESSAGE }], pricingAsks: 0, closed: false };
}

function composeMessages(a: Assessment, f: Facts): { messages: string[]; question?: string } {
  const who = f.callerName ? `, ${f.callerName.split(" ")[0]}` : "";
  switch (a.disposition) {
    case "ESCALATED": {
      const to = a.escalation?.requestedRecipient ? ` for ${a.escalation.requestedRecipient}` : "";
      const needDetails = !f.callerName || !(f.projectReference || f.locationText);
      const body = needDetails
        ? "I am very sorry about this. May I please take your name and project location?"
        : `Thank you${who}, and I am very sorry. I have noted your request${to} as urgent and passed it to the team. I cannot confirm a callback time on this call.`;
      return { messages: [body] };
    }
    case "NEEDS_CLARIFICATION":
      return { messages: [a.nextQuestion!.text], question: a.nextQuestion!.text };
    case "QUALIFIED": {
      const consult = f.consultationInterest
        ? " I have noted that you would like a consultation. It is not booked yet; our team will confirm a time."
        : " Our team will follow up.";
      return { messages: [`Thank you${who}. I have noted your details for our design team.${consult} I am sorry I cannot confirm a time on this call.`] };
    }
    case "HUMAN_REVIEW":
      return { messages: [`Thank you${who}. I have noted your details for our team to review. I am sorry I cannot confirm a time on this call.`] };
    case "CLOSED_NOT_FORWARDED":
    case "DECLINED":
      return { messages: [a.closingMessage!] };
  }
}

/** One caller turn → next agent reply. The same path serves mock calls and regression tests. */
export function processCallerTurn(
  state: SessionState,
  utterance: string,
  ctx: { now: Date; factOverrides?: Partial<Facts> } = { now: new Date() },
): TurnResult {
  const prevFacts = state.facts;
  let facts = extractFacts(utterance, prevFacts, { now: ctx.now, lastAgentQuestion: state.lastAgentQuestion });
  if (ctx.factOverrides) facts = FactsSchema.parse({ ...facts, ...ctx.factOverrides });

  const pricing = requiresPricingResponse(utterance) || (state.pricingAsks > 0 && isPricingFollowUp(utterance));
  if (pricing) facts = { ...facts, askedPricing: true };

  const a = assess(facts);
  const composed = composeMessages(a, facts);

  let messages: string[];
  if (pricing && a.disposition !== "ESCALATED") {
    // Approved response is delivered verbatim, then any owed question is asked as a separate utterance.
    messages = [APPROVED_PRICING_RESPONSE];
    if (composed.question) messages.push(composed.question);
  } else {
    messages = composed.messages;
  }

  let sanitized = false;
  messages = messages.map((m) => {
    const r = sanitizeOutbound(m);
    sanitized ||= r.replaced;
    return r.text;
  });

  const asked = a.nextQuestion?.criterion;
  const nextFacts: Facts = asked && !facts.clarificationsAsked.includes(asked)
    ? { ...facts, clarificationsAsked: [...facts.clarificationsAsked, asked] }
    : facts;

  const next: SessionState = {
    facts: nextFacts,
    turns: [
      ...state.turns,
      { role: "caller", text: utterance },
      ...messages.map((text) => ({ role: "agent" as const, text })),
    ],
    pricingAsks: state.pricingAsks + (pricing ? 1 : 0),
    lastAgentQuestion: composed.question ?? messages[messages.length - 1],
    closed: ["CLOSED_NOT_FORWARDED", "DECLINED"].includes(a.disposition),
  };
  return { state: next, messages, assessment: a, pricingGuardrailTriggered: pricing, outboundSanitized: sanitized };
}
