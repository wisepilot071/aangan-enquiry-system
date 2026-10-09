import fs from "node:fs";
import path from "node:path";
import { createVaaniClient, VaaniApiError } from "../src/modules/voice-provider/vaani-client";
import { AGENT_DISPLAY_NAME, buildAgentConfig, buildAnalysisPatch, buildExperiencePatch } from "../src/modules/voice-provider/vaani-agent-config";

/**
 * Creates (or updates) the Aangan enquiry agent inside the Vaani account behind VAANI_API_KEY.
 *   npm run vaani:setup            create if missing, otherwise update persona / analysis / experience
 * Idempotent. Writes VAANI_AGENT_ID into ./.env when that file exists. Never prints the API key.
 */
async function main() {
  const apiKey = process.env.VAANI_API_KEY;
  if (!apiKey) throw new Error("VAANI_API_KEY is not set (put it in .env).");
  const client = createVaaniClient({ apiKey, baseUrl: process.env.VAANI_API_BASE || undefined });

  const raw = await client.listAgents();
  const agents = (Array.isArray(raw) ? raw : raw.data) as { id: string; display_name?: string; agent_name?: string }[];
  const existing = agents.find((a) => a.id === process.env.VAANI_AGENT_ID) ?? agents.find((a) => a.display_name === AGENT_DISPLAY_NAME);

  let agentId: string;
  if (existing) {
    agentId = existing.id;
    console.log(`Updating existing agent ${agentId}`);
    const p = await client.patchAgent(agentId, "persona", buildAgentConfig().persona);
    report("persona", p.warnings);
  } else {
    const created = await client.createAgent(AGENT_DISPLAY_NAME, buildAgentConfig());
    if (created.success === false || !created.agent_id) throw new Error("Vaani did not return an agent id.");
    agentId = created.agent_id;
    console.log(`Created agent ${agentId} ("${created.agent_display_name ?? created.agent_name ?? AGENT_DISPLAY_NAME}")`);
  }
  report("analysis", (await client.patchAgent(agentId, "analysis", buildAnalysisPatch())).warnings);
  report("experience", (await client.patchAgent(agentId, "experience", buildExperiencePatch())).warnings);

  const envFile = path.join(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    let txt = fs.readFileSync(envFile, "utf8");
    txt = /^VAANI_AGENT_ID=.*$/m.test(txt) ? txt.replace(/^VAANI_AGENT_ID=.*$/m, `VAANI_AGENT_ID=${agentId}`) : `${txt.replace(/\n*$/, "\n")}VAANI_AGENT_ID=${agentId}\n`;
    fs.writeFileSync(envFile, txt);
    console.log("Saved VAANI_AGENT_ID to .env");
  }
  console.log(`\nAgent id: ${agentId}\nNext (dashboard only — not available through the API):\n  1. Settings → Telephony: provision or connect a phone number and link it to this agent\n  2. Settings → Webhooks: add  https://<your-app>/api/webhooks/voice?token=<VAANI_WEBHOOK_TOKEN>`);
}

function report(section: string, warnings: unknown) {
  const w = Array.isArray(warnings) ? warnings : [];
  console.log(`  ${section}: ok${w.length ? ` — Vaani warnings: ${JSON.stringify(w).slice(0, 400)}` : ""}`);
}

main().catch((e) => {
  console.error(e instanceof VaaniApiError ? `${e.message} (${e.category})` : e instanceof Error ? e.message : e);
  process.exit(1);
});
