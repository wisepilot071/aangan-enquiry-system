import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { CallsPanel } from "@/components/calls-panel";
import { Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  await requireUser("operate");
  const c = getConfig();
  if (c.mode !== "live") redirect("/simulator");
  return (
    <>
      <div className="page-head"><div><h1>Vaani calls</h1>
        <p>Place a real test call through Vaani and import finished calls. Incoming calls arrive on their own through the webhook once a number is linked to the agent.</p></div></div>
      <div className="row" style={{ marginBottom: 14, gap: 8 }}>
        <Badge tone={c.VAANI_API_KEY ? "ok" : "bad"} icon={c.VAANI_API_KEY ? "✓" : "✕"}>API key {c.VAANI_API_KEY ? "set" : "missing"}</Badge>
        <Badge tone={c.VAANI_AGENT_ID ? "ok" : "warn"} icon={c.VAANI_AGENT_ID ? "✓" : "!"}>Agent {c.VAANI_AGENT_ID ? "configured" : "not configured"}</Badge>
        <Badge tone={c.VAANI_WEBHOOK_TOKEN ? "ok" : "warn"} icon={c.VAANI_WEBHOOK_TOKEN ? "✓" : "!"}>Webhook token {c.VAANI_WEBHOOK_TOKEN ? "set" : "missing"}</Badge>
      </div>
      <CallsPanel agentConfigured={Boolean(c.VAANI_AGENT_ID)} />
    </>
  );
}
