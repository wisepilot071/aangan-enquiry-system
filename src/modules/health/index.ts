import type { DbHandle } from "@/db/client";
import { getConfig } from "@/lib/config";
import { getVoiceProvider } from "@/modules/voice-provider";

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  mode: "mock" | "live";
  checks: {
    database: { ok: boolean; kind?: string; detail?: string };
    voiceProvider: { provider: string; state: string; detail: string };
    telegram: { configured: boolean };
  };
  warnings: string[];
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** Public-safe: no customer data, no secrets, no hostnames. */
export async function getHealth(handle: DbHandle | null): Promise<HealthReport> {
  const c = getConfig();
  const p = getVoiceProvider().status();
  let db: HealthReport["checks"]["database"] = { ok: false, detail: "not initialised" };
  if (handle) {
    try { await withTimeout(handle.ping(), 2000); db = { ok: true, kind: handle.kind }; }
    catch (e) { db = { ok: false, kind: handle.kind, detail: e instanceof Error && e.message === "timeout" ? "timeout" : "unreachable" }; }
  }
  const status: HealthReport["status"] = !db.ok ? "down" : p.state !== "ready" || !c.telegramConfigured ? "degraded" : "ok";
  return { status, mode: c.mode, checks: { database: db, voiceProvider: { provider: p.provider, state: p.state, detail: p.detail }, telegram: { configured: c.telegramConfigured } }, warnings: c.warnings };
}
