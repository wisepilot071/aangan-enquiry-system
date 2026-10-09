import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { enquiries, notifications } from "@/db/schema";
import { apiUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { json, readJson, safe } from "@/lib/http";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";
import { enquiryRef } from "@/modules/notifications/format";
import { ingestEvent } from "@/modules/telephony-events/ingest";
import { simulateCallEvents } from "@/modules/telephony-events/simulator";

export const dynamic = "force-dynamic";

const Body = z.object({
  scenarioId: z.string().max(20).optional(),
  callerLines: z.array(z.object({ agentQuestion: z.string().max(500).optional(), text: z.string().min(1).max(1000) })).min(1).max(30).optional(),
  outcome: z.enum(["completed", "missed", "disconnected", "failed"]).default("completed"),
  fromNumber: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  firstResponseDelaySec: z.number().min(0).max(3600).nullable().optional(),
  durationSec: z.number().int().min(1).max(7200).optional(),
  providerCostInr: z.number().min(0).max(100000).optional(),
}).strict().refine((b) => b.outcome === "missed" || b.scenarioId || b.callerLines, { message: "provide scenarioId or callerLines" });

/** MOCK mode only. Every record created here is flagged DEMO and excluded from production reporting. */
export const POST = safe(async (req: Request) => {
  if (getConfig().mode !== "mock") return json({ error: "simulator_disabled_in_live_mode" }, 403);
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const b = body.data;

  const scenario = b.scenarioId ? PHONE_SCENARIOS.find((s) => s.id === b.scenarioId) : undefined;
  if (b.scenarioId && !scenario) return json({ error: "unknown_scenario" }, 404);
  const lines = scenario ? scenario.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })) : b.callerLines ?? [];
  const callId = `sim-${crypto.randomUUID()}`;
  const fromNumber = b.fromNumber ?? "+9199000" + String(Math.floor(10000 + Math.random() * 89999));
  const { events, transcript } = simulateCallEvents({
    callId, callerLines: lines, outcome: b.outcome, fromNumber,
    startedAt: scenario ? new Date(scenario.date) : new Date(),
    firstResponseDelaySec: b.firstResponseDelaySec === undefined ? 3 : b.firstResponseDelaySec,
    durationSec: b.durationSec, providerCostInr: b.providerCostInr, factOverrides: scenario?.overrides,
  });

  const db = await getDb();
  const outcomes = [];
  // Simulated processing delay (1.5 s after each event) keeps replayed historical calls on their own timeline.
  for (const e of events) {
    const now = new Date(new Date(e.occurredAt).getTime() + 1500);
    outcomes.push(await ingestEvent(db, "mock", e, e.eventId ?? crypto.randomUUID(), { baseUrl: getConfig().APP_BASE_URL, now }));
  }
  const [row] = await db.select().from(enquiries).where(eq(enquiries.providerCallId, callId));
  const notes = row ? await db.select().from(notifications).where(eq(notifications.enquiryId, row.id)) : [];
  return json({
    demo: true, enquiryId: row?.id, ref: row ? enquiryRef(row.seq) : null, disposition: row?.disposition ?? null, callStatus: row?.callStatus,
    // A call that ends while a clarification is still open is stored as HUMAN_REVIEW (nobody is left to ask).
    expectedDisposition: scenario ? (scenario.expected.disposition === "NEEDS_CLARIFICATION" ? "HUMAN_REVIEW" : scenario.expected.disposition) : null, transcript, events: events.map((e) => e.type), outcomes: outcomes.map((o) => o.status),
    notifications: notes.map((n) => ({ category: n.category, status: n.status, preview: n.messagePreview })),
  }, 201);
});
