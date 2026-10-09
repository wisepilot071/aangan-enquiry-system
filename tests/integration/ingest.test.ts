import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { auditEvents, callEvents, costs, enquiries, followUpTasks, notifications, qualificationAssessments, settings } from "@/db/schema";
import { ingestEvent, ingestWebhook } from "@/modules/telephony-events/ingest";
import { simulateCallEvents } from "@/modules/telephony-events/simulator";
import { createMockProvider, signMockPayload, MOCK_SIGNATURE_HEADER, MOCK_TIMESTAMP_HEADER } from "@/modules/voice-provider/mock";
import type { ProviderEvent } from "@/modules/voice-provider/types";
import type { TelegramSender, SendResult } from "@/modules/notifications/telegram";
import { retryNotification } from "@/modules/notifications/service";
import { PHONE_SCENARIOS } from "../fixtures/phone-transcripts";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

const noSleep = async () => {};
const scenario = (id: string) => PHONE_SCENARIOS.find((s) => s.id === id)!;
let n = 0;
async function runScenario(id: string, opts: { provider?: "mock" | "vaani"; phone?: string; cost?: number; sender?: TelegramSender | null } = {}) {
  const s = scenario(id);
  const callId = `call-${id}-${++n}`;
  const { events } = simulateCallEvents({
    callId, fromNumber: opts.phone ?? `+9199000${String(10000 + n)}`, startedAt: new Date(s.date),
    callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })), factOverrides: s.overrides ?? (opts.provider === "vaani" ? {} : undefined), providerCostInr: opts.cost,
  });
  let last;
  for (const e of events) last = await ingestEvent(h.db, opts.provider ?? "mock", e, e.eventId!, { sender: opts.sender, sleep: noSleep });
  return { callId, events, last: last! };
}
const enquiryFor = async (callId: string) => (await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, callId)))[0]!;
const notesFor = async (id: string) => h.db.select().from(notifications).where(eq(notifications.enquiryId, id));

describe("ingestion workflow (mock provider)", () => {
  it("qualified call: persists enquiry, assessment, timestamps, DEMO flag and a simulated handoff", async () => {
    const { callId } = await runScenario("T01");
    const e = await enquiryFor(callId);
    expect(e.isDemo).toBe(true);
    expect(e.callStatus).toBe("completed");
    expect(e.disposition).toBe("QUALIFIED");
    expect(e.firstResponseAt).not.toBeNull();
    expect(e.callerPhone).toMatch(/^\+91/);
    const a = await h.db.select().from(qualificationAssessments).where(eq(qualificationAssessments.enquiryId, e.id));
    expect(a).toHaveLength(1);
    expect((a[0]!.criteria as unknown[]).length).toBe(5);
    const notes = await notesFor(e.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.category).toBe("qualified_handoff");
    expect(notes[0]!.status).toBe("mock_sent"); // visibly simulated, never "sent"
    expect(notes[0]!.messagePreview).toContain("DEMO / MOCK");
    expect(notes[0]!.messagePreview).toContain("AANGAN STUDIO — NEW QUALIFIED ENQUIRY");
  });

  it("closed (unqualified) lead is stored but NOT sent to a designer", async () => {
    for (const id of ["T03", "T04", "T10", "T18", "T19"]) {
      const { callId } = await runScenario(id);
      const e = await enquiryFor(callId);
      expect(e.disposition, id).toBe("CLOSED_NOT_FORWARDED");
      expect(await notesFor(e.id), id).toHaveLength(0);
    }
  });

  it("existing-client complaint → urgent escalation message + open task, no sales handoff", async () => {
    const { callId } = await runScenario("T09");
    const e = await enquiryFor(callId);
    expect(e).toMatchObject({ disposition: "ESCALATED", priority: "urgent", escalationKind: "existing_client_complaint" });
    expect(e.escalationRecipient).toBe("Nikhil");
    const notes = await notesFor(e.id);
    expect(notes.map((x) => x.category)).toEqual(["urgent_escalation"]);
    expect(notes[0]!.messagePreview).toContain("URGENT ESCALATION");
    expect(notes[0]!.messagePreview).toContain("Callback time was NOT promised");
    const tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id));
    expect(tasks.map((t) => t.kind)).toEqual(["complaint"]);
  });

  it("frustrated repeat caller: high priority + follow-up task, still not mis-routed as a complaint", async () => {
    const { callId } = await runScenario("T16");
    const e = await enquiryFor(callId);
    expect(e.priority).toBe("high");
    expect(e.disposition).not.toBe("ESCALATED");
    expect(e.needsHumanReview).toBe(true);
    const tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id));
    expect(tasks.map((t) => t.kind)).toContain("frustrated_followup");
  });

  it("a call that ends with an open question becomes HUMAN_REVIEW (never silently lost)", async () => {
    const { callId } = await runScenario("T13"); // timeline asked? T13 supplies 'no rush' → qualified; use T16 for open question
    expect((await enquiryFor(callId)).disposition).toBe("QUALIFIED");
    const t16 = await runScenario("T16");
    const e = await enquiryFor(t16.callId);
    expect(e.disposition).toBe("HUMAN_REVIEW");
    expect((e.humanReviewReasons as string[]).join(" ")).toContain("open question");
  });

  it("no pricing data or transcripts leak into notification previews", async () => {
    const rows = await h.db.select().from(notifications);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.messagePreview).not.toMatch(/₹|lakh|per sq ?ft/i);
      expect(r.messagePreview).not.toMatch(/Agent:|Front Desk|transcript|virtual assistant/i);
    }
  });
});

describe("idempotency", () => {
  it("replaying the same webhook never duplicates enquiry, notification, assessment or cost", async () => {
    const s = scenario("T15");
    const callId = `idem-${++n}`;
    const { events } = simulateCallEvents({ callId, fromNumber: "+919900011111", startedAt: new Date(s.date), callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })) });
    for (const e of events) await ingestEvent(h.db, "mock", e, e.eventId!, { sleep: noSleep });
    const done = events.find((e) => e.type === "call.completed")!;
    for (let i = 0; i < 3; i++) {
      const r = await ingestEvent(h.db, "mock", done, done.eventId!, { sleep: noSleep });
      expect(r.status).toBe("duplicate");
    }
    // a provider retry that uses a NEW event id for an already-completed call is also a no-op
    const again = await ingestEvent(h.db, "mock", { ...done, eventId: "different-id" }, "different-id", { sleep: noSleep });
    expect(again.status).toBe("duplicate");
    const e = await enquiryFor(callId);
    expect(await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, callId))).toHaveLength(1);
    expect(await notesFor(e.id)).toHaveLength(1);
    expect(await h.db.select().from(qualificationAssessments).where(eq(qualificationAssessments.enquiryId, e.id))).toHaveLength(1);
    expect(await h.db.select().from(costs).where(eq(costs.enquiryId, e.id))).toHaveLength(1);
    const ev = await h.db.select().from(callEvents).where(eq(callEvents.eventKey, done.eventId!));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.attempts).toBe(4);
  });

  it("out-of-order delivery (completed before started) still yields one coherent record", async () => {
    const s = scenario("T20");
    const callId = `ooo-${++n}`;
    const { events } = simulateCallEvents({ callId, fromNumber: "+919900022222", startedAt: new Date(s.date), callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })) });
    for (const e of [...events].reverse()) await ingestEvent(h.db, "mock", e, e.eventId!, { sleep: noSleep });
    const e = await enquiryFor(callId);
    expect(e.callStatus).toBe("completed");
    expect(e.callStartedAt).not.toBeNull();
    expect(e.firstResponseAt).not.toBeNull();
  });
});

describe("signed webhook endpoint logic", () => {
  const secret = "test-secret-0123456789abcdef";
  const provider = createMockProvider({ secret });
  const body = JSON.stringify({ eventId: "w1", type: "call.started", providerCallId: "wh-1", occurredAt: "2026-09-02T04:53:00.000Z", fromNumber: "+919900033333" });
  const headersFor = (b: string, ts = Date.now(), s = secret) => ({ [MOCK_TIMESTAMP_HEADER]: String(ts), [MOCK_SIGNATURE_HEADER]: signMockPayload(s, ts, b) });

  it("accepts a correctly signed event", async () => {
    const r = await ingestWebhook(h.db, provider, body, headersFor(body));
    expect(r).toMatchObject({ httpStatus: 200, status: "processed" });
  });
  it("rejects bad signature, stale timestamp, missing headers, unknown secret — and creates no enquiry", async () => {
    const before = (await h.db.select().from(enquiries)).length;
    const b2 = body.replace("wh-1", "wh-evil");
    expect((await ingestWebhook(h.db, provider, b2, headersFor(b2, Date.now(), "wrong-secret-wrong-secret"))).httpStatus).toBe(401);
    expect((await ingestWebhook(h.db, provider, b2, headersFor(b2, Date.now() - 10 * 60_000))).httpStatus).toBe(401);
    expect((await ingestWebhook(h.db, provider, b2, {})).httpStatus).toBe(401);
    expect((await ingestWebhook(h.db, createMockProvider({}), b2, headersFor(b2))).httpStatus).toBe(401); // no secret configured → fail closed
    expect((await h.db.select().from(enquiries)).length).toBe(before);
    const rej = await h.db.select().from(callEvents).where(eq(callEvents.status, "rejected"));
    expect(rej.length).toBeGreaterThanOrEqual(4);
    expect(rej.every((r) => (r.errorDetail ?? "").includes("content not stored"))).toBe(true);
  });
  it("malformed JSON and invalid/missing fields → 400, recorded, nothing created", async () => {
    const bad = "{not json";
    expect((await ingestWebhook(h.db, provider, bad, headersFor(bad))).httpStatus).toBe(400);
    const missing = JSON.stringify({ type: "call.started" });
    expect((await ingestWebhook(h.db, provider, missing, headersFor(missing))).httpStatus).toBe(400);
    const unknownType = JSON.stringify({ type: "call.exploded", providerCallId: "x", occurredAt: "2026-09-02T04:53:00.000Z" });
    expect((await ingestWebhook(h.db, provider, unknownType, headersFor(unknownType))).httpStatus).toBe(400);
  });
  it("oversized payload → 413", async () => {
    const huge = "x".repeat(300 * 1024);
    expect((await ingestWebhook(h.db, provider, huge, headersFor(huge))).httpStatus).toBe(413);
  });
  it("an unconfigured Vaani adapter rejects everything (fails closed)", async () => {
    const { createVaaniProvider } = await import("@/modules/voice-provider/vaani");
    const r = await ingestWebhook(h.db, createVaaniProvider(), body, headersFor(body));
    expect(r).toMatchObject({ httpStatus: 401, reason: "vaani_webhook_token_not_configured" });
  });
});

describe("Telegram delivery (real-provider path with injected sender)", () => {
  const seq = (results: SendResult[]): TelegramSender & { calls: number } => {
    let i = 0;
    return { calls: 0, async send() { this.calls++; return results[Math.min(i++, results.length - 1)]!; } };
  };
  const ok: SendResult = { ok: true, messageId: "4242" };

  it("successful send records sent, message id, and notifiedAt", async () => {
    const sender = seq([ok]);
    const { callId } = await runScenario("T05", { provider: "vaani", sender });
    const e = await enquiryFor(callId);
    const [nt] = await notesFor(e.id);
    expect(nt).toMatchObject({ status: "sent", attempts: 1, providerMessageId: "4242", isDemo: false });
    expect(e.notifiedAt).not.toBeNull();
    expect(sender.calls).toBe(1);
  });
  it("transient failures are retried with bounded attempts then succeed", async () => {
    const sender = seq([{ ok: false, category: "transient", detail: "telegram_http_502" }, { ok: false, category: "rate_limited", retryAfterMs: 1, detail: "telegram_rate_limited" }, ok]);
    const { callId } = await runScenario("T06", { provider: "vaani", sender });
    const [nt] = await notesFor((await enquiryFor(callId)).id);
    expect(nt).toMatchObject({ status: "sent", attempts: 3 });
  });
  it("persistent failure: enquiry survives, notification failed, follow-up task opened; operator retry works", async () => {
    const sender = seq([{ ok: false, category: "transient", detail: "telegram_http_500" }]);
    const { callId } = await runScenario("T12", { provider: "vaani", sender });
    const e = await enquiryFor(callId);
    expect(e.disposition).toBe("QUALIFIED"); // enquiry is intact
    const [nt] = await notesFor(e.id);
    expect(nt).toMatchObject({ status: "failed", attempts: 3, errorCategory: "telegram_http_500" });
    expect(sender.calls).toBe(3);
    let tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id));
    expect(tasks.find((t) => t.kind === "failed_handoff")?.status).toBe("open");

    const healthy = seq([ok]);
    expect(await retryNotification(h.db, nt!.id, "operator@test", { sender: healthy, sleep: noSleep })).toBe("sent");
    tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id));
    expect(tasks.find((t) => t.kind === "failed_handoff")?.status).toBe("done");
    await expect(retryNotification(h.db, nt!.id, "operator@test", { sender: healthy })).rejects.toThrow(/cannot retry/);
  });
  it("permanent failure is not retried", async () => {
    const sender = seq([{ ok: false, category: "permanent", detail: "telegram_http_403" }]);
    const { callId } = await runScenario("T20", { provider: "vaani", sender });
    const [nt] = await notesFor((await enquiryFor(callId)).id);
    expect(nt).toMatchObject({ status: "failed", attempts: 1 });
    expect(sender.calls).toBe(1);
  });
  it("no credentials: recorded as unavailable (not lost, not faked)", async () => {
    const { callId } = await runScenario("T01", { provider: "vaani", sender: null });
    const e = await enquiryFor(callId);
    const [nt] = await notesFor(e.id);
    expect(nt!.status).toBe("unavailable");
    expect(e.disposition).toBe("QUALIFIED");
  });
  it("demo enquiries never reach the real sender even when credentials exist", async () => {
    const sender = seq([ok]);
    await runScenario("T01", { provider: "mock", sender });
    expect(sender.calls).toBe(0);
  });
});

describe("missed, disconnected and failed calls", () => {
  const ev = (type: ProviderEvent["type"], callId: string, at: string, phone?: string, extra: Partial<ProviderEvent> = {}): ProviderEvent => ({
    eventId: `${callId}:${type}`, type, providerCallId: callId, occurredAt: at, ...(phone ? { fromNumber: phone } : {}), ...extra,
  });

  it("missed call: recorded accurately, no invented transcript, follow-up task + notification, no outbound call", async () => {
    await ingestEvent(h.db, "mock", ev("call.missed", "miss-1", "2026-09-09T17:17:00.000Z", "+919900044444"), "miss-1:missed", { sleep: noSleep });
    const e = await enquiryFor("miss-1");
    expect(e).toMatchObject({ callStatus: "missed", transcript: null, disposition: null });
    const tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id));
    expect(tasks.map((t) => t.kind)).toEqual(["missed_call"]);
    expect((await notesFor(e.id))[0]!.category).toBe("missed_call_followup");
  });
  it("dropped call then reconnect from the same verified number links the calls and closes the task", async () => {
    await ingestEvent(h.db, "mock", ev("call.started", "drop-1", "2026-09-22T08:44:00.000Z", "+919900055555", { startedAt: "2026-09-22T08:44:00.000Z" }), "d1s");
    await ingestEvent(h.db, "mock", ev("call.disconnected", "drop-1", "2026-09-22T08:45:12.000Z", "+919900055555", { endedAt: "2026-09-22T08:45:12.000Z", durationSec: 72 }), "d1d");
    const first = await enquiryFor("drop-1");
    expect(first.callStatus).toBe("disconnected");
    const second = simulateCallEvents({
      callId: "drop-2", fromNumber: "+919900055555", startedAt: new Date("2026-09-22T08:46:00.000Z"),
      callerLines: scenario("T17b").turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })),
    });
    for (const e of second.events) await ingestEvent(h.db, "mock", e, e.eventId!, { sleep: noSleep });
    const linked = await enquiryFor("drop-2");
    expect(linked.previousEnquiryId).toBe(first.id);
    expect(linked.disposition).toBe("QUALIFIED");
    const t = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, first.id));
    expect(t[0]).toMatchObject({ kind: "dropped_call", status: "done", completedBy: "system" });
  });
  it("different number, or outside the window, is never linked", async () => {
    await ingestEvent(h.db, "mock", ev("call.disconnected", "drop-3", "2026-09-22T09:00:00.000Z", "+919900066666", { endedAt: "2026-09-22T09:00:00.000Z" }), "d3d");
    await ingestEvent(h.db, "mock", ev("call.started", "drop-4", "2026-09-22T09:05:00.000Z", "+919900077777", { startedAt: "2026-09-22T09:05:00.000Z" }), "d4s");
    await ingestEvent(h.db, "mock", ev("call.started", "drop-5", "2026-09-22T10:00:00.000Z", "+919900066666", { startedAt: "2026-09-22T10:00:00.000Z" }), "d5s");
    expect((await enquiryFor("drop-4")).previousEnquiryId).toBeNull();
    expect((await enquiryFor("drop-5")).previousEnquiryId).toBeNull();
  });
  it("provider call failure is recorded with a task", async () => {
    await ingestEvent(h.db, "mock", ev("call.failed", "fail-1", "2026-09-10T10:00:00.000Z", undefined, { failureReason: "sip_timeout" }), "f1");
    const e = await enquiryFor("fail-1");
    expect(e.callStatus).toBe("failed");
    expect((await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id)))[0]!.note).toContain("sip_timeout");
  });
});

describe("response-time measurement", () => {
  it("firstResponseAt comes only from provider timestamps; absent stays NULL (not fabricated)", async () => {
    const withTs = simulateCallEvents({ callId: "rt-1", startedAt: new Date("2026-09-02T05:00:00Z"), firstResponseDelaySec: 4, callerLines: [{ text: "Hi, 3BHK in Kothrud, full redesign." }] });
    for (const e of withTs.events) await ingestEvent(h.db, "mock", e, e.eventId!);
    const a = await enquiryFor("rt-1");
    expect(a.firstResponseAt!.getTime() - a.callStartedAt!.getTime()).toBe(4000);

    const without = simulateCallEvents({ callId: "rt-2", startedAt: new Date("2026-09-02T05:00:00Z"), firstResponseDelaySec: null, callerLines: [{ text: "Hi, 3BHK in Kothrud, full redesign." }] });
    for (const e of without.events) await ingestEvent(h.db, "mock", e, e.eventId!);
    expect((await enquiryFor("rt-2")).firstResponseAt).toBeNull();
  });
});

describe("cost recording: actual / estimated / unknown", () => {
  it("unknown when no provider cost and no verified rate (amount NULL, never zero)", async () => {
    const { callId } = await runScenario("T06");
    const e = await enquiryFor(callId);
    const [c] = await h.db.select().from(costs).where(eq(costs.enquiryId, e.id));
    expect(c).toMatchObject({ basis: "unknown", amount: null });
  });
  it("actual when the provider reports a cost", async () => {
    const { callId } = await runScenario("T06", { cost: 12.5 });
    const [c] = await h.db.select().from(costs).where(eq(costs.enquiryId, (await enquiryFor(callId)).id));
    expect(c).toMatchObject({ basis: "actual", rateSource: "provider_reported" });
    expect(Number(c!.amount)).toBe(12.5);
  });
  it("estimated when an admin has configured a verified rate (with its source)", async () => {
    await h.db.insert(settings).values({ key: "cost_rates", value: { voicePerMinuteInr: 6, source: "Test fixture rate (not a real provider price)" } });
    const { callId } = await runScenario("T06");
    const e = await enquiryFor(callId);
    const [c] = await h.db.select().from(costs).where(eq(costs.enquiryId, e.id));
    expect(c).toMatchObject({ basis: "estimated", rateSource: "Test fixture rate (not a real provider price)" });
    expect(Number(c!.amount)).toBeCloseTo(6 * (e.durationSec! / 60), 1);
    await h.db.delete(settings);
  });
});

describe("audit trail", () => {
  it("records key actions and never stores secrets", async () => {
    const rows = await h.db.select().from(auditEvents);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["enquiry.created", "qualification.completed", "lead.declined", "escalation.triggered", "cost.calculated", "webhook.rejected", "notification.mock_sent", "notification.sent", "notification.failed"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toMatch(/bot\d+:|test-secret-0123456789abcdef|wrong-secret|password/i);
  });
});
