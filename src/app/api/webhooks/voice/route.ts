import { getDb } from "@/db/client";
import { clientIp } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { json, safe } from "@/lib/http";
import { createRateLimiter } from "@/modules/authentication";
import { MAX_BODY_BYTES, ingestWebhook } from "@/modules/telephony-events/ingest";
import { getVoiceProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Vaani lookups may take a few seconds
const limiter = createRateLimiter(300, 60_000);

/**
 * Provider webhook. Fails closed: unsigned / mis-signed / malformed requests are rejected and recorded
 * (without storing their content). Duplicate deliveries return 200 so the provider stops retrying.
 */
export const POST = safe(async (req: Request) => {
  if (!limiter.allow(clientIp(req))) return json({ error: "rate_limited" }, 429);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const raw = await req.text();
  const db = await getDb();
  const out = await ingestWebhook(db, getVoiceProvider(), raw, req.headers, { baseUrl: getConfig().APP_BASE_URL, url: req.url });
  return json({ status: out.status, reason: out.reason, enquiryId: out.enquiryId }, out.httpStatus);
});
