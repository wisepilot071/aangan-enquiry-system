import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { enquiries } from "@/db/schema";
import { audit } from "@/modules/audit";
import { enquiryRef } from "@/modules/notifications/format";

/**
 * Removes stored call transcripts older than `days`. The structured enquiry record, qualification
 * rationale and costs are kept; only the free-text conversation is erased. Returns the number purged.
 */
export async function purgeOldTranscripts(db: Db, days: number, actor = "system"): Promise<number> {
  if (!Number.isFinite(days) || days < 1) throw new Error("days must be a positive number");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await db.update(enquiries).set({ transcript: null, updatedAt: new Date() })
    .where(and(isNotNull(enquiries.transcript), lt(sql`coalesce(${enquiries.callStartedAt}, ${enquiries.createdAt})`, cutoff)))
    .returning({ id: enquiries.id });
  await audit(db, { actor, action: "privacy.transcripts_purged", entityType: "system", detail: { olderThanDays: days, count: rows.length } });
  return rows.length;
}

/**
 * Erases one enquiry and everything hanging off it (assessments, notifications, costs, tasks cascade;
 * provider events are detached). Keeps only a minimal audit record: the reference, never personal data.
 */
export async function deleteEnquiry(db: Db, id: string, actor: string): Promise<boolean> {
  const [e] = await db.select({ seq: enquiries.seq }).from(enquiries).where(eq(enquiries.id, id));
  if (!e) return false;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.update(enquiries).set({ previousEnquiryId: null }).where(eq(enquiries.previousEnquiryId, id));
    await t.delete(enquiries).where(eq(enquiries.id, id));
    await audit(t, { actor, action: "privacy.enquiry_deleted", entityType: "enquiry", entityId: id, detail: { ref: enquiryRef(e.seq) } });
  });
  return true;
}
