import { Suspense, type ReactNode } from "react";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { enquiries, followUpTasks } from "@/db/schema";
import { requireUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { LogoutButton, NavLinks, ScopeToggle, type NavItem } from "@/components/nav";
import { getVoiceProvider } from "@/modules/voice-provider";
import { can } from "@/modules/authentication";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("view");
  const cfg = getConfig();
  const provider = getVoiceProvider().status();
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(followUpTasks)
    .innerJoin(enquiries, eq(enquiries.id, followUpTasks.enquiryId))
    .where(and(eq(followUpTasks.status, "open"), eq(enquiries.isDemo, cfg.mode === "mock")));

  const items: NavItem[] = [
    { href: "/", label: "Overview", icon: "◧" },
    { href: "/enquiries", label: "Enquiries", icon: "☰" },
    { href: "/urgent", label: "Urgent queue", icon: "▲", count: n },
    { href: "/costs", label: "Costs", icon: "₹" },
    ...(cfg.mode === "mock" && can(user.role, "operate") ? [{ href: "/simulator", label: "Call simulator", icon: "☏" }] : []),
    ...(cfg.mode === "live" && can(user.role, "operate") ? [{ href: "/calls", label: "Vaani calls", icon: "☏" }] : []),
    { href: "/system", label: "System status", icon: "⚙" },
  ];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><div className="brand-mark" aria-hidden="true">A</div><div><b>Aangan Studio</b><span>Enquiry console</span></div></div>
        <Suspense fallback={null}><NavLinks items={items} /></Suspense>
        <div className="side-foot">
          <Suspense fallback={null}><ScopeToggle current={cfg.mode === "mock" ? "demo" : "production"} available={true} /></Suspense>
          {cfg.AUTH_MODE === "open" ? <span>Open access<br />Role: {user.role}</span> : <><span>{user.email}<br />Role: {user.role}</span><LogoutButton /></>}
        </div>
      </aside>
      <main className="main" id="main">
        {cfg.mode === "mock" ? (
          <div className="banner mock" role="status">
            <b>◈ MOCK MODE</b>
            <span>No real telephony or Vaani connection. Calls here are simulated and labelled DEMO; Telegram messages are previews only and are never delivered. Demo data is excluded from production reporting.</span>
          </div>
        ) : null}
        {cfg.AUTH_MODE === "open" ? (
          <div className="banner warn" role="status"><b>⚠ Open access</b><span>There is no sign-in on this site: anyone with the link can view caller details{user.role === "viewer" ? " (read-only; transcripts, calls and settings are locked)" : " and operate it"}.</span></div>
        ) : null}
        {provider.state !== "ready" ? (
          <div className="banner warn" role="status"><b>⚠ Voice provider: {provider.state.replace(/_/g, " ")}</b><span>{provider.detail}</span></div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
