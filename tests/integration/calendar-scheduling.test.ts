import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { enquiries, notifications } from "@/db/schema";
import { CalendarError, type CalendarClient } from "@/modules/calendar/google";
import { scheduleConsultation } from "@/modules/calendar/schedule";
import { ingestEvent } from "@/modules/telephony-events/ingest";
import { simulateCallEvents } from "@/modules/telephony-events/simulator";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";
import type { SendResult, TelegramSender } from "@/modules/notifications/telegram";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

function fakeCalendar(opts: { busy?: { start: Date; end: Date }[]; failWith?: CalendarError } = {}) {
  const created: { id: string; start: Date; tentative: boolean; description: string; enquiryId: string }[] = [];
  const deleted: string[] = [];
  const client: CalendarClient = {
    calendarId: "studio",
    async freeBusy() { if (opts.failWith) throw opts.failWith; return opts.busy ?? []; },
    async createEvent(e) { const id = `ev${created.length + 1}`; created.push({ id, start: e.start, tentative: e.tentative, description: e.description, enquiryId: e.enquiryId }); return { id, htmlLink: `https://calendar.google.com/event?eid=${id}` }; },
    async findByEnquiry(id) { const c = created.find((x) => x.enquiryId === id); return c ? { id: c.id, start: c.start.toISOString() } : null; },
    async updateEvent() {}, async deleteEvent(id) { deleted.push(id); },
  };
  return { client, created, deleted };
}
const sent: string[] = [];
const sender: TelegramSender = { async send(t): Promise<SendResult> { sent.push(t); return { ok: true, messageId: "1" }; } };
const deps = { sender, sleep: async () => {}, baseUrl: "https://app.test" };

let n = 0;
async function qualifiedLead(calendar: CalendarClient | null | undefined) {
  const s = PHONE_SCENARIOS.find((x) => x.id === "T01")!;
  const id = `cal-${++n}`;
  const { events } = simulateCallEvents({ callId: id, fromNumber: `+9198000${40000 + n}`, startedAt: new Date(), callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })), factOverrides: s.overrides ?? {} });
  for (const e of events) await ingestEvent(h.db, "vaani", e, e.eventId!, { ...deps, calendarClient: calendar });
  const [row] = await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, id));
  return row!;
}
const notesFor = (id: string) => h.db.select().from(notifications).where(eq(notifications.enquiryId, id));

describe("automatic Google Calendar scheduling after a qualified call", () => {
  it("creates ONE tentative event, records it, keeps the enquiry honest, and tells the designer on Telegram", async () => {
    const cal = fakeCalendar();
    const row = await qualifiedLead(cal.client);
    expect(row.disposition).toBe("QUALIFIED");
    expect(cal.created).toHaveLength(1);
    expect(cal.created[0]).toMatchObject({ tentative: true, enquiryId: row.id });
    expect(cal.created[0]!.description).toContain("NOT promised");
    expect(row).toMatchObject({ calendarEventId: "ev1", consultationStatus: "requested" }); // never "confirmed" by the AI
    expect(row.consultationAt?.getTime()).toBe(cal.created[0]!.start.getTime());
    const cats = (await notesFor(row.id)).map((x) => x.category).sort();
    expect(cats).toEqual(["consultation_scheduled", "qualified_handoff"]);
    const msg = (await notesFor(row.id)).find((x) => x.category === "consultation_scheduled")!.messagePreview!;
    expect(msg).toContain("PENCILLED IN");
    expect(msg).toContain("no time was promised");
    expect(msg).toContain("calendar.google.com");
    expect(msg).not.toMatch(/₹|lakh|crore/i);
  });
  it("is idempotent: re-running does not create another event or message", async () => {
    const cal = fakeCalendar();
    const row = await qualifiedLead(cal.client);
    expect(await scheduleConsultation(h.db, row.id, { ...deps, client: cal.client })).toEqual({ status: "skipped", reason: "already_scheduled" });
    expect(cal.created).toHaveLength(1);
    expect((await notesFor(row.id)).filter((x) => x.category === "consultation_scheduled")).toHaveLength(1);
  });
  it("picks a free slot around existing meetings", async () => {
    const tomorrow = Date.now() + 25 * 3600_000;
    const all = fakeCalendar({ busy: [{ start: new Date(Date.now()), end: new Date(tomorrow + 5 * 24 * 3600_000) }] });
    const row = await qualifiedLead(all.client);
    expect(row.consultationAt!.getTime()).toBeGreaterThan(tomorrow + 5 * 24 * 3600_000 - 1);
  });
  it("a Google failure is reported to the designer, never hidden, and never breaks the enquiry", async () => {
    const cal = fakeCalendar({ failWith: new CalendarError(403, "Google Calendar POST failed: Forbidden", "auth") });
    const row = await qualifiedLead(cal.client);
    expect(row.disposition).toBe("QUALIFIED");
    expect(row.calendarEventId).toBeNull();
    const msg = (await notesFor(row.id)).find((x) => x.category === "consultation_scheduled")!.messagePreview!;
    expect(msg).toContain("NOT SCHEDULED AUTOMATICALLY");
    expect(msg).toContain("Forbidden");
    expect(msg).toContain("schedule this consultation manually");
  });
  it("without Google credentials nothing is attempted and nothing is claimed", async () => {
    const row = await qualifiedLead(null);
    expect(row.calendarEventId).toBeNull();
    expect((await notesFor(row.id)).map((x) => x.category)).toEqual(["qualified_handoff"]);
  });
  it("only qualified, real (non-demo) leads are scheduled", async () => {
    const cal = fakeCalendar();
    const s = PHONE_SCENARIOS.find((x) => x.id === "T10")!; // closed (budget too low)
    const id = `cal-closed-${++n}`;
    const { events } = simulateCallEvents({ callId: id, fromNumber: `+9198000${49000 + n}`, startedAt: new Date(), callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })), factOverrides: s.overrides ?? {} });
    for (const e of events) await ingestEvent(h.db, "vaani", e, e.eventId!, { ...deps, calendarClient: cal.client });
    expect(cal.created).toHaveLength(0);
    const demoId = `cal-demo-${++n}`;
    const t1 = PHONE_SCENARIOS.find((x) => x.id === "T01")!;
    const demo = simulateCallEvents({ callId: demoId, fromNumber: "+919800049999", startedAt: new Date(), callerLines: t1.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })) });
    for (const e of demo.events) await ingestEvent(h.db, "mock", e, e.eventId!, { ...deps, calendarClient: cal.client });
    expect(cal.created).toHaveLength(0);
  });
});
