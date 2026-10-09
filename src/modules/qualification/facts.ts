import { z } from "zod";

/** Structured facts about a call. Caller statements are evidence; this is the validated shape. */
export const FactsSchema = z.object({
  callerName: z.string().max(120).optional(),
  callerType: z.enum(["new_prospect", "existing_client", "unknown"]).default("unknown"),

  // escalation signals
  isComplaint: z.boolean().optional(),
  requestedHuman: z.boolean().optional(),
  requestedEscalationTo: z.string().max(120).optional(),
  complaintSummary: z.string().max(400).optional(),
  projectReference: z.string().max(200).optional(),
  frustratedPriorEnquiry: z.boolean().optional(),

  // project
  projectCategory: z.enum(["residential", "commercial"]).optional(),
  propertyType: z.enum([
    "apartment", "independent_house", "villa", "office", "clinic", "studio",
    "restaurant", "hotel", "retail", "gym", "other",
  ]).optional(),
  locationText: z.string().max(200).optional(),
  carpetAreaSqft: z.number().positive().max(1_000_000).optional(),
  scopeKind: z.enum(["full_home", "partial_home", "single_room", "commercial_fitout", "unspecified"]).optional(),
  roomCount: z.number().int().positive().max(50).optional(),
  scopeSummary: z.string().max(400).optional(),
  engagement: z.enum(["design_and_execution", "advice_only", "furniture_only", "vastu_only", "unspecified"]).optional(),
  completeRedesign: z.boolean().optional(),
  structuralWork: z.boolean().optional(),
  isRented: z.boolean().optional(),

  // timeline
  needByWeeks: z.number().min(0).max(520).optional(),
  siteAvailableInWeeks: z.number().min(0).max(520).optional(),
  desiredStartWeeks: z.number().min(0).max(520).optional(),
  timelineFlexible: z.boolean().optional(),
  timelineText: z.string().max(200).optional(),
  siteReadinessText: z.string().max(200).optional(),

  // authority & budget
  decisionMaker: z.enum(["owner", "authorised_representative", "researching_for_others", "not_authorised", "unknown"]).default("unknown"),
  decisionMakerText: z.string().max(200).optional(),
  statedBudgetMaxInr: z.number().positive().max(1e10).optional(),

  // preferences
  consultationInterest: z.boolean().optional(),
  preferredCallbackText: z.string().max(200).optional(),
  referralSource: z.string().max(120).optional(),
  askedPricing: z.boolean().optional(),

  /** Which of the 1/2/3 clarification questions were already asked (prevents interrogation loops). */
  clarificationsAsked: z.array(z.enum(["project", "location", "timeline"])).default([]),
});

export type Facts = z.infer<typeof FactsSchema>;

export function parseFacts(input: unknown): { ok: true; facts: Facts } | { ok: false; error: string } {
  const r = FactsSchema.safeParse(input ?? {});
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400) };
  return { ok: true, facts: r.data };
}
