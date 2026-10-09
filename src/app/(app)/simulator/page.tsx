import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { Simulator } from "@/components/simulator";
import { PHONE_SCENARIOS } from "@/modules/demo/phone-scenarios";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  await requireUser("operate");
  if (getConfig().mode !== "mock") redirect("/");
  return (
    <>
      <div className="page-head"><div><h1>Call simulator</h1>
        <p>Walk a simulated incoming call through the real pipeline: conversation → qualification rules → stored record → Telegram preview → dashboard metrics. Available in mock mode only.</p></div></div>
      <Simulator scenarios={PHONE_SCENARIOS.map((s) => ({ id: s.id, title: s.title, expected: s.expected.disposition }))} />
    </>
  );
}
