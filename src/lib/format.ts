const IST = { timeZone: "Asia/Kolkata" } as const;

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(d)) + " IST";
}
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric" }).format(new Date(d));
}
export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}
export const fmtPct = (v: number | null) => (v === null ? "N/A" : `${Math.round(v * 1000) / 10}%`);
export function fmtInr(v: number | null | undefined): string {
  if (v === null || v === undefined) return "N/A";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(v);
}
export const titleCase = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "—");

/** Masks the middle of a phone number for lists; full number only on the detail page. */
export function maskPhone(p: string | null | undefined): string {
  if (!p) return "—";
  return p.length <= 6 ? p : `${p.slice(0, 3)}•••••${p.slice(-3)}`;
}
