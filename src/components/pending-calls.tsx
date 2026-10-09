"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Shown only while calls are waiting for Vaani to finish preparing their transcript. Asks the server to fetch them every 30 s
 * and refreshes the page the moment one arrives, so nobody has to import anything by hand.
 */
export function PendingCalls({ count }: { count: number }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; note: string }>({ busy: false, note: "" });
  const running = useRef(false);

  useEffect(() => {
    if (count <= 0) return;
    let stop = false;
    async function tick() {
      if (running.current || stop) return;
      running.current = true;
      setState({ busy: true, note: "" });
      try {
        const res = await fetch("/api/calls/refresh", { method: "POST" });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.imported > 0) { router.refresh(); setState({ busy: false, note: "New call received" }); }
        else setState({ busy: false, note: res.ok ? "" : "Could not reach Vaani" });
      } catch { setState({ busy: false, note: "Could not reach Vaani" }); }
      finally { running.current = false; }
    }
    const first = setTimeout(tick, 2000);
    const every = setInterval(tick, 30_000);
    return () => { stop = true; clearTimeout(first); clearInterval(every); };
  }, [count, router]);

  if (count <= 0) return null;
  return (
    <div className="pending" role="status" aria-live="polite">
      <span className={state.busy ? "dot spin" : "dot"} aria-hidden="true" />
      <span><b>{count} call{count === 1 ? "" : "s"} processing</b><br /><span className="small">{state.busy ? "Checking Vaani…" : state.note || "Vaani is preparing the transcript. This page updates by itself."}</span></span>
    </div>
  );
}
