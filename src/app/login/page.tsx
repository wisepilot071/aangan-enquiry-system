"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
    });
    setBusy(false);
    if (res.ok) { router.push("/"); router.refresh(); return; }
    setError(res.status === 429 ? "Too many attempts. Please wait a few minutes and try again." : res.status === 401 ? "Email or password is incorrect." : "Sign-in is unavailable right now. Please try again.");
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit} aria-labelledby="t">
        <div className="brand"><div className="brand-mark" aria-hidden="true">A</div><div><b>Aangan Studio</b><span>Enquiry console</span></div></div>
        <h1 id="t" style={{ fontSize: "1.3rem" }}>Sign in</h1>
        <label>Email<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <button className="btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted small">Access is limited to authorised Aangan Studio staff.</p>
      </form>
    </main>
  );
}
