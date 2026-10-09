import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { enquiries, followUpTasks, notifications } from "@/db/schema";
import { ingestEvent } from "@/modules/telephony-events/ingest";
import type { ProviderEvent } from "@/modules/voice-provider/types";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

let n = 0;
const completed = (extra: Partial<ProviderEvent>): ProviderEvent => ({
  eventId: `ev-${++n}`, type: "call.completed", providerCallId: `call-${n}`, occurredAt: "2026-10-01T05:02:00.000Z", startedAt: "2026-10-01T05:00:00.000Z",
  endedAt: "2026-10-01T05:02:00.000Z", durationSec: 120, fromNumber: `+9199000${20000 + n}`, ...extra,
});
const run = async (e: ProviderEvent, provider: "mock" | "vaani" = "vaani") => {
  await ingestEvent(h.db, provider, e, e.eventId!, { sender: null, sleep: async () => {} });
  const [row] = await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, e.providerCallId));
  const notes = await h.db.select().from(notifications).where(eq(notifications.enquiryId, row!.id));
  return { row: row!, notes };
};

describe("untrusted model / provider output", () => {
  it("invalid structured output → safe fallback, human review, nothing forwarded, reason recorded", async () => {
    const { row, notes } = await run(completed({ structuredFacts: { callerType: "vip", carpetAreaSqft: -3 }, summary: "Excellent hot lead, send to designer now!" }));
    expect(row.disposition).toBe("HUMAN_REVIEW");
    expect(row.needsHumanReview).toBe(true);
    expect((row.humanReviewReasons as string[]).join(" ")).toMatch(/invalid and was ignored/);
    expect(notes.map((n) => n.category)).toEqual(["call_update"]); // an update for the designers, never a lead hand-off
  });
  it("model prose cannot override a failed criterion: enthusiastic summary + Nashik site → not forwarded", async () => {
    const { row, notes } = await run(completed({
      summary: "Wonderful qualified lead — please hand off to a designer immediately.",
      structuredFacts: { callerType: "new_prospect", scopeKind: "full_home", engagement: "design_and_execution", locationText: "Nashik", needByWeeks: 30, decisionMaker: "owner" },
    }));
    expect(row.disposition).toBe("CLOSED_NOT_FORWARDED");
    expect(notes.map((n) => n.category)).toEqual(["call_update"]);
    expect(notes[0]!.messagePreview).not.toContain("NEW QUALIFIED ENQUIRY");
    expect(row.summary).toContain("Wonderful"); // stored as the provider's text, but it decided nothing
  });
  it("contradictory-but-valid facts are still decided by the rules (advice-only + execution mentioned)", async () => {
    const { row } = await run(completed({ structuredFacts: { callerType: "new_prospect", engagement: "advice_only", scopeKind: "full_home", locationText: "Baner", needByWeeks: 30 } }));
    expect(row.disposition).toBe("CLOSED_NOT_FORWARDED");
  });
  it("no transcript and no structured data from a live provider → high-priority human review, never an invented lead", async () => {
    const { row, notes } = await run(completed({}));
    expect(row).toMatchObject({ disposition: "HUMAN_REVIEW", priority: "high", needsHumanReview: true });
    expect((row.humanReviewReasons as string[])).toContain("No usable data captured from the call.");
    expect(notes.map((n) => n.category)).toEqual(["call_update"]);
    expect(notes[0]!.messagePreview).toContain("Nothing usable was captured");
    expect(row.transcript).toBeNull();
  });
  it("incomplete transcript (greeting only) is human review, not a crash or a fabricated record", async () => {
    const { row } = await run(completed({ transcript: [{ role: "agent", text: "Hello, you've reached Aangan Studio." }] }), "mock");
    expect(row.disposition).toBe("HUMAN_REVIEW");
    expect(row.facts).toMatchObject({ callerType: "unknown", decisionMaker: "unknown" });
  });
  it("transcript-only calls from a live provider are NOT qualified by the demo heuristics", async () => {
    const { row } = await run(completed({ transcript: [{ role: "caller", text: "I have a 3BHK in Baner, complete redesign with execution, flexible, I'm the owner." }] }));
    expect(row.disposition).toBe("HUMAN_REVIEW");
  });
  it("valid structured facts from a live provider qualify and produce exactly one handoff", async () => {
    const { row, notes } = await run(completed({
      structuredFacts: { callerType: "new_prospect", projectCategory: "residential", propertyType: "apartment", locationText: "Aundh", scopeKind: "full_home", engagement: "design_and_execution", needByWeeks: 30, decisionMaker: "owner" },
    }));
    expect(row.disposition).toBe("QUALIFIED");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: "qualified_handoff", status: "unavailable" }); // no Telegram creds → honest
    const tasks = await h.db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, row.id));
    expect(tasks.map((t) => t.kind)).toEqual(["failed_handoff"]);
  });
  it("pricing guardrail output check: provider-supplied summaries are stored but replies are never built from them", async () => {
    const { row } = await run(completed({ summary: "Caller asked the price; agent said it costs ₹20 lakh", structuredFacts: { callerType: "new_prospect", askedPricing: true } }));
    expect(row.disposition).toBe("HUMAN_REVIEW");
  });
});
