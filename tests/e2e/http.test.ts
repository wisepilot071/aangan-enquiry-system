/**
 * True end-to-end: boots the real Next.js server (dev mode, embedded Postgres in a temp dir) and drives it over HTTP.
 * Covers: auth gate → login → simulated call → qualification → stored record → Telegram preview → dashboard metrics,
 * plus a signed webhook and the pages' server-rendered content.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHandle } from "@/db/client";
import { users } from "@/db/schema";
import { hashPassword } from "@/modules/authentication";
import { signMockPayload, MOCK_SIGNATURE_HEADER, MOCK_TIMESTAMP_HEADER } from "@/modules/voice-provider/mock";

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "e2e-password-12345";
const MOCK_SECRET = "e2e-mock-secret-0123456789";
let proc: ChildProcess;
let dir: string;
let cookie = "";
let log = "";

async function waitForReady(timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${log.slice(-1500)}`);
}
const api = (p: string, init: RequestInit = {}) => fetch(BASE + p, { redirect: "manual", ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });
const postJson = (p: string, body: unknown) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aangan-e2e-"));
  const seed = createPgliteHandle(path.join(dir, "db"));
  await seed.migrate();
  await seed.db.insert(users).values({ email: "e2e@aangan.test", passwordHash: hashPassword(PW), role: "admin" });
  await seed.close();

  const env = { ...process.env, NODE_ENV: "development", PGLITE_DATA_DIR: path.join(dir, "db"), DATABASE_URL: "", VOICE_PROVIDER: "mock",
    SESSION_SECRET: "e".repeat(48), MOCK_WEBHOOK_SECRET: MOCK_SECRET, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-e2e" } as NodeJS.ProcessEnv;
  proc = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.on("data", (d) => { log += d; });
  proc.stderr?.on("data", (d) => { log += d; });
  await waitForReady(120_000);
}, 180_000);

afterAll(async () => {
  if (proc?.pid) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    else proc.kill("SIGTERM");
  }
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("end-to-end over HTTP", () => {
  it("private pages and APIs are protected", async () => {
    const page = await fetch(`${BASE}/enquiries`, { redirect: "manual" });
    expect([302, 307]).toContain(page.status);
    expect(page.headers.get("location")).toContain("/login");
    expect((await fetch(`${BASE}/api/enquiries`)).status).toBe(401);
    expect((await fetch(`${BASE}/login`)).status).toBe(200);
  }, 120_000);

  it("health endpoint reports mock mode honestly", async () => {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    expect(h).toMatchObject({ mode: "mock", checks: { database: { ok: true }, voiceProvider: { provider: "mock", state: "ready" }, telegram: { configured: false } } });
  });

  it("login sets an HttpOnly session cookie", async () => {
    const bad = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "e2e@aangan.test", password: "wrong-password-1" }) });
    expect(bad.status).toBe(401);
    const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "e2e@aangan.test", password: PW }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/aangan_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    cookie = setCookie.split(";")[0]!;
  });

  it("dashboard shows the mock-mode banner and an honest empty state", async () => {
    const html = await (await api("/")).text();
    expect(html).toContain("MOCK MODE");
    expect(html).toContain("No calls in this period");
    expect(html).toContain("Not yet recorded"); // conversion is never invented
  }, 120_000);

  let qualifiedId = "";
  it("simulated qualified call → stored, qualified, Telegram preview marked as simulated", async () => {
    const r = await postJson("/api/simulate", { scenarioId: "T06", providerCostInr: 9 });
    expect(r.status).toBe(201);
    const d = await r.json();
    expect(d.disposition).toBe("QUALIFIED");
    expect(d.notifications[0]).toMatchObject({ category: "qualified_handoff", status: "mock_sent" });
    expect(d.notifications[0].preview).toContain("DEMO / MOCK");
    qualifiedId = d.enquiryId;
  });

  it("unqualified call is stored but not handed to a designer; complaint escalates urgently; missed call creates a task", async () => {
    const closed = await (await postJson("/api/simulate", { scenarioId: "T03" })).json();
    expect(closed.disposition).toBe("CLOSED_NOT_FORWARDED");
    expect(closed.notifications.map((n: { category: string }) => n.category)).toEqual(["call_update"]);
    const esc = await (await postJson("/api/simulate", { scenarioId: "T09" })).json();
    expect(esc.disposition).toBe("ESCALATED");
    expect(esc.notifications.map((n: { category: string }) => n.category)).toEqual(["urgent_escalation"]);
    const missed = await (await postJson("/api/simulate", { outcome: "missed" })).json();
    expect(missed).toMatchObject({ callStatus: "missed", disposition: null, transcript: [] });
  });

  it("pricing question in a live conversation gets exactly the approved sentence and no number", async () => {
    const d = await (await postJson("/api/simulate", { callerLines: [{ text: "How much for a 2BHK full redesign in Baner? Just give me a rough range." }, { text: "Please, even a ballpark per sq ft." }] })).json();
    const agent = d.transcript.filter((t: { role: string }) => t.role === "agent").map((t: { text: string }) => t.text);
    const approved = "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";
    expect(agent.filter((t: string) => t === approved).length).toBeGreaterThanOrEqual(2);
    expect(agent.join(" ")).not.toMatch(/₹|lakh|per sq ?ft|\d{3,}/i);
  });

  it("dashboard figures match the records: metrics API, overview page and detail page agree", async () => {
    const m = await (await api("/api/metrics?scope=demo")).json();
    expect(m.metrics.calls).toMatchObject({ total: 5, missed: 1 });
    expect(m.metrics.qualification).toMatchObject({ qualified: 1, unqualified: 1, urgent: 1 });
    expect(m.metrics.cost.actualInr).toBe(9);
    expect(m.metrics.cost.unknownCount).toBe(3);
    const prod = await (await api("/api/metrics?scope=production")).json();
    expect(prod.metrics.calls.total).toBe(0);

    const overview = await (await api("/?scope=demo")).text();
    expect(overview).toContain("Incoming calls");
    expect(overview).toContain("Not yet recorded");
    const detail = await (await api(`/enquiries/${qualifiedId}?scope=demo`)).text();
    expect(detail).toContain("SIMULATED — not delivered");
    expect(detail).toContain("Good lead — hand to a designer");
    expect(detail).toContain("The rules, in detail");
    const urgent = await (await api("/urgent?scope=demo")).text();
    expect(urgent).toContain("Existing-client complaint");
    expect(urgent).toContain("Missed call");
  }, 120_000);

  it("signed webhook over HTTP is accepted once; replay and forgery are not processed", async () => {
    const body = JSON.stringify({ eventId: "e2e-1", type: "call.missed", providerCallId: "e2e-call-1", occurredAt: new Date().toISOString(), fromNumber: "+919900012345" });
    const ts = Date.now();
    const headers = { [MOCK_TIMESTAMP_HEADER]: String(ts), [MOCK_SIGNATURE_HEADER]: signMockPayload(MOCK_SECRET, ts, body) };
    expect((await (await fetch(`${BASE}/api/webhooks/voice`, { method: "POST", body, headers })).json()).status).toBe("processed");
    expect((await (await fetch(`${BASE}/api/webhooks/voice`, { method: "POST", body, headers })).json()).status).toBe("duplicate");
    expect((await fetch(`${BASE}/api/webhooks/voice`, { method: "POST", body, headers: { ...headers, [MOCK_SIGNATURE_HEADER]: "0".repeat(64) } })).status).toBe(401);
  });

  it("system page states plainly that Vaani is not selected in mock mode", async () => {
    const html = await (await api("/system")).text();
    expect(html).toContain("Not selected (mock mode)");
    expect(html).toContain("Vaani");
  }, 120_000);
});
