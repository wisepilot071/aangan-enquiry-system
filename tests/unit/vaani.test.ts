import { describe, expect, it, vi } from "vitest";
import { createVaaniClient, VaaniApiError } from "@/modules/voice-provider/vaani-client";
import { createVaaniProvider } from "@/modules/voice-provider/vaani";
import { entitiesToFacts, mapVaaniWebhook, parseVaaniTranscript } from "@/modules/voice-provider/vaani-mapper";
import { AGENT_DISPLAY_NAME, DATA_POINTS, SYSTEM_PROMPT, GREETING, buildAgentConfig } from "@/modules/voice-provider/vaani-agent-config";
import { APPROVED_PRICING_RESPONSE, containsPricingLeak } from "@/modules/pricing-guardrails";
import { FactsSchema } from "@/modules/qualification/facts";
import { assess } from "@/modules/qualification/engine";
import { ProviderEventSchema } from "@/modules/voice-provider/types";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const KEY = "vaani_" + "k".repeat(30);

describe("Vaani webhook mapping (payload shapes from docs.vaanivoice.ai → Webhook Setup)", () => {
  const map = (p: unknown) => mapVaaniWebhook(p, NOW);
  const ev = (p: unknown) => { const r = map(p); if (r.kind !== "event") throw new Error(JSON.stringify(r)); return ProviderEventSchema.parse(r.event); };

  it("call_started → call.started with the number and the receipt time (the payload has no timestamp)", () => {
    const e = ev({ event: "call_started", room_name: "room_123abc", status: "dialing", phone_number: "+1234567890" });
    expect(e).toMatchObject({ type: "call.started", providerCallId: "room_123abc", fromNumber: "+1234567890", occurredAt: NOW.toISOString(), direction: "inbound" });
    expect(e.firstAgentResponseAt).toBeUndefined(); // never fabricated
  });
  it("outbound ids are recognised; outbound-only events are always outbound", () => {
    expect(ev({ event: "call_started", room_name: "outbound-1784899978-36cec598", phone_number: "+9100" }).direction).toBe("outbound");
    expect(ev({ event: "call_no_answer", room_name: "room_9" })).toMatchObject({ type: "call.missed", direction: "outbound" });
    expect(ev({ event: "call_failed", room_name: "room_9", error: "SIP_404_NOT_FOUND" })).toMatchObject({ type: "call.failed", failureReason: "SIP_404_NOT_FOUND" });
    expect(ev({ event: "call_rejected", room_name: "room_9" })).toMatchObject({ type: "call.failed", failureReason: "rejected_or_busy" });
  });
  it("call_ended does NOT complete the call (transcript only arrives later); duration is seconds", () => {
    const e = ev({ event: "call_ended", room_name: "room_123abc", call_duration: 42.5, end_reason: "AGENT_REQUESTED_DISCONNECT" });
    expect(e.type).toBe("call.ended");
    expect(e.durationSec).toBe(43);
  });
  it("call_postprocessing completes the call: duration is MILLISECONDS, transcript parsed, entities become facts", () => {
    const e = ev({
      event: "call_postprocessing", call_id: "inbound-1", timestamp: "2026-07-24T13:34:22.278854+00:00",
      data: { room_name: "inbound-1", call_id: "inbound-1", call_duration: 55150.0229, end_reason: "Call ended", summary: "Caller wants a 3BHK redone.",
        entities: { caller_name: "Priya", location: "Kothrud, Pune", scope_kind: "full_home", engagement: "design_and_execution", decision_maker: "owner", timeline_text: "no rush, flexible" },
        recording_url: "https://example.invalid/rec", transcript: "[00:00:01] AGENT: Hello.\n\n[00:00:04] USER: Hi, I want to redo my flat." },
    });
    expect(e).toMatchObject({ type: "call.completed", providerCallId: "inbound-1", durationSec: 55, direction: "inbound", summary: "Caller wants a 3BHK redone." });
    expect(e.transcript).toEqual([{ role: "agent", text: "Hello." }, { role: "caller", text: "Hi, I want to redo my flat." }]);
    expect(JSON.stringify(e)).not.toContain("recording"); // the recording URL is not stored (no recordings by default)
    const f = FactsSchema.parse(e.structuredFacts);
    expect(f).toMatchObject({ callerName: "Priya", locationText: "Kothrud, Pune", decisionMaker: "owner", timelineFlexible: true });
    expect(assess(f).disposition).toBe("QUALIFIED");
  });
  it("informational and unknown events are acknowledged without being stored", () => {
    for (const name of ["call_ringing", "human_transfer_initiated", "human_transfer_successful", "human_transfer_failed", "something_new"]) {
      expect(map({ event: name, room_name: "r1" }).kind, name).toBe("ignored");
    }
  });
  it("invalid payloads are rejected", () => {
    expect(map(null)).toMatchObject({ kind: "invalid" });
    expect(map([])).toMatchObject({ kind: "invalid" });
    expect(map({ room_name: "r" })).toMatchObject({ kind: "invalid", reason: "missing_event_name" });
    expect(map({ event: "call_started" })).toMatchObject({ kind: "invalid", reason: "missing_room_name" });
    expect(map({ event: "call_postprocessing", data: {} })).toMatchObject({ kind: "invalid", reason: "missing_call_id" });
  });
});

describe("transcript parsing", () => {
  it("handles the webhook format and the call_details format", () => {
    expect(parseVaaniTranscript("[00:00:01] AGENT: Hello there.\n\n[00:00:09] USER: Yes, hello.")).toEqual([{ role: "agent", text: "Hello there." }, { role: "caller", text: "Yes, hello." }]);
    expect(parseVaaniTranscript("AGENT: Hi! You've reached us. USER: Hello. What are you offering?")).toEqual([
      { role: "agent", text: "Hi! You've reached us." }, { role: "caller", text: "Hello. What are you offering?" }]);
    expect(parseVaaniTranscript("Transcript is not available for further evaluations.")).toEqual([]);
    expect(parseVaaniTranscript("")).toEqual([]);
  });
});

describe("post-call entities → facts (untrusted input)", () => {
  const f = (e: Record<string, unknown>) => FactsSchema.parse(entitiesToFacts(e, new Date("2026-09-02T05:00:00Z")));
  it("treats N/A, null, 'not mentioned' and the not-processed message as missing — never as values", () => {
    const r = f({ caller_name: "N/A", location: null, project_category: "not mentioned", timeline_text: "Transcript is not available for further evaluations." });
    expect(r.callerName).toBeUndefined();
    expect(r.locationText).toBeUndefined();
    expect(r.projectCategory).toBeUndefined();
    expect(assess(r).disposition).toBe("NEEDS_CLARIFICATION");
  });
  it("parses yes/no, enums, numbers and free-text timeline relative to the call date", () => {
    const r = f({ is_complaint: "No", structural_work: "no", is_rented: "Yes", carpet_area_sqft: "1,400 sq ft", room_count: "4", scope_kind: "Full Home", property_type: "independent house",
      timeline_text: "we'd like it done by March", site_ready_text: "possession in about six weeks", engagement: "design and execution", decision_maker: "Authorised Representative" });
    expect(r).toMatchObject({ isComplaint: false, structuralWork: false, isRented: true, carpetAreaSqft: 1400, roomCount: 4, scopeKind: "full_home", propertyType: "independent_house",
      engagement: "design_and_execution", decisionMaker: "authorised_representative", siteAvailableInWeeks: 6 });
    expect(r.needByWeeks).toBeGreaterThan(20);
  });
  it("budget only from a volunteered text, using the same parser as everywhere else", () => {
    expect(f({ budget_text: "1 to 1.5 lakh maximum" }).statedBudgetMaxInr).toBe(150000);
    expect(f({ budget_text: "N/A" }).statedBudgetMaxInr).toBeUndefined();
    expect(f({}).statedBudgetMaxInr).toBeUndefined();
  });
  it("garbage enum values are dropped (never coerced) and an existing-client complaint escalates", () => {
    expect(f({ project_category: "industrial", engagement: "free money", decision_maker: "the cat" })).toMatchObject({ decisionMaker: "unknown" });
    const c = f({ is_existing_client: "yes", is_complaint: "yes", requested_person: "Nikhil", asked_for_person: "yes", caller_name: "Sheetal" });
    expect(assess(c)).toMatchObject({ disposition: "ESCALATED", priority: "urgent" });
  });
  it("a price in the entities cannot reach the facts", () => {
    expect(JSON.stringify(f({ location: "Baner", scope_kind: "full_home" }))).not.toMatch(/lakh|₹/);
  });
});

describe("webhook authentication (Vaani documents no signature → secret token, fail closed)", () => {
  const token = "s".repeat(32);
  const p = createVaaniProvider({ apiKey: KEY, webhookToken: token });
  const v = (o: { headers?: Record<string, string>; url?: string }) => p.verifyWebhook({ rawBody: "{}", headers: o.headers ?? {}, now: NOW, url: o.url });
  it("accepts the token from the URL, an x-webhook-token header or a Bearer header", () => {
    expect(v({ url: `https://app.example/api/webhooks/voice?token=${token}` })).toEqual({ ok: true });
    expect(v({ headers: { "x-webhook-token": token } })).toEqual({ ok: true });
    expect(v({ headers: { authorization: `Bearer ${token}` } })).toEqual({ ok: true });
  });
  it("rejects missing, wrong, truncated and padded tokens", () => {
    expect(v({})).toEqual({ ok: false, reason: "missing_webhook_token" });
    for (const bad of ["", "x".repeat(32), token.slice(0, 31), token + "x"]) {
      expect(v({ url: `https://app.example/api/webhooks/voice?token=${bad}` }).ok).toBe(false);
    }
  });
  it("fails closed with no configured token", () => {
    expect(createVaaniProvider({ apiKey: KEY }).verifyWebhook({ rawBody: "{}", headers: { "x-webhook-token": "anything" }, now: NOW })).toEqual({ ok: false, reason: "vaani_webhook_token_not_configured" });
  });
  it("parseEvent: malformed JSON and invalid events are rejected; informational events are acknowledged", () => {
    expect(p.parseEvent("{oops")).toEqual({ ok: false, reason: "malformed_json" });
    expect(p.parseEvent(JSON.stringify({ event: "call_started" }))).toMatchObject({ ok: false });
    expect(p.parseEvent(JSON.stringify({ event: "call_ringing", room_name: "r" }))).toMatchObject({ ok: true, ignored: true });
    expect(p.parseEvent(JSON.stringify({ event: "call_started", room_name: "r", phone_number: "+9199" }))).toMatchObject({ ok: true, event: { type: "call.started" } });
  });
});

describe("Vaani API client", () => {
  const res = (status: number, body: unknown) => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  it("sends the documented headers/paths and never leaks the key into errors", async () => {
    const f = vi.fn(() => res(200, { id: 1 }));
    const c = createVaaniClient({ apiKey: KEY, fetchImpl: f as unknown as typeof fetch });
    await c.listAgents();
    await c.triggerCall({ agentId: "a-1", contactNumber: "+919876543210", name: "Jane" });
    const [u1, i1] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(u1).toBe("https://api.vaanivoice.ai/api/agents");
    expect((i1.headers as Record<string, string>)["X-API-Key"]).toBe(KEY);
    const [u2, i2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(u2).toBe("https://api.vaanivoice.ai/api/trigger-call/");
    expect(JSON.parse(String(i2.body))).toEqual({ agent_id: "a-1", medium: "telephony", contact_number: "+919876543210", name: "Jane", dnd_check_skipped: false });
  });
  it("maps HTTP failures to categories (invalid credentials, validation, not found, rate limit, server) without the key", async () => {
    const run = async (status: number, body: unknown) => {
      const c = createVaaniClient({ apiKey: KEY, fetchImpl: (() => res(status, body)) as unknown as typeof fetch });
      return c.getCallDetails("x1").catch((e) => e as VaaniApiError);
    };
    expect(await run(401, { detail: "Invalid API key" })).toMatchObject({ category: "auth", status: 401, retryable: false });
    expect(await run(422, { detail: [{ loc: ["body", "contact_number"], msg: "field required", type: "missing" }] })).toMatchObject({ category: "validation" });
    expect(((await run(422, { detail: [{ loc: ["body", "contact_number"], msg: "field required" }] })) as Error).message).toContain("body.contact_number: field required");
    expect(await run(404, { detail: "nope" })).toMatchObject({ category: "not_found" });
    expect(await run(429, "slow down")).toMatchObject({ category: "rate_limited", retryable: true });
    const s = (await run(500, "boom")) as VaaniApiError;
    expect(s).toMatchObject({ category: "server", retryable: true });
    expect(s.message).not.toContain(KEY);
  });
  it("timeouts and network errors are 'network' errors", async () => {
    const hang = ((_: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))) as unknown as typeof fetch;
    expect(await createVaaniClient({ apiKey: KEY, fetchImpl: hang, timeoutMs: 20 }).getCallDetails("x1").catch((e) => e)).toMatchObject({ category: "network", message: "Vaani request timed out" });
    const down = (() => Promise.reject(new Error(`ECONNREFUSED ${KEY}`))) as unknown as typeof fetch;
    const e = (await createVaaniClient({ apiKey: KEY, fetchImpl: down }).getCallDetails("x1").catch((x) => x)) as Error;
    expect(e.message).toBe("Vaani request failed (network error)");
  });
});

describe("enrichment from Vaani's authenticated API", () => {
  const base = ProviderEventSchema.parse({ type: "call.completed", providerCallId: "inbound-77", occurredAt: NOW.toISOString(),
    structuredFacts: { callerType: "new_prospect", locationText: "FORGED-IN-WEBHOOK" } });
  const mk = (over: Partial<ReturnType<typeof createVaaniClient>>) => createVaaniProvider({ apiKey: KEY, webhookToken: "t".repeat(32), client: { ...createVaaniClient({ apiKey: KEY, fetchImpl: (() => { throw new Error("no network"); }) as unknown as typeof fetch }), ...over } });

  it("replaces webhook-supplied content with data pulled from call_details, and adds cost + numbers from call history", async () => {
    const p = mk({
      getCallDetails: async () => ({ transcription: "AGENT: Hello. USER: I have a flat in Baner.", entity: { location: "Baner, Pune", scope_kind: "full_home" }, summary: "Wants a redesign." }),
      getCallHistory: async () => ({ data: [{ call_id: "inbound-77", from_number: "+919900001111", to_number: "+918000000000", call_cost: 2.3 }] }),
    });
    const e = await p.enrichEvent!(base);
    expect(e.transcript).toHaveLength(2);
    expect((e.structuredFacts as { locationText: string }).locationText).toBe("Baner, Pune");
    expect(e.summary).toBe("Wants a redesign.");
    expect(e).toMatchObject({ fromNumber: "+919900001111", cost: { amount: 2.3, currency: "CREDITS" } });
  });
  it("API failures never throw and never invent cost: the webhook's own data stays and cost stays unknown", async () => {
    const boom = async () => { throw new VaaniApiError(500, "x", "server"); };
    const e = await mk({ getCallDetails: boom, getCallHistory: boom }).enrichEvent!(base);
    expect(e.cost).toBeUndefined();
    expect((e.structuredFacts as { locationText: string }).locationText).toBe("FORGED-IN-WEBHOOK");
  });
  it("only completed calls are enriched", async () => {
    const spy = vi.fn(async () => ({}));
    const e = ProviderEventSchema.parse({ type: "call.started", providerCallId: "x1", occurredAt: NOW.toISOString() });
    expect(await mk({ getCallDetails: spy as never }).enrichEvent!(e)).toBe(e);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("agent definition (what Vaani's model is told)", () => {
  it("contains the exact approved pricing sentence and the documented decline sentence", () => {
    expect(SYSTEM_PROMPT).toContain(APPROVED_PRICING_RESPONSE);
    expect(SYSTEM_PROMPT).toContain("This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.");
  });
  it("is humble, respectful and concise by instruction; forbids budget questions, bookings, callback promises and transfers", () => {
    for (const must of ["Humble, very respectful, and to the point", "ONE question at a time", "Never ask about budget", "Never say a consultation", "Never promise a callback time", "virtual assistant"]) {
      expect(SYSTEM_PROMPT, must).toContain(must);
    }
    expect(GREETING).toBe("Hello, you've reached Aangan Studio. I'm the studio's virtual assistant. How may I help you today?");
  });
  it("carries no internal price data, budget floors or per-sq-ft figures", () => {
    const withoutApproved = SYSTEM_PROMPT.replace(APPROVED_PRICING_RESPONSE, "");
    // The prompt names price topics only to forbid them; it must contain no actual figures.
    expect(withoutApproved).not.toMatch(/₹|\brs\.?\s*\d|\d[\d,.]*\s*(?:lakhs?|lacs?|crores?)|\d[\d,]*\s*(?:per|\/)\s*sq/i);
    expect(containsPricingLeak(APPROVED_PRICING_RESPONSE)).toBe(false);
  });
  it("data point names fit Vaani's 30-character limit and are unique", () => {
    const names = DATA_POINTS.map((d) => d.name);
    expect(names.every((n) => n.length <= 30)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
  it("every extracted field name is actually consumed by the mapper", () => {
    const consumed = ["caller_name", "is_existing_client", "is_complaint", "asked_for_person", "requested_person", "project_reference", "project_category", "property_type", "location",
      "carpet_area_sqft", "scope_kind", "room_count", "engagement", "complete_redesign", "structural_work", "is_rented", "timeline_text", "site_ready_text", "decision_maker",
      "budget_text", "wants_consultation", "callback_time_text", "referral_source", "earlier_enquiry_ignored", "asked_price"];
    expect(DATA_POINTS.map((d) => d.name).sort()).toEqual([...consumed].sort());
  });
  it("create-agent config follows the documented shape", () => {
    expect(AGENT_DISPLAY_NAME.length).toBeGreaterThan(3);
    expect(buildAgentConfig().persona.identity).toMatchObject({ system_prompt: SYSTEM_PROMPT, greeting_message: { agent_message: GREETING } });
  });
});
