import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { clientIp } from "@/lib/auth-server";
import { json, readJson, safe } from "@/lib/http";
import { audit } from "@/modules/audit";
import { SESSION_COOKIE, createRateLimiter, createSessionToken, hashPassword, isSameOrigin, sessionCookieOptions, verifyPassword, type Role } from "@/modules/authentication";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter(8, 5 * 60_000);
// Computed once so unknown-email and wrong-password requests take comparable time.
const DUMMY_HASH = hashPassword("not-a-real-password");

export const POST = safe(async (req: Request) => {
  if (!isSameOrigin(req)) return json({ error: "cross_origin_request_blocked" }, 403);
  const parsed = await readJson(req, z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), 4096);
  if (!parsed.ok) return parsed.res;
  const email = parsed.data.email.toLowerCase();
  if (!limiter.allow(`${clientIp(req)}|${email}`)) return json({ error: "too_many_attempts" }, 429);

  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.email, email));
  const ok = verifyPassword(parsed.data.password, u?.passwordHash ?? DUMMY_HASH) && Boolean(u);
  if (!ok || !u) {
    await audit(db, { actor: "anonymous", action: "auth.login_failed", entityType: "user", detail: { email } });
    return json({ error: "invalid_credentials" }, 401);
  }
  const token = await createSessionToken({ id: u.id, email: u.email, role: u.role as Role });
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  await audit(db, { actor: u.email, action: "auth.login", entityType: "user", entityId: u.id });
  return json({ ok: true, role: u.role });
});
