import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, can, isSameOrigin, verifySessionToken, type Action, type SessionUser } from "@/modules/authentication";

export async function getUserOrNull(): Promise<SessionUser | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

/** For server-rendered pages: redirects to /login (unauthenticated) or "/" (forbidden). */
export async function requireUser(action: Action = "view"): Promise<SessionUser> {
  const u = await getUserOrNull();
  if (!u) redirect("/login");
  if (!can(u.role, action)) redirect("/?denied=1");
  return u;
}

/** For route handlers: returns the user, or a ready-made 401/403 response. */
export async function apiUser(req: Request, action: Action = "view", mutating = false): Promise<{ user: SessionUser } | { error: NextResponse }> {
  if (mutating && !isSameOrigin(req)) return { error: NextResponse.json({ error: "cross_origin_request_blocked" }, { status: 403 }) };
  const u = await getUserOrNull();
  if (!u) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!can(u.role, action)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user: u };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
