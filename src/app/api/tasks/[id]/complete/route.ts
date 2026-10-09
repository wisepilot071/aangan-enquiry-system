import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, safe } from "@/lib/http";
import { completeTask } from "@/modules/enquiries/service";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const t = await completeTask(await getDb(), (await params).id, a.user.email);
  return t ? json({ ok: true }) : json({ error: "not_found" }, 404);
});
