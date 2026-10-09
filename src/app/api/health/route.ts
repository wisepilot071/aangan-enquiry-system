import { getDbHandle } from "@/db/client";
import { json, safe } from "@/lib/http";
import { getHealth } from "@/modules/health";

export const dynamic = "force-dynamic";

export const GET = safe(async () => {
  let handle = null;
  try { handle = await getDbHandle(); } catch { /* reported as database down */ }
  const report = await getHealth(handle);
  return json(report, report.status === "down" ? 503 : 200);
});
