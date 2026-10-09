import type { Facts } from "@/modules/qualification/facts";
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
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
});
export const formatIst = (d: Date | null) => (d ? `${IST.format(d)} IST` : "not recorded");

const or = (v: string | number | null | undefined, fallback = "not provided") => (v === null || v === undefined || v === "" ? fallback : String(v));
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
Source: Incoming phone call${link(c)}`;
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
