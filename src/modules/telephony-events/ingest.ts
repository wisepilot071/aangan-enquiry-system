import crypto from "node:crypto";
import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { callEvents, enquiries, followUpTasks, qualificationAssessments } from "@/db/schema";
import { audit } from "@/modules/audit";
import { computeCallCosts, getRates, recordCosts } from "@/modules/costs";
import { dispatchNotification, createNotification, type DispatchDeps, type NotificationCategory } from "@/modules/notifications/service";
import { enquiryRef, formatCallUpdate, formatMissedCall, formatQualifiedHandoff, formatUrgentEscalation } from "@/modules/notifications/format";
import { containsPricingLeak } from "@/modules/pricing-guardrails";
import { assess } from "@/modules/qualification/engine";
import { explain } from "@/modules/qualification/explain";
import { NO_USABLE_DATA_REASON } from "@/modules/analytics/metrics";
import { extractFacts } from "@/modules/qualification/extractor";
import { FactsSchema, parseFacts, type Facts } from "@/modules/qualification/facts";
import type { Assessment } from "@/modules/qualification/types";
import type { ProviderEvent, VoiceProvider } from "@/modules/voice-provider/types";

export const MAX_BODY_BYTES = 256 * 1024;
/** A reconnect within this window of a dropped call, from the same verified number, is linked (never merged). */
export const RECONNECT_WINDOW_MS = 30 * 60 * 1000;

export type IngestStatus = "processed" | "duplicate" | "rejected" | "failed" | "ignored";
export interface IngestOutcome {
  httpStatus: number;
  status: IngestStatus;
  enquiryId?: string;
  reason?: string;
}
export interface IngestDeps extends DispatchDeps {
  now?: Date;
  baseUrl?: string;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** Phrases the agent must never say (booking/callback/transfer commitments). Heuristic, used only to flag for review. */
const FALSE_PROMISE = /\b(?:i(?:'ve| have)|we(?:'ve| have)) (?:booked|confirmed|scheduled)\b|\b(?:consultation|visit|appointment|site visit) (?:is|has been|have been) (?:booked|confirmed|scheduled)\b|\btransferring (?:you|your call)\b|\bconnecting you (?:to|with)\b|\bwill (?:call|ring|contact) you (?:at|in|within|by|tomorrow|today)\b/i;
const TERMINAL = new Set(["completed", "missed", "disconnected", "failed"]);
const statusFor: Record<ProviderEvent["type"], string> = {
  "call.started": "in_progress", "call.responded": "in_progress", "call.ended": "in_progress", "call.completed": "completed",
  "call.missed": "missed", "call.disconnected": "disconnected", "call.failed": "failed",
};

/** Describes a JSON payload by field names and value types only — never values — so rejections can be diagnosed without storing content. */
export function payloadShape(raw: string, depth = 0): string {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return "not-json"; }
  const walk = (x: unknown, d: number): string => {
    if (x === null) return "null";
    if (Array.isArray(x)) return `array(${x.length})`;
    if (typeof x !== "object") return typeof x;
    if (d >= 2) return "object";
    return `{${Object.entries(x as Record<string, unknown>).slice(0, 30).map(([k, val]) => `${k.slice(0, 40)}:${walk(val, d + 1)}`).join(",")}}`;
  };
  return walk(v, depth).slice(0, 600);
}

async function recordRejected(db: Db, provider: string, rawBody: string, reason: string, now: Date, type = "unknown") {
  await db.insert(callEvents).values({
    provider, eventKey: `rejected:${sha(rawBody)}:${now.getTime()}:${crypto.randomUUID()}`, eventType: type,
    status: "rejected", errorCategory: reason, errorDetail: `payload ${rawBody.length} bytes, content not stored; shape ${payloadShape(rawBody)}`,
    isDemo: provider === "mock",
  });
  await audit(db, { actor: "provider", action: "webhook.rejected", entityType: "call_event", detail: { provider, reason } });
}

/** HTTP-facing entry: size limit → signature (fail closed) → parse/validate → idempotent processing. */
export async function ingestWebhook(
  db: Db, provider: VoiceProvider, rawBody: string, headers: Headers | Record<string, string | undefined>, deps: IngestDeps & { url?: string } = {},
): Promise<IngestOutcome> {
  const now = deps.now ?? new Date();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    await recordRejected(db, provider.id, rawBody.slice(0, 0), "payload_too_large", now);
    return { httpStatus: 413, status: "rejected", reason: "payload_too_large" };
  }
  const v = provider.verifyWebhook({ rawBody, headers, now, url: deps.url });
  if (!v.ok) {
    await recordRejected(db, provider.id, rawBody, v.reason, now);
    return { httpStatus: 401, status: "rejected", reason: v.reason };
  }
  const p = provider.parseEvent(rawBody);
  if (!p.ok) {
    await recordRejected(db, provider.id, rawBody, p.reason.slice(0, 120), now);
    return { httpStatus: 400, status: "rejected", reason: p.reason };
  }
  if ("ignored" in p) {
    await db.insert(callEvents).values({
      provider: provider.id, eventKey: `ignored:${sha(rawBody)}`, eventType: "ignored", status: "ignored",
      errorCategory: p.note.slice(0, 120), isDemo: provider.id === "mock",
    }).onConflictDoNothing();
    return { httpStatus: 200, status: "ignored", reason: p.note };
  }
  // Authoritative data is pulled from the provider's own API where supported (best effort; never throws).
  const event = provider.enrichEvent ? await provider.enrichEvent(p.event).catch(() => p.event) : p.event;
  return ingestEvent(db, provider.id, event, event.eventId ?? sha(rawBody), deps);
}

/** Processes one already-verified, already-validated event. Idempotent per (provider, eventKey). */
export async function ingestEvent(
  db: Db, providerId: "mock" | "vaani", event: ProviderEvent, eventKey: string, deps: IngestDeps = {},
): Promise<IngestOutcome> {
  const now = deps.now ?? new Date();
  const isDemo = providerId === "mock";

  const [inserted] = await db.insert(callEvents).values({
    provider: providerId, eventKey, providerCallId: event.providerCallId, eventType: event.type,
    occurredAt: new Date(event.occurredAt), status: "received", isDemo,
  }).onConflictDoNothing().returning({ id: callEvents.id });

  let eventRowId = inserted?.id;
  if (!eventRowId) {
    const [existing] = await db.select().from(callEvents).where(and(eq(callEvents.provider, providerId), eq(callEvents.eventKey, eventKey)));
    if (existing && existing.status === "failed") {
      eventRowId = existing.id; // provider retry of an event that failed earlier → process again
      await db.update(callEvents).set({ attempts: existing.attempts + 1, status: "received" }).where(eq(callEvents.id, existing.id));
    } else {
      if (existing) await db.update(callEvents).set({ attempts: existing.attempts + 1 }).where(eq(callEvents.id, existing.id));
      return { httpStatus: 200, status: "duplicate", enquiryId: existing?.enquiryId ?? undefined, reason: "event_already_processed" };
    }
  }

  const toDispatch: string[] = [];
  try {
    const result = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      return applyEvent(tx, providerId, event, isDemo, now, deps, toDispatch);
    });
    await db.update(callEvents).set({ status: result.status, enquiryId: result.enquiryId, errorCategory: result.reason ?? null }).where(eq(callEvents.id, eventRowId));
    for (const id of toDispatch) {
      try { await dispatchNotification(db, id, deps); } catch { /* recorded inside dispatch; never lose the enquiry */ }
    }
    return { httpStatus: 200, ...result };
  } catch (e) {
    const detail = (e instanceof Error ? e.message : "unknown").replace(/\s+/g, " ").slice(0, 200);
    await db.update(callEvents).set({ status: "failed", errorCategory: "processing_error", errorDetail: detail }).where(eq(callEvents.id, eventRowId));
    await audit(db, { actor: "system", action: "event.processing_failed", entityType: "call_event", entityId: eventRowId, detail: { error: detail } });
    return { httpStatus: 500, status: "failed", reason: "processing_error" };
  }
}

async function applyEvent(
  tx: Db, providerId: "mock" | "vaani", event: ProviderEvent, isDemo: boolean, now: Date, deps: IngestDeps, toDispatch: string[],
): Promise<{ status: IngestStatus; enquiryId: string; reason?: string }> {
  const direction = event.direction ?? "inbound";
  const created = await tx.insert(enquiries).values({
    provider: providerId, providerCallId: event.providerCallId, isDemo, direction,
  }).onConflictDoNothing().returning({ id: enquiries.id });
  const [row] = await tx.select().from(enquiries)
    .where(and(eq(enquiries.provider, providerId), eq(enquiries.providerCallId, event.providerCallId))).for("update");
  if (!row) throw new Error("enquiry upsert failed");
  const ref = enquiryRef(row.seq);
  if (created.length) await audit(tx, { actor: "provider", action: "enquiry.created", entityType: "enquiry", entityId: row.id, detail: { ref, provider: providerId, demo: isDemo } });

  const occurred = new Date(event.occurredAt);
  const patch: Partial<typeof enquiries.$inferInsert> = { updatedAt: now, direction };
  if (event.fromNumber && !row.callerPhone) patch.callerPhone = event.fromNumber;
  if (event.type === "call.started" || event.startedAt) patch.callStartedAt = row.callStartedAt ?? new Date(event.startedAt ?? event.occurredAt);
  if (!patch.callStartedAt && !row.callStartedAt && event.type !== "call.responded") patch.callStartedAt = occurred;
  if (event.firstAgentResponseAt) patch.firstResponseAt = row.firstResponseAt ?? new Date(event.firstAgentResponseAt);
  else if (event.type === "call.responded") patch.firstResponseAt = row.firstResponseAt ?? occurred;
  if (event.endedAt) patch.callEndedAt = new Date(event.endedAt);
  if (event.durationSec !== undefined) patch.durationSec = event.durationSec;

  const newStatus = statusFor[event.type];
  const alreadyCompleted = row.callStatus === "completed";
  // Terminal states never regress to in_progress; "completed" may supersede disconnected/failed.
  if (!TERMINAL.has(row.callStatus) || newStatus === "completed") patch.callStatus = newStatus;

  if (event.type === "call.completed" && alreadyCompleted) {
    await tx.update(enquiries).set(patch).where(eq(enquiries.id, row.id));
    return { status: "duplicate", enquiryId: row.id, reason: "call_already_completed" };
  }
  if (["call.missed", "call.disconnected", "call.failed", "call.completed"].includes(event.type) && !patch.callEndedAt) patch.callEndedAt = occurred;

  // --- reconnect correlation: verified number + short window only; never a guess from identity ---
  const phone = patch.callerPhone ?? row.callerPhone;
  const startedForLink = (patch.callStartedAt ?? row.callStartedAt) ?? occurred;
  if (direction === "inbound" && phone && !row.previousEnquiryId && event.type !== "call.responded") {
    const [prev] = await tx.select().from(enquiries).where(and(
      eq(enquiries.callerPhone, phone), ne(enquiries.id, row.id), eq(enquiries.isDemo, isDemo), eq(enquiries.callStatus, "disconnected"),
      gte(enquiries.callEndedAt, new Date(startedForLink.getTime() - RECONNECT_WINDOW_MS)), lte(enquiries.callEndedAt, startedForLink),
    )).orderBy(desc(enquiries.callEndedAt)).limit(1);
    if (prev) {
      patch.previousEnquiryId = prev.id;
      await tx.update(followUpTasks).set({ status: "done", completedAt: now, completedBy: "system", note: `Caller reconnected (${ref}).` })
        .where(and(eq(followUpTasks.enquiryId, prev.id), eq(followUpTasks.kind, "dropped_call"), eq(followUpTasks.status, "open")));
      await audit(tx, { actor: "system", action: "enquiry.linked_reconnect", entityType: "enquiry", entityId: row.id, detail: { previous: enquiryRef(prev.seq) } });
    }
  }

  // --- non-completed outcomes ---
  if (event.type === "call.missed" || event.type === "call.disconnected" || event.type === "call.failed") {
    await tx.update(enquiries).set(patch).where(eq(enquiries.id, row.id));
    if (direction === "outbound") {
      // Operator test calls: recorded accurately, but there is no caller to follow up.
      await audit(tx, { actor: "provider", action: `call.${event.type.split(".")[1]}`, entityType: "enquiry", entityId: row.id, detail: { ref, direction, reason: event.failureReason } });
      return { status: "processed", enquiryId: row.id };
    }
    const kind = event.type === "call.missed" ? "missed_call" : "dropped_call";
    const note = event.type === "call.failed" ? `Provider reported call failure${event.failureReason ? `: ${event.failureReason}` : ""}.`
      : event.type === "call.missed" ? "Missed call, no transcript. Follow up manually." : "Call disconnected before completion. Follow up if the caller does not call back.";
    await tx.insert(followUpTasks).values({ enquiryId: row.id, kind, note, isDemo }).onConflictDoNothing();
    if (event.type === "call.missed") {
      const text = formatMissedCall({ ref, enquiryId: row.id, at: (patch.callStartedAt ?? row.callStartedAt) ?? occurred, phone, isDemo, kind: "missed", baseUrl: deps.baseUrl });
      const nid = await createNotification(tx, { enquiryId: row.id, isDemo }, "missed_call_followup", text);
      if (nid) toDispatch.push(nid);
    }
    await audit(tx, { actor: "provider", action: `call.${event.type.split(".")[1]}`, entityType: "enquiry", entityId: row.id, detail: { ref } });
    return { status: "processed", enquiryId: row.id };
  }

  // --- in-progress events ---
  if (event.type !== "call.completed") {
    await tx.update(enquiries).set(patch).where(eq(enquiries.id, row.id));
    return { status: "processed", enquiryId: row.id };
  }

  // --- what the agent actually said: post-call guardrail audit (the live voice model cannot be intercepted mid-call) ---
  const agentLines = (event.transcript ?? []).filter((t) => t.role === "agent").map((t) => t.text);
  const guardrailNotes: string[] = [];
  if (agentLines.some((t) => containsPricingLeak(t))) guardrailNotes.push("GUARDRAIL: the agent appears to have quoted a price. Review the transcript and retrain the prompt.");
  if (agentLines.some((t) => FALSE_PROMISE.test(t))) guardrailNotes.push("GUARDRAIL: the agent appears to have promised a booking, callback time or transfer. Review the transcript.");
  if (guardrailNotes.length) await audit(tx, { actor: "system", action: "guardrail.violation_detected", entityType: "enquiry", entityId: row.id, detail: { ref, notes: guardrailNotes } });

  // --- outbound test call: keep the record (transcript, summary, cost) but never qualify or hand it off ---
  if (direction === "outbound") {
    Object.assign(patch, {
      callStatus: "completed", transcript: event.transcript ?? null, summary: event.summary ?? "Outbound test call", recordCompletedAt: now,
      needsHumanReview: guardrailNotes.length > 0, humanReviewReasons: guardrailNotes, humanReviewStatus: guardrailNotes.length ? "open" : "none",
      ...(guardrailNotes.length ? { priority: "high" } : {}),
    });
    await tx.update(enquiries).set(patch).where(eq(enquiries.id, row.id));
    const drafts = computeCallCosts({ providerCost: event.cost, durationSec: patch.durationSec ?? row.durationSec ?? event.durationSec, rates: await getRates(tx) });
    await recordCosts(tx, { enquiryId: row.id, providerCallId: event.providerCallId, provider: providerId, isDemo }, drafts);
    await audit(tx, { actor: "provider", action: "call.completed", entityType: "enquiry", entityId: row.id, detail: { ref, direction, qualified: false } });
    return { status: "processed", enquiryId: row.id };
  }

  // --- completed: qualify, persist, notify, cost ---
  const { facts, assessment, notes: qualNotes } = qualifyCompletedCall(event, providerId);
  const notes = [...qualNotes, ...guardrailNotes];
  const reviewReasons = [...assessment.humanReviewReasons, ...notes];
  const needsReview = assessment.humanReviewRequired || notes.length > 0;
  const transcriptRows = event.transcript ?? null;

  Object.assign(patch, {
    callStatus: "completed",
    facts, callerName: facts.callerName ?? row.callerName, callerType: facts.callerType,
    projectCategory: facts.projectCategory ?? null, propertyType: facts.propertyType ?? null,
    locationText: facts.locationText ?? null, carpetAreaSqft: facts.carpetAreaSqft ? Math.round(facts.carpetAreaSqft) : null,
    transcript: transcriptRows, summary: event.summary ?? summarise(facts, assessment),
    disposition: assessment.disposition, decisionReason: explain({ disposition: assessment.disposition, criteria: assessment.criteria, uncertainties: assessment.uncertainties, humanReviewReasons: reviewReasons, escalationKind: assessment.escalation?.kind }).short, priority: guardrailNotes.length && assessment.priority === "normal" ? "high" : assessment.priority,
    needsHumanReview: needsReview, humanReviewReasons: reviewReasons, humanReviewStatus: needsReview ? "open" : "none",
    consultationStatus: facts.consultationInterest ? "requested" : row.consultationStatus,
    escalationKind: assessment.escalation?.kind ?? null, escalationRecipient: assessment.escalation?.requestedRecipient ?? null,
    qualifiedAt: now, recordCompletedAt: now, ruleVersion: assessment.ruleVersion,
  });
  await tx.update(enquiries).set(patch).where(eq(enquiries.id, row.id));
  await tx.insert(qualificationAssessments).values({
    enquiryId: row.id, ruleVersion: assessment.ruleVersion, disposition: assessment.disposition, criteria: assessment.criteria,
    reasonCodes: assessment.reasonCodes, uncertainties: assessment.uncertainties, nextQuestion: assessment.nextQuestion?.text ?? null,
  });
  await audit(tx, { actor: "system", action: "qualification.completed", entityType: "enquiry", entityId: row.id, detail: { ref, disposition: assessment.disposition, reasons: assessment.reasonCodes, rule: assessment.ruleVersion } });
  if (assessment.disposition === "CLOSED_NOT_FORWARDED" || assessment.disposition === "DECLINED") {
    await audit(tx, { actor: "system", action: "lead.declined", entityType: "enquiry", entityId: row.id, detail: { ref, reasons: assessment.reasonCodes } });
  }

  const mctx = {
    ref, enquiryId: row.id, receivedAt: (patch.callStartedAt ?? row.callStartedAt) ?? occurred, callerName: facts.callerName ?? row.callerName,
    callerPhone: phone, isDemo, baseUrl: deps.baseUrl, facts, assessment, summary: event.summary ?? summarise(facts, assessment),
  };
  const queue = async (category: NotificationCategory, text: string) => {
    const id = await createNotification(tx, { enquiryId: row.id, isDemo }, category, text);
    if (id) toDispatch.push(id);
  };
  if (assessment.disposition === "QUALIFIED") await queue("qualified_handoff", formatQualifiedHandoff(mctx));
  else if (assessment.disposition !== "ESCALATED") await queue("call_update", formatCallUpdate(mctx)); // closed, declined, needs review, nothing captured
  if (assessment.disposition === "ESCALATED") {
    await queue("urgent_escalation", formatUrgentEscalation(mctx));
    await tx.insert(followUpTasks).values({
      enquiryId: row.id, kind: assessment.escalation?.kind === "existing_client_complaint" ? "complaint" : "human_requested",
      note: `Requested: ${assessment.escalation?.requestedRecipient ?? "a person"}. No callback time was promised.`, isDemo,
    }).onConflictDoNothing();
    await audit(tx, { actor: "system", action: "escalation.triggered", entityType: "enquiry", entityId: row.id, detail: { ref, kind: assessment.escalation?.kind } });
  }
  if (facts.frustratedPriorEnquiry && assessment.disposition !== "ESCALATED") {
    await tx.insert(followUpTasks).values({ enquiryId: row.id, kind: "frustrated_followup", note: "Caller says an earlier enquiry was not followed up. Handle with care.", isDemo }).onConflictDoNothing();
  }

  // --- costs: actual > estimated (verified rate) > unknown. Never zero. ---
  const rates = await getRates(tx);
  const drafts = computeCallCosts({ providerCost: event.cost, durationSec: patch.durationSec ?? row.durationSec ?? event.durationSec, rates });
  await recordCosts(tx, { enquiryId: row.id, providerCallId: event.providerCallId, provider: providerId, isDemo }, drafts);
  await audit(tx, { actor: "system", action: "cost.calculated", entityType: "enquiry", entityId: row.id, detail: { bases: drafts.map((d) => d.basis) } });

  return { status: "processed", enquiryId: row.id };
}

/** True when the call produced at least one substantive answer or a complaint/escalation signal. */
function capturedAnything(f: Facts): boolean {
  return Boolean(f.callerName || f.locationText || f.scopeKind || f.engagement || f.propertyType || f.projectCategory || f.roomCount || f.carpetAreaSqft
    || f.needByWeeks !== undefined || f.desiredStartWeeks !== undefined || f.timelineFlexible || f.statedBudgetMaxInr || f.isComplaint || f.requestedHuman
    || f.decisionMaker !== "unknown" || f.consultationInterest);
}

function summarise(f: Facts, a: Assessment): string {
  const bits = [f.projectCategory, f.propertyType?.replace(/_/g, " "), f.locationText, f.carpetAreaSqft ? `${f.carpetAreaSqft} sq ft` : null].filter(Boolean);
  return `${a.disposition.replace(/_/g, " ").toLowerCase()}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
}

/**
 * Turns a completed call into an assessment. Model/provider output is untrusted: structured facts must
 * pass FactsSchema; otherwise a safe fallback is used and a human reviews. A call that ends with an
 * open clarification becomes HUMAN_REVIEW (there is nobody left to ask) — never a silently lost lead.
 */
export function qualifyCompletedCall(event: ProviderEvent, providerId: "mock" | "vaani"): { facts: Facts; assessment: Assessment; notes: string[] } {
  const notes: string[] = [];
  let facts: Facts = FactsSchema.parse({});
  let haveData = false;

  if (event.structuredFacts !== undefined) {
    const p = parseFacts(event.structuredFacts);
    if (p.ok) { facts = p.facts; haveData = true; }
    else notes.push(`Provider structured output was invalid and was ignored (${p.error.slice(0, 120)}).`);
  }
  if (!haveData && event.transcript?.length && (providerId === "mock" || event.transcriptOnly)) {
    // Deterministic extractor: used for the mock provider, and for live calls whose provider analysis was late (flagged below).
    const now = new Date(event.startedAt ?? event.occurredAt);
    let lastQ: string | undefined;
    for (const t of event.transcript) {
      if (t.role === "agent") { lastQ = t.text; continue; }
      facts = extractFacts(t.text, facts, { now, lastAgentQuestion: lastQ });
    }
    haveData = true;
  }

  if (!haveData) {
    const a = assess(facts);
    return { facts, notes: [...notes, "No usable transcript or structured data was received for this call."],
      assessment: { ...a, disposition: "HUMAN_REVIEW", reasonCodes: ["NO_USABLE_DATA"], forwardToDesigner: false, humanReviewRequired: true,
        humanReviewReasons: ["No usable data captured from the call."], priority: "high", nextQuestion: undefined } };
  }
  let assessment = assess(facts);
  if (event.transcriptOnly) {
    const caveat = "Vaani's analysis of this call was delayed, so the answers were read from the transcript by our own rules. Please check the details.";
    notes.push(caveat);
    assessment = { ...assessment, humanReviewReasons: [...assessment.humanReviewReasons, caveat] };
  }
  if (!capturedAnything(facts)) {
    // e.g. unintelligible audio or the caller hung up: say so plainly instead of pretending a question was left open.
    return { facts, notes, assessment: { ...assessment, disposition: "HUMAN_REVIEW", reasonCodes: ["NO_USABLE_DATA"], forwardToDesigner: false, humanReviewRequired: true,
      humanReviewReasons: [NO_USABLE_DATA_REASON], priority: "normal", nextQuestion: undefined } };
  }
  if (assessment.disposition === "NEEDS_CLARIFICATION") {
    assessment = { ...assessment, disposition: "HUMAN_REVIEW", forwardToDesigner: false, humanReviewRequired: true,
      humanReviewReasons: [`Call ended with an open question: "${assessment.nextQuestion?.text}"`, ...assessment.humanReviewReasons], priority: assessment.priority === "normal" ? "high" : assessment.priority };
  }
  return { facts, assessment, notes };
}

