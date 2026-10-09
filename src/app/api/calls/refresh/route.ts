import { getDb } from "@/db/client";
import { apiUser, clientIp } from "@/lib/auth-server";
import { json, safe } from "@/lib/http";
import { createRateLimiter } from "@/modules/authentication";
import { syncPendingCalls } from "@/modules/telephony-events/outbound";
import { getVaaniProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const limiter = createRateLimiter(8, 60_000);

/** Fetches calls that finished on Vaani but whose transcript never reached us. Called by the dashboard every 30 s while any are pending. */
export const POST = safe(async (req: Request) => {
  const a = await apiUser(req, "import", true);
  if ("error" in a) return a.error;
  if (!limiter.allow(clientIp(req))) return json({ error: "rate_limited" }, 429);
  const vaani = getVaaniProvider();
  if (!vaani) return json({ pending: 0, imported: 0, stillProcessing: 0, failed: 0 });
  return json(await syncPendingCalls(await getDb(), vaani, a.user.email));
});
