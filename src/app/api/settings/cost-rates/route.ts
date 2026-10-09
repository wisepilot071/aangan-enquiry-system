import { z } from "zod";
import { getDb } from "@/db/client";
import { settings } from "@/db/schema";
import { apiUser } from "@/lib/auth-server";
import { json, readJson, safe } from "@/lib/http";
import { audit } from "@/modules/audit";
import { RATES_KEY, getRates } from "@/modules/costs";

export const dynamic = "force-dynamic";

const RatesSchema = z.object({
  voicePerMinuteInr: z.number().min(0).max(10_000).optional(),
  telephonyPerMinuteInr: z.number().min(0).max(10_000).optional(),
  source: z.string().trim().min(5, "describe where the rate comes from (e.g. invoice number)").max(200).optional(),
}).strict().refine((v) => (v.voicePerMinuteInr === undefined && v.telephonyPerMinuteInr === undefined) || Boolean(v.source), {
  message: "a source is required when any rate is set", path: ["source"],
});

export const GET = safe(async (req: Request) => {
  const a = await apiUser(req, "view");
  if ("error" in a) return a.error;
  return json({ rates: await getRates(await getDb()) });
});

/** Admin only. Rates are never pre-filled; an empty body clears them (costs revert to unknown). */
export const PUT = safe(async (req: Request) => {
  const a = await apiUser(req, "admin", true);
  if ("error" in a) return a.error;
  const body = await readJson(req, RatesSchema, 4096);
  if (!body.ok) return body.res;
  const db = await getDb();
  await db.insert(settings).values({ key: RATES_KEY, value: body.data, updatedBy: a.user.email })
    .onConflictDoUpdate({ target: settings.key, set: { value: body.data, updatedBy: a.user.email, updatedAt: new Date() } });
  await audit(db, { actor: a.user.email, action: "settings.updated", entityType: "settings", entityId: RATES_KEY, detail: body.data });
  return json({ rates: body.data });
});
