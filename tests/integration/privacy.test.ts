import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { auditEvents, costs, enquiries, notifications } from "@/db/schema";
import { deleteEnquiry, purgeOldTranscripts } from "@/modules/enquiries/privacy";
import { ingestEvent } from "@/modules/telephony-events/ingest";
import { simulateCallEvents } from "@/modules/telephony-events/simulator";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

async function call(id: string, scenario: string, startedAt: Date) {
  const s = PHONE_SCENARIOS.find((x) => x.id === scenario)!;
  const { events } = simulateCallEvents({ callId: id, fromNumber: "+919900011100", startedAt, callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })) });
  for (const e of events) await ingestEvent(h.db, "mock", e, e.eventId!);
  return (await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, id)))[0]!;
}

describe("privacy tooling", () => {
  it("purges only old transcripts and keeps the structured record", async () => {
    const old = await call("old", "T01", new Date(Date.now() - 400 * 86_400_000));
    const fresh = await call("fresh", "T01", new Date());
    expect(await purgeOldTranscripts(h.db, 365)).toBe(1);
    const [o] = await h.db.select().from(enquiries).where(eq(enquiries.id, old.id));
    const [f] = await h.db.select().from(enquiries).where(eq(enquiries.id, fresh.id));
    expect(o!.transcript).toBeNull();
    expect(o!.disposition).toBe("QUALIFIED");
    expect(f!.transcript).not.toBeNull();
    await expect(purgeOldTranscripts(h.db, 0)).rejects.toThrow();
  });
  it("deleting an enquiry cascades and leaves only a reference in the audit log", async () => {
    const e = await call("to-delete", "T09", new Date());
    expect((await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id))).length).toBe(1);
    expect(await deleteEnquiry(h.db, e.id, "admin@test")).toBe(true);
    expect(await deleteEnquiry(h.db, e.id, "admin@test")).toBe(false);
    expect((await h.db.select().from(notifications).where(eq(notifications.enquiryId, e.id)))).toEqual([]);
    expect((await h.db.select().from(costs).where(eq(costs.enquiryId, e.id)))).toEqual([]);
    const a = await h.db.select().from(auditEvents).where(eq(auditEvents.action, "privacy.enquiry_deleted"));
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.detail)).toMatch(/AGN-\d{5}/);
    expect(JSON.stringify(a[0]!.detail)).not.toMatch(/Sheetal|\+91/);
    const left = await h.db.execute(sql`select count(*)::int n from call_events where enquiry_id = ${e.id}`);
    expect(left.rows[0]!.n).toBe(0);
  });
});
