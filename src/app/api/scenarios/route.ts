import { apiUser } from "@/lib/auth-server";
import { json, safe } from "@/lib/http";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";

export const dynamic = "force-dynamic";

export const GET = safe(async (req: Request) => {
  const a = await apiUser(req, "view");
  if ("error" in a) return a.error;
  return json({ scenarios: PHONE_SCENARIOS.map((s) => ({ id: s.id, title: s.title, date: s.date, expected: s.expected.disposition })) });
});
