import { and, desc, eq, gte, inArray, lte, or, sql, ilike, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { costs, enquiries, followUpTasks, notifications } from "@/db/schema";
import { computeMetrics, summariseCosts, type CostRow, type EnquiryRow, type Metrics, type NotificationRow } from "./metrics";

export type Scope = "production" | "demo";
export interface Range { from?: Date; to?: Date }

const periodExpr = sql`coalesce(${enquiries.callStartedAt}, ${enquiries.createdAt})`;

/** `inboundOnly`: real enquiries. Operator-placed outbound test calls are never counted as incoming calls or enquiries. */
function baseWhere(scope: Scope, range: Range, inboundOnly = false): SQL[] {
  const w: SQL[] = [eq(enquiries.isDemo, scope === "demo")];
  if (inboundOnly) w.push(eq(enquiries.direction, "inbound"));
  if (range.from) w.push(gte(periodExpr, range.from));
  if (range.to) w.push(lte(periodExpr, range.to));
  return w;
}

/** Loads exactly the rows the metrics are computed from, so every number is traceable to records. */
export async function loadMetricsData(db: Db, scope: Scope, range: Range) {
  const rows = await db.select().from(enquiries).where(and(...baseWhere(scope, range, true)));
  const ids = rows.map((r) => r.id);
  const notes = ids.length ? await db.select().from(notifications).where(inArray(notifications.enquiryId, ids)) : [];
  const cost = ids.length ? await db.select().from(costs).where(inArray(costs.enquiryId, ids)) : [];
  return { rows: rows as EnquiryRow[], notes: notes as NotificationRow[], costs: cost as CostRow[] };
}

export async function getMetrics(db: Db, scope: Scope, range: Range = {}, now = new Date()): Promise<Metrics & { range: Range; scope: Scope }> {
  const d = await loadMetricsData(db, scope, range);
  return { ...computeMetrics(d.rows, d.notes, d.costs, now), range, scope };
}

export async function getDailySeries(db: Db, scope: Scope, range: Range) {
  const rows = await db.select({
    day: sql<string>`to_char((${periodExpr}) at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
    total: sql<number>`count(*)::int`,
    qualified: sql<number>`count(*) filter (where ${enquiries.disposition} = 'QUALIFIED')::int`,
    unqualified: sql<number>`count(*) filter (where ${enquiries.disposition} in ('CLOSED_NOT_FORWARDED','DECLINED'))::int`,
    other: sql<number>`count(*) filter (where ${enquiries.disposition} is null or ${enquiries.disposition} not in ('QUALIFIED','CLOSED_NOT_FORWARDED','DECLINED'))::int`,
  }).from(enquiries).where(and(...baseWhere(scope, range, true))).groupBy(sql`1`).orderBy(sql`1`);
  return rows;
}

export interface ListFilters {
  scope: Scope; q?: string; disposition?: string; callStatus?: string; notificationStatus?: string; review?: "yes" | "no";
  projectCategory?: string; location?: string; direction?: "inbound" | "outbound"; from?: Date; to?: Date;
  sort?: "newest" | "oldest" | "priority"; page?: number; pageSize?: number;
}

export async function listEnquiries(db: Db, f: ListFilters) {
  const w = baseWhere(f.scope, { from: f.from, to: f.to });
  if (f.disposition) w.push(f.disposition === "NONE" ? sql`${enquiries.disposition} is null` : eq(enquiries.disposition, f.disposition));
  if (f.callStatus) w.push(eq(enquiries.callStatus, f.callStatus));
  if (f.direction) w.push(eq(enquiries.direction, f.direction));
  if (f.review === "yes") w.push(eq(enquiries.needsHumanReview, true));
  if (f.review === "no") w.push(eq(enquiries.needsHumanReview, false));
  if (f.projectCategory) w.push(eq(enquiries.projectCategory, f.projectCategory));
  if (f.location) w.push(ilike(enquiries.locationText, `%${f.location.replace(/[%_]/g, "")}%`));
  if (f.notificationStatus) {
    w.push(sql`exists (select 1 from ${notifications} n where n.enquiry_id = ${enquiries.id} and n.status = ${f.notificationStatus})`);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "")}%`;
    w.push(or(ilike(enquiries.callerName, like), ilike(enquiries.locationText, like), ilike(enquiries.callerPhone, like), ilike(enquiries.providerCallId, like),
      sql`('AGN-' || lpad(${enquiries.seq}::text, 5, '0')) ilike ${like}`)!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const order = f.sort === "oldest" ? [sql`${periodExpr} asc`]
    : f.sort === "priority" ? [sql`case ${enquiries.priority} when 'urgent' then 0 when 'high' then 1 else 2 end`, sql`${periodExpr} desc`]
      : [sql`${periodExpr} desc`];
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(enquiries).where(and(...w));
  const items = await db.select({
    id: enquiries.id, seq: enquiries.seq, isDemo: enquiries.isDemo, direction: enquiries.direction, callStatus: enquiries.callStatus, callStartedAt: enquiries.callStartedAt,
    createdAt: enquiries.createdAt, callerName: enquiries.callerName, callerPhone: enquiries.callerPhone, projectCategory: enquiries.projectCategory,
    propertyType: enquiries.propertyType, locationText: enquiries.locationText, disposition: enquiries.disposition, priority: enquiries.priority,
    needsHumanReview: enquiries.needsHumanReview, consultationStatus: enquiries.consultationStatus, summary: enquiries.summary,
    firstResponseAt: enquiries.firstResponseAt,
  }).from(enquiries).where(and(...w)).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);

  const ids = items.map((i) => i.id);
  const notes = ids.length ? await db.select({ enquiryId: notifications.enquiryId, status: notifications.status, category: notifications.category }).from(notifications).where(inArray(notifications.enquiryId, ids)) : [];
  return { items: items.map((i) => ({ ...i, notifications: notes.filter((n) => n.enquiryId === i.id) })), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Urgent queue: complaints, human requests, high-priority incomplete calls, failed handoffs, missed calls. */
export async function getUrgentQueue(db: Db, scope: Scope) {
  const tasks = await db.select({
    id: followUpTasks.id, kind: followUpTasks.kind, note: followUpTasks.note, status: followUpTasks.status, createdAt: followUpTasks.createdAt,
    completedAt: followUpTasks.completedAt, completedBy: followUpTasks.completedBy, enquiryId: followUpTasks.enquiryId,
    seq: enquiries.seq, callerName: enquiries.callerName, callerPhone: enquiries.callerPhone, priority: enquiries.priority, locationText: enquiries.locationText,
    isDemo: enquiries.isDemo,
  }).from(followUpTasks).innerJoin(enquiries, eq(enquiries.id, followUpTasks.enquiryId))
    .where(eq(enquiries.isDemo, scope === "demo")).orderBy(desc(followUpTasks.createdAt)).limit(200);
  const rank: Record<string, number> = { complaint: 0, human_requested: 1, failed_handoff: 2, frustrated_followup: 3, missed_call: 4, dropped_call: 5 };
  return tasks.sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) || (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

/** Outbound test calls: counted and costed separately so they never distort enquiry metrics. */
export async function getOutboundTestSummary(db: Db, scope: Scope, range: Range = {}) {
  const w = baseWhere(scope, range).concat(eq(enquiries.direction, "outbound"));
  const rows = await db.select({ id: enquiries.id, callStatus: enquiries.callStatus }).from(enquiries).where(and(...w));
  const ids = rows.map((r) => r.id);
  const cost = ids.length ? await db.select().from(costs).where(inArray(costs.enquiryId, ids)) : [];
  return { calls: rows.length, completed: rows.filter((r) => r.callStatus === "completed").length, cost: summariseCosts(cost as CostRow[], 0) };
}
