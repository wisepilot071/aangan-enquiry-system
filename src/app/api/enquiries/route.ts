import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, parseDate, resolveScope, safe } from "@/lib/http";
import { listEnquiries } from "@/modules/analytics/queries";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const a = await apiUser(req, "view");
  if ("error" in a) return a.error;
  const p = new URL(req.url).searchParams;
  const num = (k: string) => { const n = Number(p.get(k)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; };
  const sort = p.get("sort");
  const res = await listEnquiries(await getDb(), {
    scope: resolveScope(p.get("scope")), q: p.get("q")?.slice(0, 80) || undefined, disposition: p.get("disposition") || undefined,
    callStatus: p.get("callStatus") || undefined, notificationStatus: p.get("notificationStatus") || undefined,
    review: p.get("review") === "yes" ? "yes" : p.get("review") === "no" ? "no" : undefined,
    projectCategory: p.get("projectCategory") || undefined, location: p.get("location")?.slice(0, 60) || undefined,
    from: parseDate(p.get("from")), to: parseDate(p.get("to"), true),
    sort: sort === "oldest" || sort === "priority" ? sort : "newest", page: num("page"), pageSize: num("pageSize"),
  });
  return json(res);
});
