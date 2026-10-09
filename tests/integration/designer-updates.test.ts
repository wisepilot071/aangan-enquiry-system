import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { enquiries, notifications } from "@/db/schema";
import { updateEnquiry, UpdateEnquirySchema } from "@/modules/enquiries/service";
import { googleCalendarLink, redactMoney } from "@/modules/notifications/format";
import { ingestEvent } from "@/modules/telephony-events/ingest";
import { simulateCallEvents } from "@/modules/telephony-events/simulator";
import type { SendResult, TelegramSender } from "@/modules/notifications/telegram";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

let n = 0;
async function call(scenario: string, opts: { demo?: boolean } = {}) {
  const s = PHONE_SCENARIOS.find((x) => x.id === scenario)!;
  const id = `upd-${scenario}-${++n}`;
  const { events } = simulateCallEvents({ callId: id, fromNumber: `+9199000${30000 + n}`, startedAt: new Date(s.date), callerLines: s.turns.map((t) => ({ agentQuestion: t.agent, text: t.caller })), factOverrides: s.overrides ?? (opts.demo === false ? {} : undefined) });
  for (const e of events) await ingestEvent(h.db, opts.demo === false ? "vaani" : "mock", e, e.eventId!, { sender: null, sleep: async () => {} });
  const [row] = await h.db.select().from(enquiries).where(eq(enquiries.providerCallId, id));
  const notes = await h.db.select().from(notifications).where(eq(notifications.enquiryId, row!.id));
  return { row: row!, notes };
}

describe("designers get an update for every AI-handled call", () => {
  it("a closed call: what happened, outcome, why, and the next action — and no money figures", async () => {
    const { notes } = await call("T10"); // volunteered ₹1–1.5 lakh for a kitchen + bedroom
    expect(notes.map((x) => x.category)).toEqual(["call_update"]);
    const m = notes[0]!.messagePreview!;
    for (const line of ["AANGAN STUDIO — CALL UPDATE", "Outcome: Not forwarded", "Why:", "What happened:", "Consultation:", "Next action: No action needed"]) expect(m).toContain(line);
    expect(m).not.toMatch(/₹|lakh|crore|budget[^\n]{0,30}\d{4}/i); // the caller's own figure stays on the dashboard
  });
  it("calls needing a person say so and tell the designer what to do", async () => {
    const { notes } = await call("T16");
    expect(notes[0]!.messagePreview).toContain("Outcome: Needs a person to decide");
    expect(notes[0]!.messagePreview).toContain("Next action: Read the transcript");
  });
  it("a qualified lead's hand-off now also says what happened and the next action", async () => {
    const { notes } = await call("T01");
    expect(notes.map((x) => x.category)).toEqual(["qualified_handoff"]); // one message, not two
    expect(notes[0]!.messagePreview).toContain("What happened:");
    expect(notes[0]!.messagePreview).toContain("Next action: A designer should contact the caller and confirm a consultation time. Nothing has been booked yet.");
  });
  it("a requested (unconfirmed) consultation is reported as NOT booked", async () => {
    const { notes } = await call("T13"); // caller says "let's book"
    expect(notes[0]!.messagePreview).toMatch(/Consultation requested \(NOT yet booked\)|NOT booked yet/);
  });
  it("a failed informational update never opens a 'hand off manually' task", async () => {
    const { row, notes } = await call("T03", { demo: false });
    expect(notes[0]).toMatchObject({ category: "call_update", status: "unavailable" });
    const tasks = await h.db.execute(`select kind from follow_up_tasks where enquiry_id = '${row.id}'` as never);
    expect((tasks as unknown as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe("money is kept out of Telegram", () => {
  it.each([
    ["He has a budget of 50,000 for one room.", "He has a budget of [amount] for one room."],
    ["Budget is ₹1.5 lakh maximum", "Budget is [amount] maximum"],
    ["wants to spend around 10 lakhs", "wants to spend around [amount]"],
    ["quoted Rs. 20,000 earlier", "quoted [amount] earlier"],
    ["Interior design for a 2BHK, 950 sq ft, in Wakad", "Interior design for a 2BHK, 950 sq ft, in Wakad"],
    ["completion within 3 months", "completion within 3 months"],
  ])("%s", (input, expected) => expect(redactMoney(input)).toBe(expected));
});

describe("consultation scheduled → Telegram announcement", () => {
  const ok: SendResult = { ok: true, messageId: "1" };
  const sender = (): TelegramSender & { sent: string[] } => ({ sent: [], async send(t) { this.sent.push(t); return ok; } });

  it("calendar link is a valid, prefilled Google Calendar template in IST", () => {
    const url = new URL(googleCalendarLink("Aangan consultation — Priya", new Date("2026-10-12T05:30:00Z"), "AGN-00001"));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261012T053000Z/20261012T063000Z");
    expect(url.searchParams.get("ctz")).toBe("Asia/Kolkata");
  });
  it("a time cannot be recorded unless the consultation is confirmed", () => {
    expect(UpdateEnquirySchema.safeParse({ consultationStatus: "requested", consultationAt: "2026-10-12T11:00:00+05:30" }).success).toBe(false);
    expect(UpdateEnquirySchema.safeParse({ consultationStatus: "confirmed", consultationAt: "2026-10-12T11:00:00+05:30" }).success).toBe(true);
    expect(UpdateEnquirySchema.safeParse({ consultationStatus: "confirmed", consultationAt: "tomorrow" }).success).toBe(false);
  });
  it("confirming announces it once (with the calendar link); a reschedule announces again; 'requested' announces nothing", async () => {
    const { row } = await call("T20", { demo: false });
    const s = sender();
    const count = async () => (await h.db.select().from(notifications).where(eq(notifications.enquiryId, row.id))).filter((x) => x.category === "consultation_scheduled");

    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "requested" }, { sender: s });
    expect(await count()).toHaveLength(0);

    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "confirmed", consultationAt: "2026-10-12T11:00:00+05:30", consultationNote: "Aryan — site visit" }, { sender: s, sleep: async () => {} });
    const c = await count();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ status: "sent" });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain("AANGAN STUDIO — CONSULTATION SCHEDULED");
    expect(s.sent[0]).toContain("When: 12 Oct 2026, 11:00 am IST");
    expect(s.sent[0]).toContain("Details: Aryan — site visit");
    expect(s.sent[0]).toContain("https://calendar.google.com/calendar/render?");

    // saving the same time again does not spam
    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "confirmed", consultationAt: "2026-10-12T11:00:00+05:30" }, { sender: s, sleep: async () => {} });
    expect(await count()).toHaveLength(1);
    expect(s.sent).toHaveLength(1);

    // rescheduling is announced
    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "confirmed", consultationAt: "2026-10-14T16:30:00+05:30" }, { sender: s, sleep: async () => {} });
    expect(await count()).toHaveLength(2);
    expect(s.sent[1]).toContain("14 Oct 2026, 04:30 pm IST");

    const [after] = await h.db.select().from(enquiries).where(eq(enquiries.id, row.id));
    expect(after!.consultationStatus).toBe("confirmed");
    expect(after!.consultationAt!.toISOString()).toBe("2026-10-14T11:00:00.000Z");

    // withdrawing the schedule clears the time
    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "none" }, { sender: s });
    const [cleared] = await h.db.select().from(enquiries).where(eq(enquiries.id, row.id));
    expect(cleared).toMatchObject({ consultationStatus: "none", consultationAt: null });
  });
  it("demo enquiries only get a simulated announcement", async () => {
    const { row } = await call("T01");
    const s = sender();
    await updateEnquiry(h.db, row.id, "op", { consultationStatus: "confirmed", consultationAt: "2026-10-12T11:00:00+05:30" }, { sender: s });
    const c = (await h.db.select().from(notifications).where(eq(notifications.enquiryId, row.id))).filter((x) => x.category === "consultation_scheduled");
    expect(c[0]).toMatchObject({ status: "mock_sent", isDemo: true });
    expect(c[0]!.messagePreview).toContain("DEMO / MOCK");
    expect(s.sent).toHaveLength(0);
  });
});
