import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { getConfig } from "@/lib/config";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

/** Reads and validates a JSON body with a hard size cap. Never echoes the payload back. */
export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = 64 * 1024): Promise<{ ok: true; data: T } | { ok: false; res: NextResponse }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, res: json({ error: "payload_too_large" }, 413) };
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return { ok: false, res: json({ error: "content_type_must_be_application_json" }, 415) };
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, res: json({ error: "payload_too_large" }, 413) };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, res: json({ error: "malformed_json" }, 400) }; }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, res: json({ error: "validation_failed", issues: r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400) };
  return { ok: true, data: r.data };
}

function errorChain(e: unknown): string[] {
  const out: string[] = [];
  for (let cur: unknown = e, i = 0; cur instanceof Error && i < 5; cur = cur.cause, i++) out.push(cur.message);
  return out;
}

/** Wraps a handler: unexpected errors become a safe 500/503 with no internals or payload content. */
export function safe<A extends unknown[]>(fn: (...a: A) => Promise<Response>) {
  return async (...a: A): Promise<Response> => {
    try { return await fn(...a); }
    catch (e) {
      const chain = errorChain(e);
      const msg = chain[0] ?? "unknown";
      console.error(JSON.stringify({ level: "error", msg: "unhandled_route_error", error: msg.slice(0, 120) }));
      const dbDown = chain.some((m) => /connect|ECONN|ENOTFOUND|timeout|terminated|is closed|too many clients/i.test(m));
      return json({ error: dbDown ? "database_unavailable" : "internal_error" }, dbDown ? 503 : 500);
    }
  };
}

/** Default scope: demo records while in mock mode, production records in live mode. Never mixed. */
export function resolveScope(v: string | null | undefined): "demo" | "production" {
  if (v === "demo" || v === "production") return v;
  return getConfig().mode === "mock" ? "demo" : "production";
}

export function parseDate(v: string | null, endOfDay = false): Date | undefined {
  if (!v) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30` : v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
