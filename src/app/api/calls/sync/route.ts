import { z } from "zod";
import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, readJson, safe } from "@/lib/http";
import { OutboundError, syncVaaniCall } from "@/modules/telephony-events/outbound";
import { getVaaniProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Vaani lookups may take a few seconds

/** Pulls a finished call from Vaani (for local use without a public webhook, or a missed webhook). Idempotent. */
export const POST = safe(async (req: Request) => {
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const vaani = getVaaniProvider();
  if (!vaani) return json({ error: "vaani_not_configured" }, 409);
  const body = await readJson(req, z.object({ callId: z.string().trim().min(6).max(120) }).strict(), 2048);
  if (!body.ok) return body.res;
  try {
    const out = await syncVaaniCall(await getDb(), vaani, body.data.callId, a.user.email);
    return json({ status: out.status, enquiryId: out.enquiryId, reason: out.reason }, out.httpStatus === 500 ? 500 : 200);
  } catch (e) {
    if (e instanceof OutboundError) return json({ error: e.code, detail: e.message }, e.status);
    throw e;
  }
});
