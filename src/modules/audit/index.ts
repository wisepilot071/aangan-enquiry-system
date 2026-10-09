import { auditEvents } from "@/db/schema";
import type { Db } from "@/db/client";

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie|signature/i;

/** Removes secret-looking keys and truncates long strings so audit rows never carry credentials or bulk PII. */
export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeDetail(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitizeDetail(v, depth + 1);
  }
  return out;
}

export async function audit(
  db: Db,
  e: { actor: string; action: string; entityType: string; entityId?: string | null; detail?: unknown },
): Promise<void> {
  await db.insert(auditEvents).values({
    actor: e.actor, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null,
    detail: (sanitizeDetail(e.detail ?? {}) as object) ?? {},
  });
}
