import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { auditEvents, callEvents, costs, enquiries, followUpTasks, notifications } from "@/db/schema";
import { getMetrics, getOutboundTestSummary, listEnquiries } from "@/modules/analytics/queries";
import { ingestWebhook } from "@/modules/telephony-events/ingest";
import { OutboundError, placeTestCall, syncRecentCalls, syncVaaniCall } from "@/modules/telephony-events/outbound";
import { createVaaniProvider } from "@/modules/voice-provider/vaani";
import { VaaniApiError, createVaaniClient, type VaaniClient } from "@/modules/voice-provider/vaani-client";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

const TOKEN = "w".repeat(32);
const URL_OK = `https://app.example/api/webhooks/voice?token=${TOKEN}`;
const noNet = createVaaniClient({ apiKey: "vaani_" + "k".repeat(24), fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch });
const provider = (over: Partial<VaaniClient> = {}) => createVaaniProvider({ apiKey: "vaani_" + "k".repeat(24), webhookToken: TOKEN, client: { ...noNet, ...over } });
const send = (p: ReturnType<typeof provider>, body: unknown, url = URL_OK) =>
  ingestWebhook(h.db, p, JSON.stringify(body), {}, { url, sender: null, sleep: async () => {} });
const row = async (id: string) => (await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, id)))[0]!;

const TRANSCRIPT = "[00:00:01] AGENT: Hello, you've reached Aangan Studio. I'm the studio's virtual assistant. How may I help you today?\n\n[00:00:06] USER: I have a 3BHK in Baner and want a complete redesign with execution. No rush. I am the owner.";
const ENTITIES = { caller_name: "Meera", project_category: "residential", property_type: "apartment", location: "Baner, Pune", scope_kind: "full_home", engagement: "design_and_execution", timeline_text: "no rush", decision_maker: "owner", is_complaint: "no" };
const post = (id: string, over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  event: "call_postprocessing", call_id: id, timestamp: "2026-10-09T10:05:00.000000+00:00",
  data: { room_name: id, call_id: id, call_duration: 120000, end_reason: "Call ended", summary: "Wants a redesign.", entities: ENTITIES, recording_url: "https://example.invalid/r.mp3", transcript: TRANSCRIPT, ...data }, ...over,
});

describe("Vaani webhook pipeline (inbound)", () => {
  it("rejects anything without the secret token, records the rejection without the payload, creates nothing", async () => {
    const p = provider();
    const before = (await h.db.select().from(enquiries)).length;
    for (const url of ["", "https://app.example/api/webhooks/voice", "https://app.example/api/webhooks/voice?token=wrong", `https://app.example/api/webhooks/voice?token=${TOKEN}x`]) {
      const r = await send(p, { event: "call_started", room_name: "evil-1", phone_number: "+9100000000" }, url);
      expect(r).toMatchObject({ httpStatus: 401, status: "rejected" });
    }
    expect((await h.db.select().from(enquiries)).length).toBe(before);
    const rej = await h.db.select().from(callEvents).where(eq(callEvents.status, "rejected"));
    expect(rej.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rej)).not.toContain("evil-1");
  });

  it("full sequence: started → picked up → ended → postprocessing qualifies exactly once, with one handoff record", async () => {
    const id = "inbound-111";
    const p = provider({
      getCallDetails: async () => ({ transcription: TRANSCRIPT.replace(/\[[^\]]+\] /g, ""), entity: ENTITIES, summary: "Wants a redesign.", call_eval_tag: null }),
      getCallHistory: async () => ({ data: [{ call_id: id, from_number: "+919900123456", call_cost: 3.5 }] }),
    });
    expect((await send(p, { event: "call_started", room_name: id, status: "ringing", phone_number: "+919900123456" })).status).toBe("processed");
    expect((await send(p, { event: "user_picked_up_at", room_name: id, status: "active" })).status).toBe("processed");
    expect((await send(p, { event: "call_ringing", room_name: id })).status).toBe("ignored");
    expect((await send(p, { event: "call_ended", room_name: id, call_duration: 120.4, end_reason: "AGENT_REQUESTED_DISCONNECT" })).status).toBe("processed");

    // call_ended alone must not complete or qualify the call
    let e = await row(id);
    expect(e).toMatchObject({ callStatus: "in_progress", disposition: null, direction: "inbound", isDemo: false, provider: "vaani" });

    const done = await send(p, post(id));
    expect(done).toMatchObject({ httpStatus: 200, status: "processed" });
    e = await row(id);
    expect(e).toMatchObject({ callStatus: "completed", disposition: "QUALIFIED", callerName: "Meera", callerPhone: "+919900123456", durationSec: 120 });
    expect(e.firstResponseAt).toBeNull(); // Vaani gives no first-speech timestamp → honestly unmeasurable
    expect(e.transcript).not.toBeNull();
    expect(JSON.stringify(e)).not.toContain("recording");

    // handoff: real (non-demo) → no Telegram credentials in this test → recorded as unavailable plus a task, not "sent"
    const n = await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ category: "qualified_handoff", status: "unavailable", isDemo: false });
    expect(n[0]!.messagePreview).not.toContain("DEMO");

    // cost: Vaani reports credits → stored as an actual cost in its own unit, never as ₹
    const c = await h.db.select().from(costs).where(eq(costs.enquiryId, e.id));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ basis: "actual", currency: "CREDITS", rateSource: "provider_reported" });
    expect(Number(c[0]!.amount)).toBe(3.5);

    // replay of the same webhook body is a duplicate; a re-sent postprocessing for the same call is too
    expect((await send(p, post(id))).status).toBe("duplicate");
    expect((await send(p, post(id, { timestamp: "2026-10-09T10:06:00.000000+00:00" }))).status).toBe("duplicate");
    expect(await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id))).toHaveLength(1);
  });

  it("when Vaani's API is down, the token-protected webhook data is still processed and cost stays unknown", async () => {
    const id = "inbound-222";
    const r = await send(provider(), post(id));
    expect(r.status).toBe("processed");
    const e = await row(id);
    expect(e.disposition).toBe("QUALIFIED");
    const c = await h.db.select().from(costs).where(eq(costs.enquiryId, e.id));
    expect(c[0]).toMatchObject({ basis: "unknown", amount: null });
  });

  it("an entity set that cannot be understood becomes human review, never a lead", async () => {
    const id = "inbound-333";
    await send(provider(), post(id, {}, { entities: { project_category: "industrial", engagement: "free money", location: "x".repeat(500) } }));
    const e = await row(id);
    expect(e.disposition).not.toBe("QUALIFIED");
    expect(await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id))).toEqual([]);
  });

  it("an existing-client complaint is escalated as urgent with a task, not treated as a lead", async () => {
    const id = "inbound-444";
    await send(provider(), post(id, {}, { entities: { caller_name: "Sheetal", is_existing_client: "yes", is_complaint: "yes", asked_for_person: "yes", requested_person: "Nikhil", project_reference: "Designer Aryan, Viman Nagar" } }));
    const e = await row(id);
    expect(e).toMatchObject({ disposition: "ESCALATED", priority: "urgent", escalationRecipient: "Nikhil" });
    expect((await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id))).map((t) => t.kind).sort()).toEqual(["complaint", "failed_handoff"]); // no Telegram credentials here → also a manual-handoff task
    expect((await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id))).map((x) => x.category)).toEqual(["urgent_escalation"]);
  });

  it("post-call guardrail audit flags an agent that quoted a price or promised a booking", async () => {
    const id = "inbound-555";
    const bad = "[00:00:01] AGENT: Hello.\n\n[00:00:05] USER: How much?\n\n[00:00:08] AGENT: It will cost around 20 lakh. I have booked your consultation for tomorrow.\n\n[00:00:12] USER: ok";
    await send(provider(), post(id, {}, { transcript: bad }));
    const e = await row(id);
    expect(e.needsHumanReview).toBe(true);
    expect((e.humanReviewReasons as string[]).filter((r) => r.startsWith("GUARDRAIL")).length).toBe(2);
    expect(e.priority).not.toBe("normal");
    const a = await h.db.select().from(auditEvents).where(eq(auditEvents.action, "guardrail.violation_detected"));
    expect(a.length).toBe(1);
  });

  it("missed inbound calls (no_answer is outbound-only in Vaani) and malformed events are handled safely", async () => {
    const p = provider();
    expect((await send(p, { event: "call_started" })).httpStatus).toBe(400);
    expect((await ingestWebhook(h.db, p, "{broken", {}, { url: URL_OK })).httpStatus).toBe(400);
    expect((await send(p, { event: "brand_new_event", room_name: "r-9" })).status).toBe("ignored");
  });
});

describe("outbound test calls", () => {
  const ok = (callId = "outbound-900-aa11bb22") => ({ success: true, message: "Call initiated successfully", output: { agent_name: "x", call_id: callId, live_captions_url: "https://example.invalid/live" }, error: null });
  const client = (triggerCall: VaaniClient["triggerCall"]) => ({ ...noNet, triggerCall });

  it("validates E.164, consent and name before anything is sent to Vaani", async () => {
    const spy = vi.fn();
    const c = client(spy as never);
    const go = (o: Partial<{ contactNumber: string; name: string; consent: boolean }>) => placeTestCall(h.db, c, "agent-1", { contactNumber: "+919876543210", name: "Jane", consent: true, ...o }, "op@test").catch((e) => e as OutboundError);
    for (const [bad, code] of [[{ contactNumber: "9876543210" }, "invalid_number"], [{ contactNumber: "+91 98765 43210" }, "invalid_number"], [{ contactNumber: "+0123456789" }, "invalid_number"],
      [{ contactNumber: "+9198" }, "invalid_number"], [{ consent: false }, "consent_required"], [{ name: "  " }, "name_required"]] as const) {
      expect(await go(bad)).toMatchObject({ code });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("places the call with Vaani's DND check ON, records an outbound row immediately, audits with a MASKED number", async () => {
    const spy = vi.fn(async () => ok());
    const r = await placeTestCall(h.db, client(spy as never), "agent-1", { contactNumber: "+919876543210", name: "Jane", consent: true }, "op@test");
    expect(r.callId).toBe("outbound-900-aa11bb22");
    const args = (spy.mock.calls[0] as unknown as [{ dndCheckSkipped: boolean; contactNumber: string; agentId: string; modifyAgent: unknown }])[0];
    expect(args).toMatchObject({ dndCheckSkipped: false, contactNumber: "+919876543210", agentId: "agent-1" });
    expect(JSON.stringify(args.modifyAgent)).toContain("test");
    const e = await row("outbound-900-aa11bb22");
    expect(e).toMatchObject({ direction: "outbound", callStatus: "in_progress", provider: "vaani", disposition: null });
    const audit = await h.db.select().from(auditEvents).where(eq(auditEvents.action, "call.outbound_requested"));
    expect(JSON.stringify(audit)).not.toContain("9876543210");
    expect(JSON.stringify(audit)).toContain("+91•••••210");
  });

  it("Vaani errors surface as clear OutboundErrors and are audited; nothing is recorded as a call", async () => {
    const before = (await h.db.select().from(enquiries)).length;
    const e1 = await placeTestCall(h.db, client((async () => { throw new VaaniApiError(401, "Vaani POST /api/trigger-call/ failed: Invalid API key", "auth"); }) as never), "a", { contactNumber: "+919876543210", name: "J", consent: true }, "op").catch((e) => e);
    expect(e1).toMatchObject({ code: "vaani_auth" });
    const e2 = await placeTestCall(h.db, client((async () => ({ success: false, message: "No phone number is assigned to this agent" })) as never), "a", { contactNumber: "+919876543210", name: "J", consent: true }, "op").catch((e) => e);
    expect(e2).toMatchObject({ code: "vaani_rejected" });
    expect(e2.message).toContain("No phone number");
    expect((await h.db.select().from(enquiries)).length).toBe(before);
    expect((await h.db.select().from(auditEvents).where(eq(auditEvents.action, "call.outbound_failed"))).length).toBe(2);
  });

  it("a finished outbound call keeps transcript, summary and cost but is never qualified, handed off, or counted as an enquiry", async () => {
    const id = "outbound-900-aa11bb22";
    const p = provider({
      getCallDetails: async () => ({ transcription: "AGENT: Hello Jane, this is a test. USER: Hello, how much does it cost?", entity: { location: "Pune" }, summary: "Test call." }),
      getCallHistory: async () => ({ data: [{ call_id: id, call_cost: 1.25 }] }),
    });
    const r = await send(p, post(id, {}, { call_duration: 30000 }));
    expect(r.status).toBe("processed");
    const e = await row(id);
    expect(e).toMatchObject({ direction: "outbound", callStatus: "completed", disposition: null, needsHumanReview: false });
    expect(e.transcript).not.toBeNull();
    expect(await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id))).toEqual([]);
    expect(await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, e.id))).toEqual([]);
    expect((await h.db.select().from(costs).where(eq(costs.enquiryId, e.id)))[0]).toMatchObject({ basis: "actual", currency: "CREDITS" });

    const m = await getMetrics(h.db, "production");
    const inbound = (await h.db.select().from(enquiries).where(eq(enquiries.direction, "inbound"))).length;
    expect(m.calls.total).toBe(inbound); // the outbound test call is not an incoming call
    const o = await getOutboundTestSummary(h.db, "production");
    expect(o).toMatchObject({ calls: 1, completed: 1 });
    expect(o.cost.otherCurrencies).toEqual({ CREDITS: 1.25 });
    const list = await listEnquiries(h.db, { scope: "production", direction: "outbound" });
    expect(list.items.map((i) => i.direction)).toEqual(["outbound"]);
  });

  it("no answer / rejected / failed outbound calls are recorded accurately without creating follow-up tasks", async () => {
    const p = provider();
    await send(p, { event: "call_started", room_name: "outbound-901-x", phone_number: "+919876500000" });
    await send(p, { event: "call_no_answer", room_name: "outbound-901-x", status: "no_answer" });
    expect(await row("outbound-901-x")).toMatchObject({ callStatus: "missed", direction: "outbound" });
    await send(p, { event: "call_failed", room_name: "outbound-902-y", status: "failed", error: "SIP_404_NOT_FOUND" });
    expect(await row("outbound-902-y")).toMatchObject({ callStatus: "failed", direction: "outbound" });
    expect(await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, (await row("outbound-901-x")).id))).toEqual([]);
  });
});

describe("syncing a finished call from Vaani's API (local use / missed webhook)", () => {
  it("imports transcript, entities and cost for a call id, idempotently", async () => {
    const id = "inbound-sync-1";
    const p = provider({
      getCallDetails: async () => ({ transcription: TRANSCRIPT.replace(/\[[^\]]+\] /g, ""), entity: ENTITIES, summary: "s" }),
      getCallHistory: async () => ({ data: [{ call_id: id, from_number: "+919911111111", call_cost: 2 }] }),
    });
    const a = await syncVaaniCall(h.db, p, id, "op@test");
    expect(a.status).toBe("processed");
    expect(await row(id)).toMatchObject({ disposition: "QUALIFIED", callerPhone: "+919911111111", direction: "inbound" });
    expect((await syncVaaniCall(h.db, p, id, "op@test")).status).toBe("duplicate");
  });
  it("refuses when Vaani has nothing yet, and rejects malformed ids", async () => {
    const empty = provider({ getCallDetails: async () => ({ transcription: "Transcript is not available for further evaluations.", entity: {}, summary: "Transcript is not available for further evaluations." }) });
    await expect(syncVaaniCall(h.db, empty, "inbound-notyet-1", "op")).rejects.toMatchObject({ code: "not_ready", status: 409 });
    await expect(syncVaaniCall(h.db, empty, "../../etc/passwd", "op")).rejects.toMatchObject({ code: "invalid_call_id" });
  });
});

describe("importing recent calls from Vaani", () => {
  const entity = ENTITIES;
  const details = async () => ({ transcription: TRANSCRIPT.replace(/\[[^\]]+\] /g, ""), entity, summary: "s" });

  it("imports finished calls we do not have, skips ones we do, and counts the ones still processing", async () => {
    const p = provider({
      getCallHistory: async () => ({ data: [{ call_id: "inbound-recent-1" }, { call_id: "inbound-recent-2" }, { call_id: "inbound-recent-3" }, { call_id: "inbound-111" }] }),
      getCallDetails: async (id: string) => id === "inbound-recent-3"
        ? { transcription: "Transcript is not available for further evaluations.", entity: {}, summary: "Transcript is not available for further evaluations." }
        : details(),
    });
    const r = await syncRecentCalls(h.db, p, "someone");
    expect(r).toMatchObject({ found: 4, imported: 2, alreadyHad: 1, notReady: 1, failed: 0 });
    expect((await row("inbound-recent-1")).disposition).toBe("QUALIFIED");
    expect(await syncRecentCalls(h.db, p, "someone")).toMatchObject({ imported: 0, alreadyHad: 3 });
  });
  it("says plainly when Vaani's call-history service is failing (as it currently does on this account)", async () => {
    const p = provider({ getCallHistory: async () => { throw new VaaniApiError(500, "Vaani GET /api/call-history failed: Invalid client_id format", "server"); } });
    await expect(syncRecentCalls(h.db, p, "x")).rejects.toMatchObject({ code: "vaani_history_unavailable", status: 502 });
    await expect(syncRecentCalls(h.db, p, "x")).rejects.toThrow(/call logs/);
  });
});
