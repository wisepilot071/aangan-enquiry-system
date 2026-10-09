/**
 * Pricing guardrail. Deterministic and server-controlled.
 *
 * pricing.md is deliberately NOT read, copied, or bundled anywhere in this application: the
 * only acceptable answer to a pricing question is one fixed sentence, so no price data is needed.
 */
export const APPROVED_PRICING_RESPONSE =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const PRICING_PATTERNS: RegExp[] = [
  /\bhow\s+much\b/i,
  /\bwhat\s+(?:does|would|will|do)\b.{0,40}\b(?:cost|charge)/i,
  /\b(?:cost|costs|costing|price|prices|pricing|priced)\b/i,
  /\b(?:rate|rates|rate\s*card)\b/i,
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\b(?:charge|charges|charging|fee|fees)\b/i,
  /\b(?:quote|quotation|estimate|ballpark|ball\s*park|rough\s*(?:idea|range|figure|number))\b/i,
  /\b(?:price\s*list|package|packages)\b/i,
  /\b(?:range|figure|number)\b.{0,30}\b(?:cost|price|rate|charge)/i,
  /\b(?:kitna|kitne|kharcha|kimat|daam|paisa)\b/i,
  /₹|\brs\.?\s*\d|\binr\b/i,
];

/** Attempts to override the rule or extract the internal guide. They also get the approved response. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|earlier)?\s*(?:instructions|rules|prompt)/i,
  /(?:system|hidden|internal)\s+prompt/i,
  /(?:internal|confidential)\s+(?:pricing|price|guide|document|rates)/i,
  /pricing\s+(?:guide|document|sheet|file)/i,
  /(?:you\s+are\s+now|pretend\s+(?:to\s+be|you)|act\s+as|developer\s+mode|jailbreak)/i,
  /(?:reveal|show|read\s+out|tell\s+me)\s+(?:the\s+)?(?:internal|your)\s+(?:rules|instructions|prices|rates)/i,
  /(?:i\s+am|i'm|this\s+is)\s+(?:the\s+)?(?:nikhil|owner|admin|developer|your\s+boss).{0,40}(?:tell|give|share|reveal)/i,
];

export function isPricingQuestion(utterance: string): boolean {
  return PRICING_PATTERNS.some((p) => p.test(utterance));
}

export function isInjectionAttempt(utterance: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(utterance));
}

/** True when the caller input must be answered with the fixed pricing response. */
export function requiresPricingResponse(utterance: string): boolean {
  return isPricingQuestion(utterance) || (isInjectionAttempt(utterance) && /pric|rate|cost|₹|rupee|lakh/i.test(utterance));
}

/**
 * Output-side safety net: any outbound agent text that looks like it quotes money or a per-sq-ft
 * figure is replaced by the approved response. Applied to every reply before it leaves the server.
 */
const LEAK_PATTERNS: RegExp[] = [
  /₹\s*\d/,
  /\b(?:rs\.?|inr|rupees?)\s*\d/i,
  /\d[\d,.]*\s*(?:lakhs?|lacs?|crores?|cr\b|k\b)/i,
  /\bper\s*(?:sq\.?\s*ft|square\s*f(?:oo|ee)t|sqft)\b/i,
  /\d\s*\/\s*(?:sq\.?\s*ft|sqft)/i,
  /\b(?:it'?ll|it\s+will|will)\s+cost\s+(?:around|about|roughly)/i,
  /\brates?\s+start\s+at\b/i,
  /\btypically\s+(?:₹|rs|costs?)/i,
];

export function containsPricingLeak(text: string): boolean {
  return LEAK_PATTERNS.some((p) => p.test(text));
}

export function sanitizeOutbound(text: string): { text: string; replaced: boolean } {
  if (containsPricingLeak(text)) return { text: APPROVED_PRICING_RESPONSE, replaced: true };
  return { text, replaced: false };
}

/**
 * After a pricing question, short insistent follow-ups ("just a number", "even a range", "ballpark") are still
 * pricing questions. Deliberately narrow: ordinary words such as "starting" or "minimum" must not hijack
 * a normal answer (e.g. "starting design from October").
 */
export function isPricingFollowUp(utterance: string): boolean {
  return /\b(?:just|even|any|a|some|your)\s+(?:rough\s+|approximate\s+)?(?:number|range|figure|ballpark|estimate|idea\s+of\s+(?:the\s+)?(?:cost|price))\b|\bball\s*park\b|\brough(?:ly)?\s+(?:idea|range|figure|number|estimate)\b|\bapprox(?:imate|imately)?\s+(?:cost|price|figure|number|range)\b|\b(?:average|typical|standard)\s+(?:cost|price|rate)\b/i.test(utterance);
}
