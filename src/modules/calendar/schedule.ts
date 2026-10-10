import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { enquiries } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { audit } from "@/modules/audit";
import { createNotification, dispatchNotification, type DispatchDeps } from "@/modules/notifications/service";
import { enquiryRef, formatConsultationProposed, formatConsultationUnscheduled } from "@/modules/notifications/format";
import { CalendarError, createGoogleCalendarClient, parseServiceAccount, type CalendarClient } from "./google";
import { DEFAULT_SLOT_POLICY, findNextSlot, type SlotPolicy } from "./slots";

export type ScheduleOutcome =
  | { status: "scheduled"; at: Date; eventId: string }
  | { status: "skipped"; reason: "not_qualified" | "demo" | "already_scheduled" | "not_configured" | "not_found" }
  | { status: "failed"; reason: string };

export function defaultCalendarClient(): CalendarClient | null {
  const c = getConfig();
  if (!c.GOOGLE_SERVICE_ACCOUNT_JSON || !c.GOOGLE_CALENDAR_ID) return null;
  try { return createGoogleCalendarClient({ serviceAccount: parseServiceAccount(c.GOOGLE_SERVICE_ACCOUNT_JSON), calendarId: c.GOOGLE_CALENDAR_ID }); }
  catch { return null; }
}

export interface ScheduleDeps extends DispatchDeps {
  /** undefined = build from configuration; null = calendar not configured. */
  client?: CalendarClient | null;
  now?: Date;
  baseUrl?: string;
  policy?: SlotPolicy;
}

/**
 * After a call is QUALIFIED, places a TENTATIVE design-consultation event on the studio's Google Calendar and tells the designer on Telegram.
 * The caller was never promised this time, so the enquiry stays "requested" until a person confirms. One event per enquiry:
 * an atomic claim on calendar_event_id, plus a lookup by private extended property, make repeats and crashes safe.
 * Any failure is reported to the designer (Telegram) rather than hidden; the enquiry itself is never affected.
 */
export async function scheduleConsultation(db: Db, enquiryId: string, deps: ScheduleDeps = {}): Promise<ScheduleOutcome> {
  const [e] = await db.select().from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!e) return { status: "skipped", reason: "not_found" };
  if (e.disposition !== "QUALIFIED") return { status: "skipped", reason: "not_qualified" };
  if (e.isDemo) return { status: "skipped", reason: "demo" };
  if (e.calendarEventId || e.consultationStatus === "confirmed") return { status: "skipped", reason: "already_scheduled" };
  const client = deps.client === undefined ? defaultCalendarClient() : deps.client;
  if (!client) return { status: "skipped", reason: "not_configured" };

  const now = deps.now ?? new Date();
  const ref = enquiryRef(e.seq);
  const ctx = { ref, enquiryId: e.id, callerName: e.callerName, callerPhone: e.callerPhone, isDemo: false, baseUrl: deps.baseUrl };
  try {
    let event = await client.findByEnquiry(e.id); // an earlier attempt may have created it before crashing
    let at: Date;
    if (event?.start) at = new Date(event.start);
    else {
      const policy = deps.policy ?? DEFAULT_SLOT_POLICY;
      const horizon = new Date(now.getTime() + (policy.searchDays + 2) * 86_400_000);
      const slot = findNextSlot(await client.freeBusy(now, horizon), now, policy);
      if (!slot) throw new CalendarError(0, `no free ${policy.durationMin}-minute slot in the next ${policy.searchDays} days`, "conflict");
      event = await client.createEvent({
        summary: `Aangan design consultation — ${e.callerName ?? ref} (to be confirmed)`,
        description: `${ref}. Caller: ${e.callerName ?? "name not given"}. Phone: ${e.callerPhone ?? "n/a"}. Location: ${e.locationText ?? "n/a"}.\nPlaced automatically after a qualified AI call. The caller was NOT promised this time: please call to confirm.`,
        start: slot.start, end: slot.end, tentative: true, enquiryId: e.id,
      });
      at = slot.start;
    }
    // Claim: only one writer may record the event on the enquiry.
    const claimed = await db.update(enquiries).set({
      calendarEventId: event.id, calendarEventLink: event.htmlLink ?? null, consultationAt: at,
      consultationStatus: "requested", consultationNote: "Proposed slot placed on the calendar; caller not promised a time.",
    }).where(and(eq(enquiries.id, e.id), isNull(enquiries.calendarEventId))).returning({ id: enquiries.id });
    if (!claimed.length) {
      await client.deleteEvent(event.id).catch(() => undefined); // lost a race with a concurrent run: remove our duplicate
      return { status: "skipped", reason: "already_scheduled" };
    }
    await audit(db, { actor: "system", action: "calendar.event_created", entityType: "enquiry", entityId: e.id, detail: { ref, at: at.toISOString(), eventId: event.id } });
    const nid = await createNotification(db, { enquiryId: e.id, isDemo: false }, "consultation_scheduled",
      formatConsultationProposed({ ...ctx, locationText: e.locationText, at, eventLink: event.htmlLink }), `auto:${at.toISOString()}`);
    if (nid) await dispatchNotification(db, nid, deps).catch(() => undefined);
    return { status: "scheduled", at, eventId: event.id };
  } catch (err) {
    const reason = err instanceof CalendarError ? err.message : "unexpected error while scheduling";
    await audit(db, { actor: "system", action: "calendar.failed", entityType: "enquiry", entityId: e.id, detail: { ref, reason, category: err instanceof CalendarError ? err.category : "unknown" } });
    const nid = await createNotification(db, { enquiryId: e.id, isDemo: false }, "consultation_scheduled", formatConsultationUnscheduled({ ...ctx, reason }), "failed");
    if (nid) await dispatchNotification(db, nid, deps).catch(() => undefined);
    return { status: "failed", reason };
  }
}
