import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { users } from "@/db/schema";
import { hashPassword } from "@/modules/authentication";
import { signMockPayload, MOCK_SIGNATURE_HEADER, MOCK_TIMESTAMP_HEADER } from "@/modules/voice-provider/mock";
import { testDb } from "../helpers/db";

// ---- test doubles for Next runtime pieces (no HTTP server needed) ----
let handle: DbHandle;
const jar = new Map<string, string>();
vi.mock("@/db/client", async (orig) => {
  const actual = await orig<typeof import("@/db/client")>();
  return { ...actual, getDb: async () => handle.db, getDbHandle: async () => handle };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  }),
}));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

const SECRET = "x".repeat(40);
const MOCK_SECRET = "mock-webhook-secret-123456";
const PW = "correct-horse-battery";
const BASE = "http://localhost:3100";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx?: any) => Promise<Response>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + url, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (url: string) => new Request(BASE + url);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let login: Handler, enquiriesGET: Handler, enquiryRoute: { GET: Handler; PATCH: Handler }, simulate: Handler, metricsGET: Handler;
let ratesRoute: { GET: Handler; PUT: Handler }, webhook: Handler, health: Handler, retry: Handler, scenariosGET: Handler;

async function signIn(email: string, password = PW) {
  jar.clear();
  return login(post("/api/auth/login", { email, password }, { "x-forwarded-for": `ip-${Math.random()}` }));
}

beforeAll(async () => {
  Object.assign(process.env, { SESSION_SECRET: SECRET, MOCK_WEBHOOK_SECRET: MOCK_SECRET, VOICE_PROVIDER: "mock" });
  vi.stubEnv("NODE_ENV", "test");
  const { resetConfigForTests } = await import("@/lib/config");
  resetConfigForTests();
  handle = await testDb();
  const h = hashPassword(PW);
  await handle.db.insert(users).values([
    { email: "admin@t.test", passwordHash: h, role: "admin" },
    { email: "op@t.test", passwordHash: h, role: "operator" },
    { email: "viewer@t.test", passwordHash: h, role: "viewer" },
  ]);
  login = (await import("@/app/api/auth/login/route")).POST;
  enquiriesGET = (await import("@/app/api/enquiries/route")).GET;
  enquiryRoute = await import("@/app/api/enquiries/[id]/route");
  simulate = (await import("@/app/api/simulate/route")).POST;
  metricsGET = (await import("@/app/api/metrics/route")).GET;
  ratesRoute = await import("@/app/api/settings/cost-rates/route");
  webhook = (await import("@/app/api/webhooks/voice/route")).POST;
  health = (await import("@/app/api/health/route")).GET;
  retry = (await import("@/app/api/notifications/[id]/retry/route")).POST;
  scenariosGET = (await import("@/app/api/scenarios/route")).GET;
});
afterAll(async () => { vi.unstubAllEnvs(); });
beforeEach(() => jar.clear());

describe("authentication & authorisation", () => {
  it("every private endpoint rejects unauthenticated requests with 401", async () => {
    const calls: [string, Promise<Response>][] = [
      ["GET /api/enquiries", enquiriesGET(get("/api/enquiries"))],
      ["GET /api/enquiries/:id", enquiryRoute.GET(get("/api/enquiries/x"), ctx("x"))],
      ["PATCH /api/enquiries/:id", enquiryRoute.PATCH(patch("/api/enquiries/x", {}), ctx("x"))],
      ["GET /api/metrics", metricsGET(get("/api/metrics"))],
      ["POST /api/simulate", simulate(post("/api/simulate", { scenarioId: "T01" }))],
      ["GET /api/scenarios", scenariosGET(get("/api/scenarios"))],
      ["GET /api/settings/cost-rates", ratesRoute.GET(get("/api/settings/cost-rates"))],
      ["PUT /api/settings/cost-rates", ratesRoute.PUT(new Request(BASE + "/api/settings/cost-rates", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }))],
      ["POST retry", retry(post("/api/notifications/x/retry", {}), ctx("x"))],
    ];
    for (const [name, p] of calls) expect((await p).status, name).toBe(401);
  });
  it("wrong password and unknown user are both 401 with the same body; no cookie is set", async () => {
    const a = await signIn("admin@t.test", "nope-nope-nope");
    const b = await signIn("ghost@t.test", "nope-nope-nope");
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.json()).toEqual(await b.json());
    expect(jar.size).toBe(0);
  });
  it("successful login sets an HttpOnly-style session; garbage/forged tokens are rejected", async () => {
    expect((await signIn("op@t.test")).status).toBe(200);
    expect(jar.get("aangan_session")).toBeTruthy();
    expect((await enquiriesGET(get("/api/enquiries"))).status).toBe(200);
    jar.set("aangan_session", "not.a.jwt");
    expect((await enquiriesGET(get("/api/enquiries"))).status).toBe(401);
    // a token signed with a different secret
    const { SignJWT } = await import("jose");
    const forged = await new SignJWT({ email: "admin@t.test", role: "admin" }).setProtectedHeader({ alg: "HS256" }).setSubject("1").setExpirationTime("1h").sign(new TextEncoder().encode("y".repeat(40)));
    jar.set("aangan_session", forged);
    expect((await enquiriesGET(get("/api/enquiries"))).status).toBe(401);
  });
  it("login is rate limited per client + email", async () => {
    const hdr = { "x-forwarded-for": "9.9.9.9" };
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await login(post("/api/auth/login", { email: "admin@t.test", password: "bad-bad-bad-bad" }, hdr))).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
  });
  it("login rejects cross-origin posts and malformed bodies", async () => {
    expect((await login(post("/api/auth/login", { email: "admin@t.test", password: PW }, { origin: "https://evil.example", host: "localhost:3100" }))).status).toBe(403);
    expect((await login(new Request(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }))).status).toBe(400);
    expect((await login(post("/api/auth/login", { email: "not-an-email", password: "x" }))).status).toBe(400);
  });
});

describe("simulation, dashboard queries and role restrictions", () => {
  let enquiryId = "";
  it("viewer cannot operate the simulator; operator can; results are flagged DEMO", async () => {
    await signIn("viewer@t.test");
    expect((await simulate(post("/api/simulate", { scenarioId: "T01" }))).status).toBe(403);
    await signIn("op@t.test");
    const res = await simulate(post("/api/simulate", { scenarioId: "T01", providerCostInr: 7.5 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ demo: true, disposition: "QUALIFIED", expectedDisposition: "QUALIFIED" });
    expect(body.notifications[0]).toMatchObject({ category: "qualified_handoff", status: "mock_sent" });
    enquiryId = body.enquiryId;
    for (const id of ["T03", "T09"]) expect((await simulate(post("/api/simulate", { scenarioId: id }))).status).toBe(201);
    expect((await simulate(post("/api/simulate", { outcome: "missed" }))).status).toBe(201);
  });
  it("simulator validates input", async () => {
    await signIn("op@t.test");
    expect((await simulate(post("/api/simulate", {}))).status).toBe(400);
    expect((await simulate(post("/api/simulate", { scenarioId: "NOPE" }))).status).toBe(404);
    expect((await simulate(post("/api/simulate", { scenarioId: "T01", surprise: 1 }))).status).toBe(400);
    expect((await simulate(post("/api/simulate", { callerLines: [{ text: "" }] }))).status).toBe(400);
    expect((await simulate(new Request(BASE + "/api/simulate", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" }))).status).toBe(415);
  });
  it("metrics API equals direct database counts; demo is never mixed into production", async () => {
    await signIn("viewer@t.test");
    const demo = await (await metricsGET(get("/api/metrics?scope=demo"))).json();
    const rows = await handle.db.execute(sql`select count(*)::int n, count(*) filter (where disposition='QUALIFIED')::int q, count(*) filter (where call_status='missed')::int m from enquiries where is_demo = true`);
    expect(demo.metrics.calls.total).toBe(rows.rows[0]!.n);
    expect(demo.metrics.qualification.qualified).toBe(rows.rows[0]!.q);
    expect(demo.metrics.calls.missed).toBe(rows.rows[0]!.m);
    expect(demo.metrics.cost.actualInr).toBe(7.5);
    const prod = await (await metricsGET(get("/api/metrics?scope=production"))).json();
    expect(prod.metrics.calls.total).toBe(0);
    expect(prod.metrics.cost.unknownCount).toBe(0);
  });
  it("list API: filters, pagination and search work", async () => {
    await signIn("viewer@t.test");
    const q = await (await enquiriesGET(get("/api/enquiries?scope=demo&disposition=QUALIFIED"))).json();
    expect(q.items.every((i: { disposition: string }) => i.disposition === "QUALIFIED")).toBe(true);
    const page = await (await enquiriesGET(get("/api/enquiries?scope=demo&pageSize=2&page=2"))).json();
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page.pageSize).toBe(2);
    expect(page.page).toBe(2);
    const byRef = await (await enquiriesGET(get("/api/enquiries?scope=demo&q=AGN-0000"))).json();
    expect(byRef.total).toBeGreaterThan(0);
    const none = await (await enquiriesGET(get("/api/enquiries?scope=demo&q=zzzz-no-such"))).json();
    expect(none.items).toEqual([]);
    const sqli = await enquiriesGET(get("/api/enquiries?scope=demo&q=" + encodeURIComponent("'; drop table enquiries;--")));
    expect(sqli.status).toBe(200);
    expect((await handle.db.execute(sql`select count(*)::int n from enquiries`)).rows[0]!.n).toBeGreaterThan(0);
  });
  it("transcripts are restricted: viewer sees none, operator sees the conversation", async () => {
    await signIn("viewer@t.test");
    const v = await (await enquiryRoute.GET(get(`/api/enquiries/${enquiryId}`), ctx(enquiryId))).json();
    expect(v.transcript).toBeNull();
    expect(v.transcriptAvailable).toBe(true);
    await signIn("op@t.test");
    const o = await (await enquiryRoute.GET(get(`/api/enquiries/${enquiryId}`), ctx(enquiryId))).json();
    expect(Array.isArray(o.transcript)).toBe(true);
    expect(o.assessments[0].criteria).toHaveLength(5);
  });
  it("detail endpoint: 404 for unknown / malformed ids", async () => {
    await signIn("op@t.test");
    expect((await enquiryRoute.GET(get("/api/enquiries/not-a-uuid"), ctx("not-a-uuid"))).status).toBe(404);
    const missing = "11111111-1111-4111-8111-111111111111";
    expect((await enquiryRoute.GET(get(`/api/enquiries/${missing}`), ctx(missing))).status).toBe(404);
  });
  it("mutations: role checks, validation, audit, and an unconfirmed consultation is never shown as booked", async () => {
    await signIn("viewer@t.test");
    expect((await enquiryRoute.PATCH(patch(`/api/enquiries/${enquiryId}`, { consultationStatus: "confirmed" }), ctx(enquiryId))).status).toBe(403);
    await signIn("op@t.test");
    const p = (b: unknown, h: Record<string, string> = {}) => enquiryRoute.PATCH(patch(`/api/enquiries/${enquiryId}`, b, h), ctx(enquiryId));
    expect((await p({ disposition: "DECLINED" })).status).toBe(400); // reason required
    expect((await p({ projectValueInr: 500000 })).status).toBe(400); // only with converted
    expect((await p({ nonsense: true })).status).toBe(400); // strict schema
    expect((await p({ conversionStatus: "bogus" })).status).toBe(400);
    expect((await p({ consultationStatus: "confirmed" }, { origin: "https://evil.example", host: "localhost:3100" })).status).toBe(403);
    const ok = await p({ consultationStatus: "requested" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).consultationStatus).toBe("requested");
    const conv = await p({ conversionStatus: "converted", projectValueInr: 900000 });
    expect(conv.status).toBe(200);
    const dispo = await p({ disposition: "HUMAN_REVIEW", reason: "Needs a second look" });
    expect((await dispo.json()).disposition).toBe("HUMAN_REVIEW");
    const audit = await handle.db.execute(sql`select action, actor from audit_events where entity_id = ${enquiryId} and action like '%manually' order by at`);
    expect(audit.rows.map((r: { action: unknown }) => r.action)).toEqual(["enquiry.updated_manually", "enquiry.updated_manually", "disposition.changed_manually"]);
    expect(audit.rows.every((r: { actor: unknown }) => r.actor === "op@t.test")).toBe(true);
    const m = await (await metricsGET(get("/api/metrics?scope=demo"))).json();
    expect(m.metrics.outcomes).toMatchObject({ converted: 1, revenueInfluencedInr: 900000 });
  });
  it("retry endpoint refuses notifications that are not failed/unavailable", async () => {
    await signIn("op@t.test");
    const row = (await handle.db.execute(sql`select id from notifications limit 1`)).rows[0]!;
    expect((await retry(post(`/api/notifications/${row.id}/retry`, {}), ctx(String(row.id)))).status).toBe(409);
    expect((await retry(post("/api/notifications/zzz/retry", {}), ctx("zzz"))).status).toBe(404);
  });
});

describe("cost rate settings (admin only)", () => {
  const put = (b: unknown) => ratesRoute.PUT(new Request(BASE + "/api/settings/cost-rates", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  it("operators cannot change rates; admins can; a rate needs a source", async () => {
    await signIn("op@t.test");
    expect((await put({ voicePerMinuteInr: 5, source: "invoice 42" })).status).toBe(403);
    await signIn("admin@t.test");
    expect((await put({ voicePerMinuteInr: 5 })).status).toBe(400);
    expect((await put({ voicePerMinuteInr: -1, source: "invoice 42" })).status).toBe(400);
    expect((await put({ voicePerMinuteInr: 5, source: "Test invoice 42 (fixture)" })).status).toBe(200);
    expect((await (await ratesRoute.GET(get("/api/settings/cost-rates"))).json()).rates.source).toBe("Test invoice 42 (fixture)");
    expect((await put({})).status).toBe(200); // cleared → costs revert to unknown
    const a = await handle.db.execute(sql`select count(*)::int n from audit_events where action = 'settings.updated'`);
    expect(a.rows[0]!.n).toBe(2);
  });
});

describe("webhook endpoint", () => {
  const event = (id: string, type = "call.started") => JSON.stringify({ eventId: id, type, providerCallId: `wh-${id}`, occurredAt: "2026-10-01T05:00:00.000Z", fromNumber: "+919900099999" });
  const signed = (b: string, ts = Date.now()) => new Request(BASE + "/api/webhooks/voice", { method: "POST", body: b, headers: { [MOCK_TIMESTAMP_HEADER]: String(ts), [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, ts, b) } });

  it("accepts a signed event, treats a replay as duplicate, rejects tampering", async () => {
    const b = event("a1");
    expect(await (await webhook(signed(b))).json()).toMatchObject({ status: "processed" });
    expect(await (await webhook(signed(b))).json()).toMatchObject({ status: "duplicate" });
    const tampered = signed(b.replace("a1", "a2"));
    const t = new Request(BASE + "/api/webhooks/voice", { method: "POST", body: b.replace("a1", "a2"), headers: { [MOCK_TIMESTAMP_HEADER]: tampered.headers.get(MOCK_TIMESTAMP_HEADER)!, [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, Number(tampered.headers.get(MOCK_TIMESTAMP_HEADER)), b) } });
    expect((await webhook(t)).status).toBe(401);
    expect((await webhook(new Request(BASE + "/api/webhooks/voice", { method: "POST", body: b }))).status).toBe(401);
    expect((await webhook(signed("{malformed"))).status).toBe(400);
  });
  it("webhook responses never echo payload content", async () => {
    const r = await webhook(signed(JSON.stringify({ type: "call.started", secretNote: "PRIVATE-CONTENT" })));
    expect(JSON.stringify(await r.json())).not.toContain("PRIVATE-CONTENT");
  });
  it("health is public and reveals no secrets or customer data", async () => {
    const r = await health(get("/api/health"));
    const text = JSON.stringify(await r.json());
    expect(r.status).toBe(200);
    expect(text).not.toMatch(/SESSION|secret|token|\+91/i);
  });
  it("database connection loss → 503 (so the provider retries) and the app keeps responding", async () => {
    const b = event("db-down");
    await handle.close();
    const r = await webhook(signed(b));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("database_unavailable");
    const h = await health(get("/api/health"));
    expect(h.status).toBe(503);
    handle = await testDb(); // recover for any later tests
  });
});

describe("open access mode (AUTH_MODE=open, explicit opt-in)", () => {
  async function withMode(mode: Record<string, string>, fn: () => Promise<void>) {
    const { resetConfigForTests } = await import("@/lib/config");
    const prev = { AUTH_MODE: process.env.AUTH_MODE, OPEN_ACCESS_ROLE: process.env.OPEN_ACCESS_ROLE };
    Object.assign(process.env, mode);
    resetConfigForTests();
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      resetConfigForTests();
    }
  }

  it("default role is read-only: data is visible without signing in, but nothing can be operated, edited or called", async () => {
    await withMode({ AUTH_MODE: "open" }, async () => {
      jar.clear();
      expect((await enquiriesGET(get("/api/enquiries?scope=demo"))).status).toBe(200);
      expect((await metricsGET(get("/api/metrics?scope=demo"))).status).toBe(200);
      const id = (await (await enquiriesGET(get("/api/enquiries?scope=demo"))).json()).items[0]?.id;
      if (id) expect((await (await enquiryRoute.GET(get(`/api/enquiries/${id}`), ctx(id))).json()).transcript).toBeNull();
      expect((await enquiryRoute.PATCH(patch(`/api/enquiries/${id ?? "x"}`, { consultationStatus: "confirmed" }), ctx(id ?? "x"))).status).toBe(403);
      expect((await simulate(post("/api/simulate", { scenarioId: "T01" }))).status).toBe(403);
      expect((await ratesRoute.PUT(new Request(BASE + "/api/settings/cost-rates", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
    });
  });
  it("the role can be raised explicitly", async () => {
    await withMode({ AUTH_MODE: "open", OPEN_ACCESS_ROLE: "operator" }, async () => {
      jar.clear();
      expect((await simulate(post("/api/simulate", { scenarioId: "T03" }))).status).toBe(201);
    });
  });
  it("importing a call is allowed for the read-only role (it only reads from Vaani); placing a call is not", async () => {
    await withMode({ AUTH_MODE: "open" }, async () => {
      jar.clear();
      const sync = (await import("@/app/api/calls/sync/route")).POST;
      const outbound = (await import("@/app/api/calls/outbound/route")).POST;
      expect((await sync(post("/api/calls/sync", { callId: "outbound-123456-abcdef" }))).status).toBe(409); // permitted, but Vaani is not configured in tests
      expect((await outbound(post("/api/calls/outbound", { contactNumber: "+919876543210", name: "x", consent: true }))).status).toBe(403);
    });
  });
  it("login mode (the default) is unaffected", async () => {
    jar.clear();
    expect((await enquiriesGET(get("/api/enquiries"))).status).toBe(401);
  });
  it("the webhook is NOT opened up: it still needs its signature/token", async () => {
    await withMode({ AUTH_MODE: "open" }, async () => {
      expect((await webhook(new Request(BASE + "/api/webhooks/voice", { method: "POST", body: "{}" }))).status).toBe(401);
    });
  });
});
