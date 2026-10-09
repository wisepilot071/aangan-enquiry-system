import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getConfig } from "@/lib/config";

export type Role = "admin" | "operator" | "viewer";
export interface SessionUser { id: string; email: string; role: Role }

export const SESSION_COOKIE = "aangan_session";
const SESSION_TTL_SEC = 8 * 60 * 60;

/* ---------- password hashing (scrypt, no extra dependency) ---------- */
const N = 16384, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, n, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = crypto.scryptSync(plain, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: R, p: P });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---------- sessions (signed JWT in an HttpOnly cookie) ---------- */
const g = globalThis as unknown as { __aanganDevSecret?: string };
function secretKey(): Uint8Array {
  const c = getConfig();
  if (c.SESSION_SECRET) return new TextEncoder().encode(c.SESSION_SECRET);
  g.__aanganDevSecret ??= crypto.randomBytes(32).toString("hex"); // dev only; sessions reset on restart
  return new TextEncoder().encode(g.__aanganDevSecret);
}

export async function createSessionToken(u: SessionUser): Promise<string> {
  return new SignJWT({ email: u.email, role: u.role })
    .setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime(`${SESSION_TTL_SEC}s`).sign(secretKey());
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const role = payload.role;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string" || !["admin", "operator", "viewer"].includes(String(role))) return null;
    return { id: payload.sub, email: payload.email, role: role as Role };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: getConfig().NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SEC };
}

/* ---------- authorisation ---------- */
/** "import" = pull an existing call from the provider (read-only toward the provider, idempotent, no spend). */
export type Action = "view" | "view_transcript" | "operate" | "admin" | "import";
const MATRIX: Record<Role, Action[]> = {
  admin: ["view", "view_transcript", "operate", "admin", "import"],
  operator: ["view", "view_transcript", "operate", "import"],
  viewer: ["view", "import"],
};
export const can = (role: Role | undefined, action: Action) => Boolean(role && MATRIX[role].includes(action));

/* ---------- rate limiting (in-memory, per process) ---------- */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return true;
    },
  };
}

/** Mutations must come from our own origin (defence in depth on top of SameSite=Lax + JSON bodies). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl, tests) — still need a valid session
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}
