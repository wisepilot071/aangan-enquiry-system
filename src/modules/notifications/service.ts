import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { enquiries, followUpTasks, notifications } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { audit } from "@/modules/audit";
import { createTelegramSender, type TelegramSender } from "./telegram";

export type NotificationCategory = "qualified_handoff" | "urgent_escalation" | "missed_call_followup";

/** Creates the notification row once per (enquiry, category). Returns null if it already exists (duplicate-safe). */
export async function createNotification(
  db: Db,
  e: { enquiryId: string; isDemo: boolean },
  category: NotificationCategory,
  messagePreview: string,
): Promise<string | null> {
  const [row] = await db.insert(notifications).values({
    enquiryId: e.enquiryId, category, dedupeKey: `${e.enquiryId}:${category}`, messagePreview, isDemo: e.isDemo,
  }).onConflictDoNothing().returning({ id: notifications.id });
  return row?.id ?? null;
}

export interface DispatchDeps {
  /** null = no Telegram credentials. */
  sender?: TelegramSender | null;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

export function defaultSender(): TelegramSender | null {
  const c = getConfig();
  return c.TELEGRAM_BOT_TOKEN && c.TELEGRAM_CHAT_ID ? createTelegramSender({ token: c.TELEGRAM_BOT_TOKEN, chatId: c.TELEGRAM_CHAT_ID }) : null;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends one notification with bounded retries.
 *  - DEMO enquiries never reach real Telegram: status "mock_sent" (visibly simulated).
 *  - No credentials → "unavailable" (retryable later by an operator).
 *  - Transient errors retry with exponential backoff; permanent errors stop immediately.
 * A failure never touches the enquiry itself; it only records the failure and opens a follow-up task.
 */
export async function dispatchNotification(db: Db, notificationId: string, deps: DispatchDeps = {}): Promise<string> {
  const [n] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!n) throw new Error("notification not found");
  if (n.status === "sent" || n.status === "mock_sent") return n.status; // idempotent
  const text = n.messagePreview ?? "";
  const now = new Date();

  if (n.isDemo) {
    await db.update(notifications).set({ status: "mock_sent", attempts: n.attempts + 1, lastAttemptAt: now, sentAt: now }).where(eq(notifications.id, n.id));
    await audit(db, { actor: "system", action: "notification.mock_sent", entityType: "notification", entityId: n.id, detail: { category: n.category } });
    return "mock_sent";
  }

  const sender = deps.sender === undefined ? defaultSender() : deps.sender;
  if (!sender) {
    await db.update(notifications).set({ status: "unavailable", errorCategory: "telegram_not_configured", lastAttemptAt: now }).where(eq(notifications.id, n.id));
    await audit(db, { actor: "system", action: "notification.unavailable", entityType: "notification", entityId: n.id, detail: { category: n.category } });
    await openFailedHandoffTask(db, n.enquiryId, "Telegram not configured — hand off manually.");
    return "unavailable";
  }

  const max = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? realSleep;
  const base = deps.baseBackoffMs ?? 500;
  let attempts = n.attempts;
  let last: { category: string; detail: string } = { category: "unknown", detail: "" };

  while (attempts < n.attempts + max) {
    attempts += 1;
    const r = await sender.send(text);
    if (r.ok) {
      const sentAt = new Date();
      await db.update(notifications).set({ status: "sent", attempts, providerMessageId: r.messageId, sentAt, lastAttemptAt: sentAt, errorCategory: null }).where(eq(notifications.id, n.id));
      await db.update(enquiries).set({ notifiedAt: sentAt }).where(and(eq(enquiries.id, n.enquiryId), eq(enquiries.isDemo, false)));
      await db.update(followUpTasks).set({ status: "done", completedAt: sentAt, completedBy: "system" })
        .where(and(eq(followUpTasks.enquiryId, n.enquiryId), eq(followUpTasks.kind, "failed_handoff"), eq(followUpTasks.status, "open")));
      await audit(db, { actor: "system", action: "notification.sent", entityType: "notification", entityId: n.id, detail: { category: n.category, attempts } });
      return "sent";
    }
    last = { category: r.category, detail: r.detail };
    await db.update(notifications).set({ attempts, lastAttemptAt: new Date(), errorCategory: r.detail }).where(eq(notifications.id, n.id));
    if (r.category === "permanent") break;
    if (attempts < n.attempts + max) await sleep(r.category === "rate_limited" ? Math.min(r.retryAfterMs ?? base, 30_000) : base * 2 ** (attempts - n.attempts - 1));
  }

  await db.update(notifications).set({ status: "failed", attempts, errorCategory: last.detail }).where(eq(notifications.id, n.id));
  await audit(db, { actor: "system", action: "notification.failed", entityType: "notification", entityId: n.id, detail: { category: n.category, error: last.detail, attempts } });
  await openFailedHandoffTask(db, n.enquiryId, `Telegram delivery failed (${last.detail}) — hand off manually.`);
  return "failed";
}

async function openFailedHandoffTask(db: Db, enquiryId: string, note: string) {
  await db.insert(followUpTasks).values({ enquiryId, kind: "failed_handoff", note })
    .onConflictDoUpdate({ target: [followUpTasks.enquiryId, followUpTasks.kind], set: { status: "open", note, completedAt: null, completedBy: null } });
}

/** Operator-triggered retry; only failed / unavailable notifications can be retried. */
export async function retryNotification(db: Db, notificationId: string, actor: string, deps: DispatchDeps = {}): Promise<string> {
  const [n] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!n) throw new Error("notification not found");
  if (!["failed", "unavailable"].includes(n.status)) throw new Error(`cannot retry a notification in status "${n.status}"`);
  await audit(db, { actor, action: "notification.retry_requested", entityType: "notification", entityId: n.id });
  await db.update(notifications).set({ status: "pending" }).where(and(eq(notifications.id, n.id), inArray(notifications.status, ["failed", "unavailable"])));
  return dispatchNotification(db, n.id, deps);
}
