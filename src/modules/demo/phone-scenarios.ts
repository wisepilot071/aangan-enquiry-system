/**
 * Caller turns from "Aangan_Sep 2026_Enquiries.pdf" SECTION 1 (phone calls only).
 * Anonymised test material — never inserted as live production leads.
 * `agent` is the front-desk line that preceded the caller turn (used to interpret bare "Yes").
 */
import type { Facts } from "@/modules/qualification/facts";
import type { Disposition } from "@/modules/qualification/types";

export interface Scenario {
  id: string;
  title: string;
  /** Call date, used to resolve month names to weeks. */
  date: string;
  turns: { agent?: string; caller: string }[];
  /** Facts the PDF's front desk supplied from its own statements (not caller speech). */
  overrides?: Partial<Facts>;
  expected: {
    disposition: Disposition;
    reasonCodes?: string[];
    priority?: "normal" | "high" | "urgent";
    forward: boolean;
    uncertaintyContains?: string;
    callerName?: string;
    locationExcludes?: string;
  };
}

export const PHONE_SCENARIOS: Scenario[] = [
  {
    id: "T01", title: "Qualified full-home residential, Kothrud", date: "2026-09-02T10:23:00+05:30",
    turns: [
      { caller: "Hi, I'm Priya. I got your number from a friend — Shruti Joshi. She had her flat done by you in Aundh." },
      { agent: "What are you looking to do?", caller: "We have a 3BHK in Kothrud — Dahanukar Colony. We bought it two years ago and it still looks like the builder flat. We want to redo the whole thing — kitchen, living room, both bedrooms." },
      { agent: "How big is the apartment?", caller: "About 1,400 sq ft carpet." },
      { agent: "And your timeline?", caller: "We'd like to be done by March. We're in no rush." },
      { agent: "Are you the owner?", caller: "Yes — myself and my husband. He knows we're calling and is happy to go ahead." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    // Documented divergence from the PDF: the front desk accepted this, but move-in is ~8 weeks away,
    // inside the 6–10 week band the documents do not resolve. One question is asked (turn 3); the
    // caller answers with another pricing request instead, so a human reviews rather than looping.
    id: "T02", title: "Price asked first; move-in ~8 weeks away (tight window)", date: "2026-09-03T14:41:00+05:30",
    turns: [
      { caller: "Hi. I was looking at your work on Instagram. I have a 2BHK in Wakad — can you tell me roughly how much something like that would cost?" },
      { agent: "What are you planning to do?", caller: "Full redesign — modular kitchen, wardrobes, living room, both bedrooms. About 950 sq ft." },
      { agent: "What's your timeline?", caller: "We move in November — so maybe starting design from October?" },
      { agent: "Shall I set up a consultation?", caller: "Yes, but can you give me a rough ballpark first? Even a range?" },
    ],
    expected: { disposition: "HUMAN_REVIEW", reasonCodes: ["TIGHT_TIMELINE_NEEDS_REVIEW"], forward: false },
  },
  {
    id: "T03", title: "Property in Nashik", date: "2026-09-03T16:15:00+05:30",
    turns: [
      { caller: "Hello, I saw your work on LinkedIn. My name is Suresh Patil. I'm in Nashik — would you be able to take on a project here? I want to redo my home office and study." },
    ],
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["OUTSIDE_SERVICE_AREA"], forward: false },
  },
  {
    id: "T04", title: "Decorating advice only", date: "2026-09-04T11:07:00+05:30",
    turns: [
      { caller: "Hi — can someone come and give us some ideas for our living room? We're not planning to do the full thing right now. Just want suggestions on colours, furniture arrangement, what to change." },
    ],
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["ENGAGEMENT_ADVICE_ONLY"], forward: false },
  },
  {
    id: "T05", title: "Large residential, realistic timeline, owner status not stated", date: "2026-09-05T10:52:00+05:30",
    turns: [
      { caller: "Hi, this is Aarti Mehta. Vikram Agarwal asked me to call — he's a close friend of Nikhil's." },
      { agent: "What are you looking for?", caller: "We have a 4BHK in Koregaon Park — about 2,400 sq ft carpet. Complete redesign. New flooring, kitchen, all four bedrooms. We've already moved out temporarily." },
      { agent: "Do you have a timeline?", caller: "We want to move back in by February. About 4 months." },
    ],
    expected: { disposition: "QUALIFIED", forward: true, uncertaintyContains: "Decision-maker" },
  },
  {
    id: "T06", title: "Commercial office fitout, Baner, founder", date: "2026-09-05T15:28:00+05:30",
    turns: [
      { caller: "Hi, I'm calling about a commercial project. We're a startup — just got our first proper office space in Baner. About 800 sq ft. We need workstations for 20 people, a small cabin, a meeting room, and a break area." },
      { agent: "What's the state of the space right now?", caller: "Bare shell — just columns and floor. Nothing else." },
      { agent: "And the timeline?", caller: "We want to be operational by December. Our team is working from home currently." },
      { agent: "Are you the decision-maker for this?", caller: "Yes, I'm the founder." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    id: "T07", title: "Unrealistic three-week deadline", date: "2026-09-08T09:44:00+05:30",
    turns: [{ caller: "Hello — I want to redo my living room and kitchen before Diwali. Can you take it up?" }],
    // PDF T07: the front desk itself states "Diwali is about three weeks away" — supplied as a fact, not inferred.
    overrides: { needByWeeks: 3 },
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["NEEDED_BEFORE_MIN_LEAD_TIME"], forward: false },
  },
  {
    id: "T09", title: "Existing-client complaint, wants Nikhil/senior", date: "2026-09-10T11:32:00+05:30",
    turns: [
      { caller: "I need to speak to someone right now. My project has been going for three months and my designer hasn't replied in five days. This is not acceptable." },
      { agent: "Can I take your name and project details?", caller: "Sheetal Deshpande. My designer is Aryan. Flat in Viman Nagar — 2BHK. I've sent three messages and called twice." },
      { agent: "Would you prefer to hold, or should someone senior call you back?", caller: "Callback. And I want it from Nikhil or a senior person — not just whoever picks up." },
    ],
    expected: { disposition: "ESCALATED", reasonCodes: ["EXISTING_CLIENT_COMPLAINT"], priority: "urgent", forward: false, callerName: "Sheetal Deshpande" },
  },
  {
    id: "T10", title: "Voluntarily disclosed, clearly insufficient budget", date: "2026-09-11T14:04:00+05:30",
    turns: [
      { caller: "Hi. I have a 1BHK in Kharadi — about 550 sq ft. I want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum for everything. Is that possible with you?" },
    ],
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["BUDGET_CLEARLY_INSUFFICIENT"], forward: false },
  },
  {
    id: "T11", title: "Rented apartment, no structural changes", date: "2026-09-12T10:18:00+05:30",
    turns: [
      { caller: "Hi — I have a question. I'm in a rented apartment. Can you still take up a project?" },
      { agent: "What are you looking to do?", caller: "It's a 2BHK in Baner. I've been here a year, I have a 3-year lease, and the place is quite bare. I want to properly design the living room, bedroom, and kitchen — no structural changes, just design and fittings." },
      { agent: "Have you checked with your landlord?", caller: "Yes — they're fine with it as long as we don't break walls. And there's no rush on timing." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    id: "T12", title: "Large villa, Kalyani Nagar", date: "2026-09-15T10:05:00+05:30",
    turns: [
      { caller: "I'm calling about a villa project in Kalyani Nagar. My name is Anand Sharma. The property is about 5,500 sq ft — ground plus two floors. Full end-to-end design." },
      { agent: "Is this a new property or an existing home?", caller: "New construction. Possession was last month. Completely empty." },
      { agent: "And your timeline?", caller: "March next year to move in. No rush." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    id: "T13", title: "Repeated pricing requests, then books", date: "2026-09-16T12:19:00+05:30",
    turns: [
      { caller: "Hi — I want to redo my flat in Aundh. 3BHK, about 1,100 sq ft. What might it cost?" },
      { agent: "What are you planning?", caller: "Kitchen, wardrobes in both bedrooms, living room. But seriously — can't you give me even a rough range? I just want to know if we're in the same ballpark." },
      { agent: "The designer will go through that…", caller: "Fine. Let's book then. No rush on the timeline." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    id: "T14", title: "Son calling for parents (authorisation not confirmed)", date: "2026-09-17T11:41:00+05:30",
    turns: [
      { caller: "Hi — I wanted to inquire about an interior project for my parents. They have a 3BHK in Hadapsar — new possession. They want a proper design." },
      { agent: "Will your parents be involved in the decision?", caller: "Yes — I'm doing the initial checking. They don't really use phones much. I'll tell them about the consultation and they'll decide." },
    ],
    expected: { disposition: "QUALIFIED", forward: true, uncertaintyContains: "initial research" },
  },
  {
    id: "T15", title: "Possession in six weeks, owner", date: "2026-09-18T15:12:00+05:30",
    turns: [
      { caller: "Hi, I'm Smita. I'm getting possession of my flat in Undri in about six weeks. 2BHK, 875 sq ft. I want to start the design right away." },
      { agent: "What are you planning?", caller: "Full home — kitchen, wardrobes, living room. The full package." },
      { agent: "Are you the owner?", caller: "Yes — my husband and I. He said to go ahead and book the consultation." },
    ],
    expected: { disposition: "QUALIFIED", forward: true, callerName: "Smita" },
  },
  {
    id: "T16", title: "Frustrated repeat caller whose earlier enquiry was lost", date: "2026-09-19T10:38:00+05:30",
    turns: [
      { caller: "Hi — I'd called on Monday about a project. Someone said they'd get back to me. It's been two days." },
      { agent: "Can I get your name?", caller: "Girish Nair. I called Monday afternoon. I told someone about my 3BHK in Viman Nagar and gave my number." },
    ],
    expected: { disposition: "NEEDS_CLARIFICATION", priority: "high", forward: false },
  },
  {
    id: "T17b", title: "Reconnect after dropped call (second call)", date: "2026-09-22T14:16:00+05:30",
    turns: [
      { caller: "Hi — I called just now and got cut off. I'm Ritu Kapoor from Pimple Saudagar. 3BHK, about 1,050 sq ft. We've been here two years but never properly did the interiors. We want to start now." },
      { agent: "What are you looking to do?", caller: "Kitchen, wardrobes, living room. We moved in with builder furniture and it's very basic. We want the full redesign." },
      { agent: "Timeline?", caller: "Ideally done by March. Plenty of time." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
  {
    id: "T18", title: "Commercial space below accepted scope (180 sq ft)", date: "2026-09-23T11:55:00+05:30",
    turns: [
      { caller: "Hi — I run a small coworking space. I have a 180 sq ft pod I want to make look really nice. Good lighting, a nice desk, some storage. Can you help?" },
    ],
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["COMMERCIAL_BELOW_MINIMUM"], forward: false },
  },
  {
    id: "T19", title: "Restaurant enquiry", date: "2026-09-24T16:02:00+05:30",
    turns: [
      { caller: "Hi — I'm planning to open a restaurant in Koregaon Park. I've seen your work and I love it. Would you be able to design the interiors?" },
    ],
    expected: { disposition: "CLOSED_NOT_FORWARDED", reasonCodes: ["PROPERTY_TYPE_OUT_OF_SCOPE"], forward: false },
  },
  {
    id: "T20", title: "Qualified, budget undisclosed, Magarpatta", date: "2026-09-25T09:15:00+05:30",
    turns: [
      { caller: "Good morning. I'm Pooja. I have a 2BHK in Magarpatta — Cybercity area. We've been wanting to properly design the interiors for a while. Kitchen, both bedrooms, living room. About 900 sq ft." },
      { agent: "How soon are you looking to start?", caller: "We're flexible — a January start for execution would be ideal." },
      { agent: "Are you the owner?", caller: "Yes — my husband and I. We both want to be at the consultation." },
    ],
    expected: { disposition: "QUALIFIED", forward: true },
  },
];
