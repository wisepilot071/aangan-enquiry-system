import { z } from "zod";
import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, readJson, safe } from "@/lib/http";
import { OutboundError, syncRecentCalls, syncVaaniCall } from "@/modules/telephony-events/outbound";
import { getVaaniProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vaani lookups may take a few seconds each

const Body = z.union([
  z.object({ callId: z.string().trim().min(6).max(120) }).strict(),
  z.object({ recent: z.literal(true) }).strict(),
]);

/**
 * Imports finished calls from Vaani's API: one call by id, or recent calls (best effort). Safe to repeat.
 * Allowed for every role: it only reads from Vaani and stores what already exists there.
 */
export const POST = safe(async (req: Request) => {
  const a = await apiUser(req, "import", true);
  if ("error" in a) return a.error;
  const vaani = getVaaniProvider();
  if (!vaani) return json({ error: "vaani_not_configured" }, 409);
  const body = await readJson(req, Body, 2048);
  if (!body.ok) return body.res;
  const db = await getDb();
  try {
    if ("recent" in body.data) return json({ ok: true, ...(await syncRecentCalls(db, vaani, a.user.email)) });
    const out = await syncVaaniCall(db, vaani, body.data.callId, a.user.email);
    return json({ status: out.status, enquiryId: out.enquiryId, reason: out.reason }, out.httpStatus === 500 ? 500 : 200);
  } catch (e) {
    if (e instanceof OutboundError) return json({ error: e.code, detail: e.message }, e.status);
    throw e;
  }
});
