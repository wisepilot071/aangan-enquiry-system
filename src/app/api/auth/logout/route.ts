import { cookies } from "next/headers";
import { json, safe } from "@/lib/http";
import { SESSION_COOKIE, isSameOrigin } from "@/modules/authentication";

export const POST = safe(async (req: Request) => {
  if (!isSameOrigin(req)) return json({ error: "cross_origin_request_blocked" }, 403);
  (await cookies()).delete(SESSION_COOKIE);
  return json({ ok: true });
});
