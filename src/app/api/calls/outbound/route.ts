import { z } from "zod";
import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { json, readJson, safe } from "@/lib/http";
import { createRateLimiter } from "@/modules/authentication";
import { OutboundError, placeTestCall } from "@/modules/telephony-events/outbound";
import { getVaaniProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Vaani lookups may take a few seconds
const limiter = createRateLimiter(5, 10 * 60_000);

const Body = z.object({
  contactNumber: z.string().trim().max(20),
  name: z.string().trim().min(1).max(80),
  consent: z.boolean(),
}).strict();

/** Places a real outbound TEST call via Vaani. Operator/admin only; live Vaani mode only. */
export const POST = safe(async (req: Request) => {
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const vaani = getVaaniProvider();
  const agentId = getConfig().VAANI_AGENT_ID;
  if (!vaani?.client) return json({ error: "vaani_not_configured", detail: "Set VOICE_PROVIDER=vaani and VAANI_API_KEY." }, 409);
  if (!agentId) return json({ error: "agent_not_configured", detail: "Run `npm run vaani:setup` and set VAANI_AGENT_ID." }, 409);
  if (!limiter.allow(a.user.email)) return json({ error: "too_many_calls", detail: "Limit: 5 test calls per 10 minutes." }, 429);
  const body = await readJson(req, Body, 4096);
  if (!body.ok) return body.res;
  try {
    const r = await placeTestCall(await getDb(), vaani.client, agentId, body.data, a.user.email);
    return json({ ok: true, callId: r.callId, liveCaptionsUrl: r.liveCaptionsUrl }, 201);
  } catch (e) {
    if (e instanceof OutboundError) return json({ error: e.code, detail: e.message }, e.status);
    throw e;
  }
});
