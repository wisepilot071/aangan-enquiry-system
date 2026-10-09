import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** In open-access mode there is nothing to sign in to. */
export default function LoginLayout({ children }: { children: ReactNode }) {
  if (getConfig().AUTH_MODE === "open") redirect("/");
  return children;
}
