import type { Facts } from "@/modules/qualification/facts";
import { explain } from "@/modules/qualification/explain";
import type { Assessment } from "@/modules/qualification/types";

export interface MessageContext {
  ref: string;
  enquiryId: string;
  receivedAt: Date | null;
  callerName?: string | null;
  callerPhone?: string | null;
  isDemo: boolean;
  baseUrl?: string;
  facts: Facts;
  assessment: Assessment;
  /** What happened on the call, in the provider's or our own words. */
  summary?: string | null;
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
});
export const formatIst = (d: Date | null) => (d ? `${IST.format(d)} IST` : "not recorded");

const or = (v: string | number | null | undefined, fallback = "not provided") => (v === null || v === undefined || v === "" ? fallback : String(v));
/** Free text can repeat a figure the caller volunteered; amounts are kept out of Telegram (they stay on the dashboard). */
export function redactMoney(t: string): string {
  return t
    .replace(/(?:₹|\brs\.?|\binr)\s*\d[\d,.]*(?:\s*(?:lakhs?|lacs?|crores?|k|thousand))?/gi, "[amount]")
    .replace(/\b\d[\d,.]*\s*(?:lakhs?|lacs?|crores?)\b/gi, "[amount]")
    .replace(/(\bbudget(?:\s+(?:of|is|was|around|about|up\s+to|upto|under|maximum|max))*\s+)\d[\d,.]*(?:\s*k\b)?/gi, "$1[amount]");
}
const clip = (t: string | null | undefined, n: number) => (t ? redactMoney(t.length > n ? `${t.slice(0, n - 1)}…` : t) : "not available");
const demoTag = (c: MessageContext) => (c.isDemo ? "[DEMO / MOCK — not a real enquiry]\n" : "");
const link = (c: MessageContext) => (c.baseUrl ? `\nDetails (login required): ${c.baseUrl.replace(/\/$/, "")}/enquiries/${c.enquiryId}` : "");

function timelineSummary(f: Facts): string {
  const parts: string[] = [];
  if (f.timelineText) parts.push(f.timelineText);
  if (f.needByWeeks !== undefined) parts.push(`needed in ~${Math.round(f.needByWeeks)} weeks`);
  if (f.desiredStartWeeks !== undefined) parts.push(f.desiredStartWeeks === 0 ? "wants to start now" : `start in ~${Math.round(f.desiredStartWeeks)} weeks`);
  if (f.timelineFlexible) parts.push("flexible");
  return parts.length ? parts.join("; ") : "not provided";
}

function scopeSummary(f: Facts): string {
  const bits = [f.scopeKind && f.scopeKind !== "unspecified" ? f.scopeKind.replace(/_/g, " ") : null,
    f.roomCount ? `${f.roomCount} room(s)` : null, f.scopeSummary ?? null].filter(Boolean);
  return bits.length ? bits.join(", ") : "not provided";
}

/** New-lead handoff. Never includes pricing data, transcripts, or secrets. */
export function formatQualifiedHandoff(c: MessageContext): string {
  const f = c.facts;
  const req = f.consultationInterest
    ? "Consultation requested (NOT yet booked)"
    : f.preferredCallbackText ? `Callback preference: ${f.preferredCallbackText}` : "No specific request recorded";
  const uncertainties = [...c.assessment.uncertainties, ...c.assessment.humanReviewReasons];
  return `${demoTag(c)}AANGAN STUDIO — NEW QUALIFIED ENQUIRY
Enquiry ID: ${c.ref}
Received at: ${formatIst(c.receivedAt)}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Project: ${or(f.projectCategory)}${f.propertyType ? ` (${f.propertyType.replace(/_/g, " ")})` : ""}
Location: ${or(f.locationText)}
Scope: ${scopeSummary(f)}
Approximate carpet area: ${f.carpetAreaSqft ? `${f.carpetAreaSqft} sq ft` : "not provided"}
Timeline: ${timelineSummary(f)}
Site readiness: ${f.siteAvailableInWeeks === undefined ? or(f.siteReadinessText) : f.siteAvailableInWeeks === 0 ? "available now" : `available in ~${f.siteAvailableInWeeks} weeks`}
Decision-maker status: ${f.decisionMaker.replace(/_/g, " ")}${f.decisionMakerText ? ` — ${f.decisionMakerText}` : ""}
Qualification: Qualified (${c.assessment.ruleVersion})
Uncertainties: ${uncertainties.length ? uncertainties.join(" | ") : "none noted"}
Caller request: ${req}
What happened: ${clip(c.summary, 600)}
Next action: ${nextAction(c)}
Source: Incoming phone call${link(c)}`;
}

const exOf = (c: MessageContext) => explain({ disposition: c.assessment.disposition, criteria: c.assessment.criteria, uncertainties: c.assessment.uncertainties,
  humanReviewReasons: c.assessment.humanReviewReasons, escalationKind: c.assessment.escalation?.kind });
const nextAction = (c: MessageContext) => exOf(c).nextStep;

/** Update for any AI-handled call that is not a lead or an escalation: what happened, the outcome, why, and the next action. */
export function formatCallUpdate(c: MessageContext): string {
  const ex = exOf(c);
  const f = c.facts;
  const consult = f.consultationInterest ? `Asked for a consultation${f.preferredCallbackText ? ` (preferred time: ${f.preferredCallbackText})` : ""} — NOT booked yet` : "No consultation requested";
  return `${demoTag(c)}AANGAN STUDIO — CALL UPDATE
Enquiry ID: ${c.ref}
Received at: ${formatIst(c.receivedAt)}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Outcome: ${ex.headline}
Why: ${clip(ex.short.replace(/^[^:]+:\s*/, ""), 300)}
What happened: ${clip(c.summary, 600)}
Consultation: ${consult}
Next action: ${ex.nextStep}
Source: Incoming phone call${link(c)}`;
}

/** Calendar link (no calendar integration needed): opens Google Calendar prefilled; one hour by default. */
export function googleCalendarLink(title: string, start: Date, details: string, minutes = 60): string {
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(start.getTime() + minutes * 60_000);
  const q = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${z(start)}/${z(end)}`, details, ctz: "Asia/Kolkata" });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** Sent only after a person confirms the consultation on the dashboard. */
export function formatConsultationScheduled(c: { ref: string; enquiryId: string; callerName?: string | null; callerPhone?: string | null; locationText?: string | null; scope?: string | null; at: Date | null; note?: string | null; isDemo: boolean; baseUrl?: string }): string {
  const when = c.at ? formatIst(c.at) : "time not recorded yet";
  const cal = c.at ? `\nAdd to calendar: ${googleCalendarLink(`Aangan consultation — ${c.callerName ?? c.ref}`, c.at, `${c.ref}. Phone: ${c.callerPhone ?? "n/a"}. ${c.locationText ?? ""}`)}` : "";
  return `${c.isDemo ? "[DEMO / MOCK — not a real enquiry]\n" : ""}AANGAN STUDIO — CONSULTATION SCHEDULED
Enquiry ID: ${c.ref}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Location: ${or(c.locationText)}${c.scope ? `\nProject: ${c.scope}` : ""}
When: ${when}
Details: ${or(c.note, "none")}${cal}
Next action: Please be ready for this consultation and update the enquiry afterwards.${c.baseUrl ? `\nDetails (login not required): ${c.baseUrl.replace(/\/$/, "")}/enquiries/${c.enquiryId}` : ""}`;
}

/** Sent when the app has placed a PROPOSED slot on the studio calendar after a qualified call. The caller was not promised a time. */
export function formatConsultationProposed(c: { ref: string; enquiryId: string; callerName?: string | null; callerPhone?: string | null; locationText?: string | null; at: Date; eventLink?: string | null; isDemo: boolean; baseUrl?: string }): string {
  return `${c.isDemo ? "[DEMO / MOCK — not a real enquiry]\n" : ""}AANGAN STUDIO — DESIGN CONSULTATION PENCILLED IN
Enquiry ID: ${c.ref}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Location: ${or(c.locationText)}
Proposed slot: ${formatIst(c.at)} (placed on the studio Google Calendar as tentative)
Caller was told only that the team will confirm; no time was promised.${c.eventLink ? `\nCalendar event: ${c.eventLink}` : ""}
Next action: Call the lead to confirm or change the time, then mark it confirmed on the dashboard.${c.baseUrl ? `\nDetails (login not required): ${c.baseUrl.replace(/\/$/, "")}/enquiries/${c.enquiryId}` : ""}`;
}

/** Sent when automatic calendar scheduling could not complete, so the designer is never left guessing. */
export function formatConsultationUnscheduled(c: { ref: string; enquiryId: string; callerName?: string | null; callerPhone?: string | null; reason: string; isDemo: boolean; baseUrl?: string }): string {
  return `${c.isDemo ? "[DEMO / MOCK — not a real enquiry]\n" : ""}AANGAN STUDIO — CONSULTATION NOT SCHEDULED AUTOMATICALLY
Enquiry ID: ${c.ref}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Why: ${c.reason}
Next action: Please schedule this consultation manually (dashboard → Schedule consultation).${c.baseUrl ? `\nDetails (login not required): ${c.baseUrl.replace(/\/$/, "")}/enquiries/${c.enquiryId}` : ""}`;
}

export function formatUrgentEscalation(c: MessageContext): string {
  const f = c.facts;
  const kind = c.assessment.escalation?.kind === "existing_client_complaint" ? "Existing-client complaint" : "Caller asked for a person";
  return `${demoTag(c)}AANGAN STUDIO — URGENT ESCALATION
Priority: ${c.assessment.priority.toUpperCase()}
Enquiry ID: ${c.ref}
Received at: ${formatIst(c.receivedAt)}
Type: ${kind}
Caller: ${or(c.callerName)}
Phone: ${or(c.callerPhone)}
Project reference: ${or(f.projectReference ?? f.locationText)}
Asked for: ${or(c.assessment.escalation?.requestedRecipient, "no specific person")}
Summary: ${or(f.complaintSummary, "see enquiry record")}
What happened: ${clip(c.summary, 500)}
Next action: Call the person back as soon as possible and close the follow-up task.
Note: Callback time was NOT promised to the caller. Please follow up as soon as possible.
Source: Incoming phone call${link(c)}`;
}

export function formatMissedCall(c: { ref: string; enquiryId: string; at: Date | null; phone?: string | null; isDemo: boolean; kind: "missed" | "disconnected"; baseUrl?: string }): string {
  return `${c.isDemo ? "[DEMO / MOCK — not a real call]\n" : ""}AANGAN STUDIO — ${c.kind === "missed" ? "MISSED" : "DISCONNECTED"} CALL
Enquiry ID: ${c.ref}
Time: ${formatIst(c.at)}
Phone: ${or(c.phone, "not available")}
No transcript exists. Please follow up manually; no automatic callback is made.${c.baseUrl ? `\nDetails (login required): ${c.baseUrl.replace(/\/$/, "")}/enquiries/${c.enquiryId}` : ""}`;
}

export const enquiryRef = (seq: number) => `AGN-${String(seq).padStart(5, "0")}`;
