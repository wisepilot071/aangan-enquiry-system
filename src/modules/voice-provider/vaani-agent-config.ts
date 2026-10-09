import { GREETING, SYSTEM_PROMPT } from "./vaani-prompt";

export { GREETING, SYSTEM_PROMPT };

/**
 * The Vaani agent definition: prompt, greeting, post-call extraction. Applied with `npm run vaani:setup`.
 * Field names follow docs.vaanivoice.ai (create-agent, update-persona, update-analysis, update-experience).
 *
 * Important: the language model on the call is NOT the decision-maker. Qualification is recomputed server-side
 * from the extracted data points; this prompt only governs how the agent speaks and what it must never say.
 */
export const AGENT_DISPLAY_NAME = "Aangan Studio — Enquiry Assistant";

const yn = ["yes", "no"];

/** Data points (names must be <= 30 characters) extracted after each call. Mapped to qualification facts server-side. */
export const DATA_POINTS = [
  { name: "caller_name", prompt: "The caller's name if they said it.", nullable: true },
  { name: "is_existing_client", prompt: "Is the caller an existing client of Aangan Studio with an ongoing project?", values: yn, nullable: true },
  { name: "is_complaint", prompt: "Is the caller complaining or unhappy about an existing project, or about not being answered?", values: yn, nullable: true },
  { name: "asked_for_person", prompt: "Did the caller ask to speak to a human, Nikhil, a senior person or a manager?", values: yn, nullable: true },
  { name: "requested_person", prompt: "The person the caller asked for (e.g. Nikhil, senior person), if any.", nullable: true },
  { name: "project_reference", prompt: "For an existing client: the designer's name, project location or reference they mentioned.", nullable: true },
  { name: "project_category", prompt: "Is the project residential or commercial?", values: ["residential", "commercial"], nullable: true },
  { name: "property_type", prompt: "Type of property.", values: ["apartment", "independent_house", "villa", "office", "clinic", "studio", "restaurant", "hotel", "retail", "gym", "other"], nullable: true },
  { name: "location", prompt: "Area or locality and city of the property exactly as the caller said it (e.g. 'Baner, Pune').", nullable: true },
  { name: "carpet_area_sqft", prompt: "Approximate carpet area in square feet as a plain number, if stated.", nullable: true },
  { name: "scope_kind", prompt: "What they want designed.", values: ["full_home", "partial_home", "single_room", "commercial_fitout"], nullable: true },
  { name: "room_count", prompt: "Number of rooms to be designed as a plain number, if stated.", nullable: true },
  { name: "engagement", prompt: "What they are asking for.", values: ["design_and_execution", "advice_only", "furniture_only", "vastu_only"], nullable: true },
  { name: "complete_redesign", prompt: "For a single room: do they want a complete redesign with execution?", values: yn, nullable: true },
  { name: "structural_work", prompt: "Do they want walls moved or other structural changes?", values: yn, nullable: true },
  { name: "is_rented", prompt: "Is the property rented?", values: yn, nullable: true },
  { name: "timeline_text", prompt: "When they need the project complete or want to start, in the caller's own words.", nullable: true },
  { name: "site_ready_text", prompt: "Whether the site is available now or when possession happens, in the caller's own words.", nullable: true },
  { name: "decision_maker", prompt: "Who decides.", values: ["owner", "authorised_representative", "researching_for_others", "not_authorised", "unknown"], nullable: true },
  { name: "budget_text", prompt: "A budget ONLY if the caller volunteered it, in their own words. Never infer.", nullable: true },
  { name: "wants_consultation", prompt: "Did the caller say they want a consultation or site visit?", values: yn, nullable: true },
  { name: "callback_time_text", prompt: "Preferred callback or consultation time, if mentioned.", nullable: true },
  { name: "referral_source", prompt: "How they heard of the studio (e.g. friend, Instagram), without names.", nullable: true },
  { name: "earlier_enquiry_ignored", prompt: "Did the caller say an earlier enquiry or call was not followed up?", values: yn, nullable: true },
  { name: "asked_price", prompt: "Did the caller ask about price or cost?", values: yn, nullable: true },
];

export function buildAgentConfig() {
  return {
    persona: {
      identity: {
        system_prompt: SYSTEM_PROMPT,
        personality: { tone: "humble, warm, very polite and courteous", pace: "calm and unhurried", manner: "gracious host; never abrupt" },
        greeting_message: { agent_message: GREETING, interruptible: true, let_user_speak_first: false },
      },
    },
  };
}

export function buildAnalysisPatch() {
  return {
    evaluations: { dispositions: { enabled: false }, conversation_evaluation: { enabled: false } },
    extraction: {
      data_collection: { enabled: true, data_points: DATA_POINTS },
      collect_concerns: { enabled: true, prompt: "Note any complaint, unresolved issue or request for a senior person, briefly." },
    },
  };
}

export function buildExperiencePatch() {
  return {
    conversational_experience: {
      filler_words: { filler_words_frequency: 0 },
      eagerness_to_speak: "slow", // patient: lets the caller finish and never cuts in
    },
    settings: {
      call_settings: { max_duration_enabled: true, max_call_duration: 15 },
    },
  };
}
