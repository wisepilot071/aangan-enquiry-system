import { extractBudget, extractFacts } from "@/modules/qualification/extractor";
import { FactsSchema, type Facts } from "@/modules/qualification/facts";
import type { ProviderEvent } from "./types";

/**
 * Maps Vaani's documented webhook payloads (docs.vaanivoice.ai → Guides → Webhook Setup) onto our internal contract.
 *
 * Facts about the payloads that shape this mapping (all from the docs):
 *  - realtime events carry `room_name` but NO event id and NO timestamp → occurredAt is our receipt time (provenance noted);
 *  - `call_ended` arrives BEFORE `call_postprocessing`, which is the only event with transcript/entities → only
 *    postprocessing completes (and qualifies) a call;
 *  - `call_duration` is seconds in `call_ended` but milliseconds in `call_postprocessing`;
 *  - no webhook signature and no cost field are documented.
 */
export type VaaniMapResult =
  | { kind: "event"; event: ProviderEvent }
  | { kind: "ignored"; note: string }
  | { kind: "invalid"; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const isOutboundId = (id: string) => /^outbound/i.test(id);

export function mapVaaniWebhook(payload: unknown, now: Date): VaaniMapResult {
  if (!isObj(payload)) return { kind: "invalid", reason: "payload_not_an_object" };
  const name = str(payload.event);
  if (!name) return { kind: "ignored", note: "payload without an event name acknowledged (for example a connectivity test)" };
  const at = now.toISOString();

  if (name === "call_postprocessing") {
    const data = isObj(payload.data) ? payload.data : {};
    const id = str(data.room_name) ?? str(payload.call_id) ?? str(data.call_id);
    if (!id) return { kind: "invalid", reason: "missing_call_id" };
    const when = str(payload.timestamp);
    const occurred = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : at;
    const ms = num(data.call_duration);
    const durationSec = ms === undefined ? undefined : Math.max(0, Math.round(ms / 1000));
    const transcriptText = str(data.transcript);
    return { kind: "event", event: {
      type: "call.completed", direction: isOutboundId(id) ? "outbound" : "inbound", providerCallId: id, occurredAt: occurred, endedAt: occurred,
      ...(durationSec === undefined ? {} : { durationSec, startedAt: new Date(new Date(occurred).getTime() - durationSec * 1000).toISOString() }),
      ...(transcriptText ? { transcript: parseVaaniTranscript(transcriptText) } : {}),
      ...(isObj(data.entities) ? { structuredFacts: entitiesToFacts(data.entities, new Date(occurred)) } : {}),
      ...(str(data.summary) ? { summary: str(data.summary)!.slice(0, 4000) } : {}),
    } };
  }

  const id = str(payload.room_name) ?? str(payload.call_id);
  if (!id) return { kind: "invalid", reason: "missing_room_name" };
  const direction = isOutboundId(id) ? "outbound" : "inbound";
  const base = { providerCallId: id, occurredAt: at, direction } as const;

  switch (name) {
    case "call_started": {
      const phone = str(payload.phone_number);
      return { kind: "event", event: { ...base, type: "call.started", startedAt: at, ...(phone ? { fromNumber: phone } : {}) } };
    }
    case "user_picked_up_at":
      return { kind: "event", event: { ...base, type: "call.started", startedAt: at } }; // answered; sets nothing if already started
    case "call_ended": {
      const sec = num(payload.call_duration);
      return { kind: "event", event: { ...base, type: "call.ended", endedAt: at, ...(sec === undefined ? {} : { durationSec: Math.round(sec) }) } };
    }
    case "call_no_answer":
      return { kind: "event", event: { ...base, direction: "outbound", type: "call.missed", startedAt: at } };
    case "call_rejected":
      return { kind: "event", event: { ...base, direction: "outbound", type: "call.failed", failureReason: "rejected_or_busy" } };
    case "call_failed":
      return { kind: "event", event: { ...base, direction: "outbound", type: "call.failed", failureReason: (str(payload.error) ?? "call_failed").slice(0, 200) } };
    case "call_ringing":
    case "human_transfer_initiated":
    case "human_transfer_successful":
    case "human_transfer_failed":
      return { kind: "ignored", note: `${name} acknowledged; carries no enquiry data` };
    default:
      return { kind: "ignored", note: `unknown event "${name.slice(0, 60)}" acknowledged and not stored` };
  }
}

/** Handles "[HH:MM:SS] AGENT: …" (webhook) and plain "AGENT: … USER: …" (call_details) transcripts. */
export function parseVaaniTranscript(text: string): { role: "agent" | "caller"; text: string }[] {
  const re = /(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?\b(AGENT|USER)\s*:\s*/g;
  const marks: { role: "agent" | "caller"; start: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ role: m[1] === "AGENT" ? "agent" : "caller", start: m.index, end: re.lastIndex });
  const out: { role: "agent" | "caller"; text: string }[] = [];
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1]!.start : undefined).replace(/\s+/g, " ").trim();
    if (body) out.push({ role: mk.role, text: body.slice(0, 4000) });
  });
  return out.slice(0, 500);
}

const EMPTY = new Set(["", "n/a", "na", "none", "null", "unknown", "not mentioned", "not provided", "not stated", "-"]);
const clean = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return EMPTY.has(s.toLowerCase()) || /transcript is not available/i.test(s) ? undefined : s;
};
const yesNo = (v: unknown): boolean | undefined => {
  const s = clean(v)?.toLowerCase();
  if (!s) return undefined;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => {
  const s = clean(v)?.toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.find((a) => a === s);
};
const number = (v: unknown): number | undefined => {
  const s = clean(v);
  const n = s ? Number(s.replace(/[, ]/g, "").match(/\d+(?:\.\d+)?/)?.[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Converts the post-call data points (see vaani-agent-config.ts) into raw facts. Free-text timeline/budget answers are
 * parsed by the same deterministic code used elsewhere, relative to the call time. The result is still untrusted:
 * the ingestion pipeline validates it with FactsSchema and falls back to human review if it does not fit.
 */
export function entitiesToFacts(e: Obj, callTime: Date): Record<string, unknown> {
  const timeline = clean(e.timeline_text);
  const site = clean(e.site_ready_text);
  const t = timeline || site ? extractFacts([timeline, site].filter(Boolean).join(". "), {}, { now: callTime }) : undefined;
  const budgetText = clean(e.budget_text);
  const out: Record<string, unknown> = {
    callerName: clean(e.caller_name)?.slice(0, 120),
    callerType: yesNo(e.is_existing_client) ? "existing_client" : "new_prospect",
    isComplaint: yesNo(e.is_complaint),
    requestedHuman: yesNo(e.asked_for_person),
    requestedEscalationTo: clean(e.requested_person)?.slice(0, 120),
    projectReference: clean(e.project_reference)?.slice(0, 200),
    frustratedPriorEnquiry: yesNo(e.earlier_enquiry_ignored),
    projectCategory: oneOf(e.project_category, ["residential", "commercial"] as const),
    propertyType: oneOf(e.property_type, ["apartment", "independent_house", "villa", "office", "clinic", "studio", "restaurant", "hotel", "retail", "gym", "other"] as const),
    locationText: clean(e.location)?.slice(0, 200),
    carpetAreaSqft: number(e.carpet_area_sqft),
    scopeKind: oneOf(e.scope_kind, ["full_home", "partial_home", "single_room", "commercial_fitout"] as const),
    roomCount: (() => { const n = number(e.room_count); return n !== undefined && Number.isInteger(n) && n <= 50 ? n : undefined; })(),
    engagement: oneOf(e.engagement, ["design_and_execution", "advice_only", "furniture_only", "vastu_only"] as const),
    completeRedesign: yesNo(e.complete_redesign),
    structuralWork: yesNo(e.structural_work),
    isRented: yesNo(e.is_rented),
    timelineText: timeline?.slice(0, 200),
    siteReadinessText: site?.slice(0, 200),
    needByWeeks: t?.needByWeeks,
    desiredStartWeeks: t?.desiredStartWeeks,
    timelineFlexible: t?.timelineFlexible,
    siteAvailableInWeeks: t?.siteAvailableInWeeks,
    decisionMaker: oneOf(e.decision_maker, ["owner", "authorised_representative", "researching_for_others", "not_authorised", "unknown"] as const) ?? "unknown",
    statedBudgetMaxInr: budgetText ? extractBudget(`budget ${budgetText}`) : undefined,
    consultationInterest: yesNo(e.wants_consultation),
    preferredCallbackText: clean(e.callback_time_text)?.slice(0, 200),
    referralSource: clean(e.referral_source)?.slice(0, 120),
    askedPricing: yesNo(e.asked_price),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  // Defence in depth: a typed-but-unusable result must still be a valid Facts object or the caller falls back to review.
  const parsed = FactsSchema.safeParse(out);
  return parsed.success ? (parsed.data as Facts) : out;
}
