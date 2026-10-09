import { parseDate, resolveScope } from "@/lib/http";
import type { Range, Scope } from "@/modules/analytics/queries";

export type SP = Record<string, string | string[] | undefined>;
export const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function readScope(sp: SP): { scope: Scope; range: Range; from?: string; to?: string } {
  const from = one(sp.from);
  const to = one(sp.to);
  return { scope: resolveScope(one(sp.scope)), range: { from: parseDate(from ?? null), to: parseDate(to ?? null, true) }, from, to };
}
