import { getDbHandle } from "@/db/client";
import { requireUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { Badge } from "@/components/ui";
import { getHealth } from "@/modules/health";
import { getVoiceProvider } from "@/modules/voice-provider";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  await requireUser("view");
  const cfg = getConfig();
  const health = await getHealth(await getDbHandle().catch(() => null));
  const p = getVoiceProvider().status();
  const rows: { name: string; status: string; tone: "ok" | "warn" | "bad" | "demo" | "neutral"; detail: string }[] = [
    { name: "Application mode", status: cfg.mode === "mock" ? "MOCK" : "LIVE", tone: cfg.mode === "mock" ? "demo" : "ok", detail: cfg.mode === "mock" ? "Simulated calls only. Not connected to any telephony provider." : "Processing real provider events." },
    { name: "Access control", status: cfg.AUTH_MODE === "open" ? `OPEN — no sign-in (${cfg.OPEN_ACCESS_ROLE})` : "Email + password sign-in", tone: cfg.AUTH_MODE === "open" ? "warn" : "ok", detail: cfg.AUTH_MODE === "open" ? "Anyone with the URL can see enquiries, names and phone numbers. Set AUTH_MODE=login to require sign-in again." : "Roles: viewer / operator / admin, enforced server-side." },
    { name: "Database", status: health.checks.database.ok ? `Connected (${health.checks.database.kind})` : "Unavailable", tone: health.checks.database.ok ? "ok" : "bad",
      detail: health.checks.database.kind === "pglite" ? "Embedded PGlite in ./data — fine for demos; set DATABASE_URL (PostgreSQL) for production." : "PostgreSQL via DATABASE_URL." },
    { name: "Voice provider: " + p.provider, status: p.state.replace(/_/g, " "), tone: p.state === "ready" ? (p.mode === "mock" ? "demo" : "ok") : "warn", detail: p.detail },
    cfg.VOICE_PROVIDER === "vaani"
      ? { name: "Vaani AI", status: cfg.vaaniConfigured && cfg.VAANI_AGENT_ID ? "Configured — untested on a real inbound call" : "Incomplete configuration", tone: cfg.vaaniConfigured && cfg.VAANI_AGENT_ID ? "warn" : "bad",
          detail: `API key ${cfg.VAANI_API_KEY ? "set" : "MISSING"} · agent ${cfg.VAANI_AGENT_ID ? "set" : "NOT SET (npm run vaani:setup)"} · webhook token ${cfg.VAANI_WEBHOOK_TOKEN ? "set" : "MISSING"}. A phone number must be linked to the agent in the Vaani dashboard (Settings → Telephony) and the webhook URL registered (Settings → Webhooks); neither can be checked through the API.` }
      : { name: "Vaani AI", status: "Not selected (mock mode)", tone: "neutral", detail: "Set VOICE_PROVIDER=vaani with VAANI_API_KEY to use the real provider. See docs/vaani-integration.md." },
    { name: "Telegram handoff", status: cfg.telegramConfigured ? "Configured (untested until first real send)" : "Not configured", tone: cfg.telegramConfigured ? "ok" : "warn",
      detail: cfg.telegramConfigured ? "Real qualified-lead and escalation messages will be sent. Demo calls are never sent." : "Real enquiries will be recorded as 'unavailable' and a follow-up task opened. Demo calls show simulated previews." },
    cfg.VOICE_PROVIDER === "vaani"
      ? { name: "Webhook authentication", status: cfg.VAANI_WEBHOOK_TOKEN ? "Secret URL token (fail closed)" : "No token configured — all webhooks rejected", tone: cfg.VAANI_WEBHOOK_TOKEN ? "ok" : "bad", detail: "Vaani documents no webhook signature, so a long random token in the webhook URL is required; finished-call data is also re-fetched from Vaani's authenticated API. Rejected requests are recorded without their content." }
      : { name: "Webhook signature", status: p.capabilities.webhookSignature ? "Enforced (fail closed)" : "No secret configured", tone: p.capabilities.webhookSignature ? "ok" : "warn", detail: "Unsigned or mis-signed webhooks are rejected and recorded without storing their content." },
  ];

  return (
    <>
      <div className="page-head"><div><h1>System status</h1><p>What is connected, what is simulated, and what still needs account setup. Nothing is reported as working unless it has been tested.</p></div></div>
      <div className="table-wrap"><table><caption className="sr-only">Integration status</caption><thead><tr><th>Component</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.name}><td><b>{r.name}</b></td><td><Badge tone={r.tone}>{r.status}</Badge></td><td>{r.detail}</td></tr>)}
      </tbody></table></div>
      {cfg.warnings.length ? <section className="section"><h2>Configuration warnings</h2><ul>{cfg.warnings.map((w) => <li key={w}>{w}</li>)}</ul></section> : null}
      <section className="section"><h2>Known limitations</h2>
        <ul>
          <li>Response-time metrics are only as reliable as the timestamps the real provider supplies; none have been observed yet.</li>
          <li>Live transfer to a human is not configured: callers are told the truth (a person will follow up) and a tracked task is created.</li>
          <li>No appointment booking is integrated: a consultation is only ever &quot;requested&quot; until a person confirms it.</li>
          <li>Call recording is not enabled.</li>
        </ul>
      </section>
    </>
  );
}
