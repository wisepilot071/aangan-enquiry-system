"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface NavItem { href: string; label: string; icon: string; count?: number }

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const sp = useSearchParams();
  const scope = sp.get("scope");
  return (
    <nav className="nav" aria-label="Main">
      {items.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        const href = scope && ["/", "/enquiries", "/urgent", "/costs"].includes(i.href) ? `${i.href}?scope=${scope}` : i.href;
        return (
          <Link key={i.href} href={href} aria-current={active ? "page" : undefined}>
            <span aria-hidden="true">{i.icon}</span> {i.label}
            {i.count ? <span className="count" aria-label={`${i.count} open`}>{i.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function ScopeToggle({ current, available }: { current: "demo" | "production"; available: boolean }) {
  const path = usePathname();
  const sp = useSearchParams();
  const link = (s: string) => {
    const p = new URLSearchParams(sp.toString());
    p.set("scope", s);
    p.delete("page");
    return `${path}?${p.toString()}`;
  };
  if (!available) return null;
  return (
    <div role="group" aria-label="Data scope" className="row small" style={{ gap: 6 }}>
      <Link className={`btn small${current === "demo" ? "" : " secondary"}`} href={link("demo")} aria-pressed={current === "demo"}>Demo data</Link>
      <Link className={`btn small${current === "production" ? "" : " secondary"}`} href={link("production")} aria-pressed={current === "production"}>Production</Link>
    </div>
  );
}

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn secondary small" disabled={busy} onClick={async () => {
      setBusy(true);
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    }}>Sign out</button>
  );
}
