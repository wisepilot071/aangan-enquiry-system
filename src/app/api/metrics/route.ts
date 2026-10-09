import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, parseDate, resolveScope, safe } from "@/lib/http";
import { getDailySeries, getMetrics } from "@/modules/analytics/queries";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const a = await apiUser(req, "view");
  if ("error" in a) return a.error;
  const p = new URL(req.url).searchParams;
  const scope = resolveScope(p.get("scope"));
  const range = { from: parseDate(p.get("from")), to: parseDate(p.get("to"), true) };
  const db = await getDb();
  return json({ scope, metrics: await getMetrics(db, scope, range), daily: await getDailySeries(db, scope, range) });
});
