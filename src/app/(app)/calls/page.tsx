import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { CallsPanel } from "@/components/calls-panel";
import { Badge } from "@/components/ui";
import { can } from "@/modules/authentication";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const user = await requireUser("import");
  const c = getConfig();
  if (c.mode !== "live") redirect("/simulator");
  return (
    <>
      <div className="page-head"><div><h1>Vaani calls</h1>
        <p>Bring calls from Vaani into the dashboard{can(user.role, "operate") ? " and place a real test call" : ""}. Calls also arrive on their own once the webhook is registered in Vaani.</p></div></div>
      <div className="row" style={{ marginBottom: 14, gap: 8 }}>
        <Badge tone={c.VAANI_API_KEY ? "ok" : "bad"} icon={c.VAANI_API_KEY ? "✓" : "✕"}>API key {c.VAANI_API_KEY ? "set" : "missing"}</Badge>
        <Badge tone={c.VAANI_AGENT_ID ? "ok" : "warn"} icon={c.VAANI_AGENT_ID ? "✓" : "!"}>Agent {c.VAANI_AGENT_ID ? "configured" : "not configured"}</Badge>
        <Badge tone={c.VAANI_WEBHOOK_TOKEN ? "ok" : "warn"} icon={c.VAANI_WEBHOOK_TOKEN ? "✓" : "!"}>Webhook token {c.VAANI_WEBHOOK_TOKEN ? "set" : "missing"}</Badge>
      </div>
      <CallsPanel agentConfigured={Boolean(c.VAANI_AGENT_ID)} canCall={can(user.role, "operate")} />
    </>
  );
}
