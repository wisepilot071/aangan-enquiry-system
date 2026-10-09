/**
 * Configurable business policy. Every value names its source so a reviewer can tell
 * "from Nikhil's documents" apart from "default that needs owner confirmation".
 */
export const RULE_VERSION = "qualified-md-v1.0";

export const timelinePolicy = {
  /** services.md: "cannot begin execution on a project that needs to be ready in under 6 weeks from today". */
  minLeadWeeks: { value: 6, source: "services.md → Timelines → Minimum lead time" },
  /**
   * qualified.md names an "8–10 week" window and the front desk (PDF T07) says a room redesign with
   * execution takes "at least 8–10 weeks". Between the 6-week hard minimum and 10 weeks the documents
   * do not clearly decide, so the result is a clarification + review flag, never a silent pass/fail.
   */
  tightBelowWeeks: { value: 10, source: "qualified.md criterion 3 (8–10 weeks) + PDF T07; resolution is a review flag, not a decision" },
  /** qualified.md criterion 3: site available for execution within 8–10 weeks of the consultation. */
  siteAvailabilityMaxWeeks: { value: 10, source: "qualified.md → criterion 3 (8–10 weeks)" },
} as const;

export const scopePolicy = {
  commercialMaxSqft: { value: 3000, source: "services.md → Commercial projects (approximately 3,000 sq ft)" },
  /** "approximately": between max and max*(1+tol) is a human-review edge case rather than an automatic fail. */
  commercialToleranceFraction: { value: 0.1, source: "DEFAULT — owner to confirm what 'approximately' means" },
  commercialMinSqft: {
    value: 500,
    source:
      "Aangan_Sep 2026_Enquiries.pdf T18 (front desk: 'typically 500 sq ft or more'). NOT in services.md — conflict documented; owner to confirm.",
  },
} as const;

/**
 * Criterion 4 — obvious budget mismatch only. These floors are deliberately far below any
 * indicative internal figure; they exist solely to catch cases like "₹1–1.5 lakh for a full flat"
 * (qualified.md). They are server-side only, never spoken, logged, or returned by any API.
 */
export const budgetFloorPolicy = {
  perRoomInr: { value: 200_000, source: "DEFAULT conservative floor — owner to confirm" },
  residentialPerSqftInr: { value: 700, source: "DEFAULT conservative floor — owner to confirm" },
  commercialPerSqftInr: { value: 500, source: "DEFAULT conservative floor — owner to confirm" },
} as const;

/** Types explicitly out of scope in services.md. */
export const OUT_OF_SCOPE_PROPERTY_TYPES = ["restaurant", "hotel", "retail", "gym"] as const;

/** Cities that services.md names as not served, plus other cities as "other cities outside this area". */
export const NAMED_OUT_OF_AREA = ["Talegaon", "Lonavala", "Nashik", "Mumbai"] as const;
export const OTHER_CITIES_OUTSIDE_AREA = [
  "Navi Mumbai", "Thane", "Nagpur", "Satara", "Kolhapur", "Solapur", "Sambhajinagar", "Aurangabad",
  "Bangalore", "Bengaluru", "Delhi", "Hyderabad", "Chennai", "Ahmedabad", "Goa", "Khopoli", "Alibag", "Lavasa",
] as const;

/**
 * Localities not in services.md's explicit list but evidenced in the PDF as handled in-area by the
 * front desk. Supplementary, labelled, and flagged for owner confirmation.
 */
export const SUPPLEMENTARY_LOCALITIES: { name: string; source: string }[] = [
  { name: "Kharadi", source: "PDF T10 (front desk treated as in-area)" },
  { name: "Nanded City", source: "PDF T08 ('Nanded City area (Pune)')" },
  { name: "Sunderban", source: "PDF W09 (Aundh – Sunderban area)" },
  { name: "Cybercity", source: "PDF T20 (Magarpatta – Cybercity)" },
  { name: "Dahanukar Colony", source: "PDF T01 (Kothrud – Dahanukar Colony)" },
];
