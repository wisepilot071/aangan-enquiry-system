import { z } from "zod";
import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, safe } from "@/lib/http";
import { retryNotification } from "@/modules/notifications/service";

export const dynamic = "force-dynamic";

export const POST = safe(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
  try {
    return json({ status: await retryNotification(await getDb(), id, a.user.email) });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    const notFound = m.includes("not found");
    return json({ error: notFound ? "not_found" : "not_retryable", detail: m.slice(0, 120) }, notFound ? 404 : 409);
  }
});
