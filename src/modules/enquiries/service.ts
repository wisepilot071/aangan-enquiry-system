import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { auditEvents, callEvents, costs, enquiries, followUpTasks, notifications, qualificationAssessments } from "@/db/schema";
import { audit } from "@/modules/audit";
import { enquiryRef } from "@/modules/notifications/format";

export async function getEnquiryDetail(db: Db, id: string, opts: { includeTranscript: boolean }) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [e] = await db.select().from(enquiries).where(eq(enquiries.id, id));
  if (!e) return null;
  const [assessments, notes, costRows, tasks, events, auditRows, linked] = await Promise.all([
    db.select().from(qualificationAssessments).where(eq(qualificationAssessments.enquiryId, id)).orderBy(desc(qualificationAssessments.assessedAt)),
    db.select().from(notifications).where(eq(notifications.enquiryId, id)).orderBy(asc(notifications.createdAt)),
    db.select().from(costs).where(eq(costs.enquiryId, id)),
    db.select().from(followUpTasks).where(eq(followUpTasks.enquiryId, id)).orderBy(asc(followUpTasks.createdAt)),
    db.select().from(callEvents).where(eq(callEvents.enquiryId, id)).orderBy(asc(callEvents.receivedAt)),
    db.select().from(auditEvents).where(eq(auditEvents.entityId, id)).orderBy(asc(auditEvents.at)),
    e.previousEnquiryId ? db.select({ id: enquiries.id, seq: enquiries.seq, callStatus: enquiries.callStatus }).from(enquiries).where(eq(enquiries.id, e.previousEnquiryId)) : Promise.resolve([]),
  ]);
  const { transcript, ...rest } = e;
  return {
    ...rest, ref: enquiryRef(e.seq),
    transcript: opts.includeTranscript ? transcript : null,
    transcriptAvailable: transcript !== null,
    assessments, notifications: notes, costs: costRows, tasks, events, audit: auditRows,
    previous: linked[0] ? { id: linked[0].id, ref: enquiryRef(linked[0].seq), callStatus: linked[0].callStatus } : null,
  };
}

export const UpdateEnquirySchema = z.object({
  humanReviewStatus: z.enum(["open", "resolved"]).optional(),
  consultationStatus: z.enum(["none", "requested", "confirmed"]).optional(),
  conversionStatus: z.enum(["unknown", "in_progress", "converted", "lost"]).optional(),
  projectValueInr: z.number().positive().max(1e10).nullable().optional(),
  disposition: z.enum(["QUALIFIED", "CLOSED_NOT_FORWARDED", "DECLINED", "HUMAN_REVIEW", "ESCALATED"]).optional(),
  reason: z.string().trim().min(3).max(300).optional(),
}).strict().refine((v) => !v.disposition || v.reason, { message: "reason is required when changing the disposition", path: ["reason"] })
  .refine((v) => v.projectValueInr === undefined || v.projectValueInr === null || v.conversionStatus === "converted", {
    message: "projectValueInr may only be recorded together with conversionStatus=converted", path: ["projectValueInr"] });

/** Manual operator change. Every change is audited with who/when/why. Nothing is ever auto-confirmed. */
export async function updateEnquiry(db: Db, id: string, actor: string, input: z.infer<typeof UpdateEnquirySchema>) {
  const [before] = await db.select().from(enquiries).where(eq(enquiries.id, id));
  if (!before) return null;
  const patch: Partial<typeof enquiries.$inferInsert> = { updatedAt: new Date() };
  if (input.humanReviewStatus) { patch.humanReviewStatus = input.humanReviewStatus; patch.needsHumanReview = input.humanReviewStatus === "open"; }
  if (input.consultationStatus) patch.consultationStatus = input.consultationStatus;
  if (input.conversionStatus) patch.conversionStatus = input.conversionStatus;
  if (input.projectValueInr !== undefined) patch.projectValueInr = input.projectValueInr === null ? null : String(Math.round(input.projectValueInr));
  if (input.disposition) patch.disposition = input.disposition;
  await db.update(enquiries).set(patch).where(eq(enquiries.id, id));
  await audit(db, {
    actor, action: input.disposition ? "disposition.changed_manually" : "enquiry.updated_manually", entityType: "enquiry", entityId: id,
    detail: { ref: enquiryRef(before.seq), changes: input, from: { disposition: before.disposition, consultation: before.consultationStatus, conversion: before.conversionStatus } },
  });
  return getEnquiryDetail(db, id, { includeTranscript: false });
}

export async function completeTask(db: Db, taskId: string, actor: string) {
  if (!z.string().uuid().safeParse(taskId).success) return null;
  const [t] = await db.update(followUpTasks).set({ status: "done", completedAt: new Date(), completedBy: actor }).where(eq(followUpTasks.id, taskId)).returning();
  if (t) await audit(db, { actor, action: "task.completed", entityType: "enquiry", entityId: t.enquiryId, detail: { kind: t.kind } });
  return t ?? null;
}
