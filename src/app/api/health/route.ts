import { getDbHandle } from "@/db/client";
import { ConfigError } from "@/lib/config";
import { json, safe } from "@/lib/http";
import { getHealth } from "@/modules/health";

export const dynamic = "force-dynamic";

export const GET = safe(async () => {
  try {
    return await report();
  } catch (e) {
    // A misconfigured deployment must say so (variable names only — never values) instead of a bare 500.
    if (e instanceof ConfigError) return json({ status: "down", error: "configuration_invalid", detail: e.message.slice(0, 200) }, 503);
    throw e;
  }
});

async function report() {
  let handle = null;
  try { handle = await getDbHandle(); } catch { /* reported as database down */ }
  const health = await getHealth(handle);
  return json(health, health.status === "down" ? 503 : 200);
}
