import {
  NAMED_OUT_OF_AREA, OTHER_CITIES_OUTSIDE_AREA, SUPPLEMENTARY_LOCALITIES,
} from "../business-knowledge/policy";
import { loadServiceCatalogue } from "../business-knowledge/service-area";
import { isPricingQuestion } from "../pricing-guardrails";
import { FactsSchema, type Facts } from "./facts";

/**
 * Deterministic, rule-based fact extractor used by MOCK mode and the regression suite.
 * It is NOT a claim about what the real voice provider extracts. In live mode, structured
 * fields from the provider/LLM are validated with FactsSchema and fed to the same engine.
 */
export interface ExtractContext {
  now: Date;
  /** The agent's last question (used to interpret bare "yes"). */
  lastAgentQuestion?: string;
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NOT_PLACES = new Set([...MONTHS.map((m) => m[0]!.toUpperCase() + m.slice(1)), "Diwali", "Nikhil", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "India", "English", "Hindi"]);

const toNum = (s: string): number | undefined => {
  const t = s.toLowerCase();
  if (NUM_WORDS[t] !== undefined) return NUM_WORDS[t];
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const NUM_RE = "(\\d[\\d,]*(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

function weeksUntilMonth(now: Date, monthIdx: number): number {
  let year = now.getUTCFullYear();
  if (monthIdx <= now.getUTCMonth()) year += 1;
  const target = Date.UTC(year, monthIdx, 1);
  return Math.max(0, Math.round(((target - now.getTime()) / (7 * 86400000)) * 10) / 10);
}

/** Sentences about someone else's project (a referrer's flat, work the caller saw) say nothing about the caller's site. */
const THIRD_PARTY_PLACE = /\b(?:friend|referred|referral|had (?:her|his|their) (?:flat|home|house)|done by you|saw your work|your work|got your number)\b/i;

function extractLocation(fullText: string): string | undefined {
  const text = fullText.split(/(?<=[.?!])\s+/).filter((sentence) => !THIRD_PARTY_PLACE.test(sentence)).join(" ");
  const names = new Set<string>();
  const cat = loadServiceCatalogue();
  const all = [
    ...cat.pcmcLocalities, ...cat.puneLocalities, ...cat.outsideNamed, ...NAMED_OUT_OF_AREA,
    ...OTHER_CITIES_OUTSIDE_AREA, ...SUPPLEMENTARY_LOCALITIES.map((l) => l.name), "Pune", "PCMC", "Pimpri Chinchwad",
  ];
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  for (const n of all) if (lower.includes(` ${n.toLowerCase()} `)) names.add(n);
  for (const m of text.matchAll(/\b(?:in|at|near)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/g)) {
    const place = m[1]!.trim();
    const first = place.split(" ")[0]!;
    if (!NOT_PLACES.has(first) && !NOT_PLACES.has(place)) names.add(place);
  }
  return names.size ? [...names].join(", ") : undefined;
}

export function extractBudget(text: string): number | undefined {
  if (!/budget|₹|\brs\.?\b|rupees|lakh|lac\b/i.test(text)) return undefined;
  const m = text.match(new RegExp(`(?:budget|₹|rs\\.?|rupees)[^.?!]{0,40}?${NUM_RE}(?:\\s*(?:to|-|–|—|and)\\s*${NUM_RE})?\\s*(lakhs?|lacs?|crores?)`, "i"));
  if (!m) return undefined;
  const a = toNum(m[1]!);
  const b = m[2] ? toNum(m[2]) : undefined;
  const unit = m[3]!.toLowerCase().startsWith("cr") ? 10_000_000 : 100_000;
  const top = Math.max(a ?? 0, b ?? 0);
  return top > 0 ? Math.round(top * unit) : undefined;
}

export function extractFacts(utterance: string, prev: Partial<Facts> = {}, ctx: ExtractContext = { now: new Date() }): Facts {
  const text = utterance.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const t = text.toLowerCase();
  const out: Record<string, unknown> = { ...prev };
  const set = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
  const q = (ctx.lastAgentQuestion ?? "").toLowerCase();
  const saysYes = /^(?:yes|yeah|yep|sure|correct|right|absolutely|of course)\b/i.test(text);

  // --- name ---
  const nm = text.match(/(?:\b[Ii]'?m|\b[Ii] am|\b[Tt]his is|\b[Mm]y name is|\b[Ii]t'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=[\s,.—-]|$)/);
  if (nm && !/^(?:Calling|Looking|Planning|Getting|Doing)/.test(nm[1]!)) set("callerName", nm[1]);
  else if (/\bname\b/.test(q)) {
    const bare = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[.,]/);
    if (bare) set("callerName", bare[1]);
  }

  // --- escalation / complaint ---
  const projectContext = /\bmy (?:project|designer)\b|\bongoing project\b|\bproject has been going\b|\bmy flat\b.*\bdesigner\b/.test(t);
  const complaintCue = /hasn'?t replied|haven'?t (?:heard|received|replied)|not acceptable|unacceptable|complain|unhappy|disappointed|no one (?:has )?(?:replied|responded)|ignored|not responding/.test(t);
  if (projectContext && (complaintCue || /\bsomeone right now\b|speak to someone/.test(t))) {
    set("callerType", "existing_client");
    set("isComplaint", true);
    const d = text.match(/designer is ([A-Z][a-z]+)/);
    set("projectReference", d ? `Designer: ${d[1]}` : prev.projectReference);
    set("complaintSummary", "Existing project: designer not responding / dissatisfaction.");
  }
  const asksNikhil = /(?:speak|talk)\s+(?:to|with)\s+nikhil|(?:from|by)\s+nikhil|nikhil\s+(?:to\s+)?(?:call|himself)|want\s+nikhil|call\s+nikhil/.test(t);
  const asksSenior = /\bsenior\b|\bmanager\b|\bstudio head\b/.test(t);
  if (asksNikhil || asksSenior) {
    set("requestedHuman", true);
    set("requestedEscalationTo", asksNikhil ? "Nikhil" : "Senior person");
  }
  if (/(?:speak|talk)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+)?(?:human|real person|person|someone|agent|representative)|connect me to (?:a )?(?:human|person)|human please|i want a human/.test(t)) {
    set("requestedHuman", true);
  }
  if (/(?:i(?:'d| had)? called|called (?:on )?(?:monday|tuesday|wednesday|thursday|friday|yesterday|earlier))/.test(t) &&
      /(?:get back|back to me|said they|someone said|no one|two days|days)/.test(t)) {
    set("frustratedPriorEnquiry", true);
  }
  if (/not a good sign|so frustrat|very frustrat/.test(t)) set("frustratedPriorEnquiry", true);

  // --- property / category ---
  const noHomeOffice = t.replace(/home office/g, "homeoffice");
  if (/restaurant|cafe\b|caf[eé]\b|hotel|resort/.test(t)) set("propertyType", /hotel|resort/.test(t) ? "hotel" : "restaurant");
  else if (/\bgym\b|fitness (?:centre|center|studio)/.test(t)) set("propertyType", "gym");
  else if (/retail|\bshowroom\b|\bboutique\b|retail store|\bshop\b/.test(t)) set("propertyType", "retail");
  else if (/\bclinic\b/.test(noHomeOffice)) set("propertyType", "clinic");
  else if (/\boffice\b|co-?working|startup|workstations?/.test(noHomeOffice)) set("propertyType", "office");
  else if (/\bvilla\b|bungalow/.test(t)) set("propertyType", "villa");
  else if (/independent house|row house|\bhouse\b/.test(t)) set("propertyType", "independent_house");
  else if (/\bflat\b|apartment|\d\s*bhk|\bbhk\b/.test(t)) set("propertyType", "apartment");

  const pt = out.propertyType as string | undefined;
  if (pt && ["office", "clinic", "studio", "restaurant", "hotel", "retail", "gym"].includes(pt)) set("projectCategory", "commercial");
  else if (pt) set("projectCategory", "residential");
  if (/commercial/.test(t)) set("projectCategory", "commercial");
  if (out.callerType === undefined || out.callerType === "unknown") {
    if (pt || /redo|redesign|design|interior|project/.test(t)) set("callerType", "new_prospect");
  }
  if (/rented|\blease\b|tenant/.test(t)) set("isRented", true);

  // --- location ---
  const loc = extractLocation(text);
  if (loc) set("locationText", prev.locationText && !prev.locationText.includes(loc) ? `${prev.locationText}, ${loc}` : loc);

  // --- area ---
  const area = text.match(/(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|square\s*f(?:ee|oo)t)/i);
  if (area) set("carpetAreaSqft", Number(area[1]!.replace(/,/g, "")));

  // --- scope / rooms ---
  const roomPatterns: [RegExp, number | ((m: RegExpMatchArray) => number)][] = [
    [/\bkitchen\b/, 1], [/\bliving(?: room)?\b/, 1], [/\bdining\b/, 1], [/\bstudy\b/, 1], [/home\s*office/, 1],
  ];
  let rooms = 0;
  for (const [re, n] of roomPatterns) if (re.test(t)) rooms += typeof n === "number" ? n : 1;
  const bed = t.match(new RegExp(`(?:(both|all ${NUM_RE}|${NUM_RE}|one|a)\\s+)?bedrooms?`));
  if (bed) {
    const w = bed[1] ?? "";
    if (/^both/.test(w)) rooms += 2;
    else if (/^all /.test(w)) rooms += toNum(w.replace("all ", "")) ?? 2;
    else rooms += toNum(w) ?? 1;
  }
  if (rooms > 0) set("roomCount", Math.max(rooms, Number(prev.roomCount ?? 0)));

  const notFull = /(?:not|n't)\s+(?:planning\s+|going\s+|looking\s+)?(?:to\s+)?do the (?:full|whole)/.test(t);
  const fullHome = !notFull && /(whole thing|full home|full-home|whole (?:flat|home|house)|entire (?:home|flat|house)|complete redesign|full redesign|end-to-end|full package|the full thing|redo (?:my|the|our) (?:flat|home|house)|full interiors?)/.test(t);
  const commercialFit = out.projectCategory === "commercial" && (out.propertyType === "office" || out.propertyType === "clinic");
  if (commercialFit) set("scopeKind", "commercial_fitout");
  else if (fullHome) set("scopeKind", "full_home");
  else if ((out.roomCount as number | undefined) && (out.roomCount as number) >= 2) set("scopeKind", out.scopeKind === "full_home" ? "full_home" : "partial_home");
  else if ((out.roomCount as number | undefined) === 1 && out.scopeKind === undefined) set("scopeKind", "single_room");
  else if (/\d\s*bhk/.test(t) && /interior|design/.test(t) && out.scopeKind === undefined) set("scopeKind", "full_home");

  // --- engagement ---
  const execution = /execution|end-to-end|full package|turnkey|design and (?:fit|exec)|fittings|materials, furniture/.test(t);
  const advice = /(?:ideas|suggestions?|advice|advise|opinion|come and (?:give|advise)|just exploring|just want to explore)/.test(t);
  if (/(?:do|handle) the execution myself|i'?ll do the execution/.test(t) || (advice && !execution && !fullHome)) set("engagement", "advice_only");
  else if (/(?:just|only|standalone)\s+(?:the\s+)?(?:buy|source|sourcing|furniture)|source furniture/.test(t)) set("engagement", "furniture_only");
  else if (/vastu (?:consultation|advice|only)/.test(t) && !/design/.test(t)) set("engagement", "vastu_only");
  else if (execution || fullHome || /complete redesign|properly design|proper design/.test(t)) {
    if (out.engagement !== "advice_only" || execution || fullHome) set("engagement", "design_and_execution");
  }
  if (/(?:complete|full|proper|properly)\s+(?:redesign|design)|redesign|redo/.test(t)) set("completeRedesign", true);
  if (/(?:no|without|not)\s+(?:any\s+)?(?:structural|breaking|wall)|don'?t (?:break|touch)|as long as we don'?t break/.test(t)) set("structuralWork", false);
  else if (/(?:break|remove|knock|demolish|move)\w*\s+(?:a |the |some )?walls?|structural (?:change|work|modification)|extend the (?:balcony|room)/.test(t)) set("structuralWork", true);

  // --- timeline & site ---
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    const s = sentence.toLowerCase();
    const wk = s.match(new RegExp(`${NUM_RE}\\s+weeks?`));
    const mo = s.match(new RegExp(`${NUM_RE}\\s+months?`));
    const monthAlt = MONTHS.join("|");
    const doneMonth = s.match(new RegExp(String.raw`(?:\bby|\bbefore|move(?:\s+back)?\s+in|moving\s+in|operational\s+by|done\s+by|ready\s+by|complete(?:d)?\s+by)\s+(?:in\s+)?(${monthAlt})`));
    const startMonth = s.match(new RegExp(String.raw`(${monthAlt})\s+start|start(?:ing)?\s+(?:the\s+)?(?:design\s+)?(?:from|in)\s+(${monthAlt})`));
    const possession = /possession/.test(s);
    if (possession && wk) { set("siteAvailableInWeeks", toNum(wk[1]!)); continue; }
    if (possession && /(?:last month|already|was|done|received|got)/.test(s)) set("siteAvailableInWeeks", 0);
    const completionCue = /\b(?:by|before|done|complete|completed|ready|operational|move back in|move in|moving in|deadline|need it)\b/.test(s);
    if (wk && !possession && /(?:away|from now|in \w+ weeks|within|need|deadline|maximum|only)/.test(s)) set("needByWeeks", toNum(wk[1]!));
    else if (mo && /\babout\b|\bwithin\b|\bin\b|\bby\b/.test(s) && completionCue) set("needByWeeks", Math.round((toNum(mo[1]!) ?? 0) * 4.35));
    else if (doneMonth) set("needByWeeks", weeksUntilMonth(ctx.now, MONTHS.indexOf(doneMonth[1]!)));
    if (startMonth) set("desiredStartWeeks", weeksUntilMonth(ctx.now, MONTHS.indexOf((startMonth[1] ?? startMonth[2])!)));
    if (/start (?:the )?design right away|start (?:right )?(?:away|now|immediately)|ready to start/.test(s)) set("desiredStartWeeks", 0);
    if (/no rush|plenty of time|flexible|whenever|no hurry|in no rush/.test(s)) set("timelineFlexible", true);
    if (/(?:new construction|completely empty|new possession|bare shell|already moved out|moved out temporarily|builder will let us in|we can go now|have possession|here two years|been here (?:a|\w+) years?|moved in)/.test(s) && possession === false) {
      set("siteAvailableInWeeks", prev.siteAvailableInWeeks ?? 0);
    }
    if (/(?:new possession|new construction)/.test(s)) set("siteAvailableInWeeks", 0);
    if (/\bdiwali\b|\bdussehra\b|\bholi\b|\bwedding\b|\bguests\b/.test(s)) set("timelineText", sentence.trim().slice(0, 200));
  }
  if (/(?:been here|moved in|bought it|years ago|lived)/.test(t) && out.siteAvailableInWeeks === undefined) set("siteAvailableInWeeks", 0);

  // --- decision maker ---
  if (/\bnot (?:the )?(?:decision|authori[sz]ed)|can'?t decide/.test(t)) set("decisionMaker", "not_authorised");
  else if (/(?:initial (?:checking|research)|just calling to see|researching for|(?:they|parents|in-laws) (?:will|'ll) decide|they'?ll decide)/.test(t)) set("decisionMaker", "researching_for_others");
  else if (/(?:authori[sz]ed|on behalf of|asked me to (?:go ahead|book|proceed)|(?:owners?|they) (?:asked|authori[sz]ed) me)/.test(t)) set("decisionMaker", "authorised_representative");
  else if (/(?:i'?m|i am) the (?:founder|owner|ceo|director|decision)|\bmy (?:husband|wife|spouse) and i\b|myself and my (?:husband|wife)|\bwe(?:'re| are) the owners?|\bi own\b|\bour (?:own )?(?:flat|home|house)\b|\bmy (?:own )?flat\b/.test(t)) set("decisionMaker", "owner");
  else if (/owner|decision/.test(q) && saysYes) set("decisionMaker", "owner");
  if (/(?:he|she|they) (?:knows|know|said|is happy|are happy).*(?:go ahead|calling|happy)/.test(t) && out.decisionMaker === "owner") set("decisionMakerText", "Co-owner aware and agrees.");

  // --- budget (only if volunteered; we never ask) ---
  set("statedBudgetMaxInr", extractBudget(text));

  // --- preferences ---
  if (isPricingQuestion(text)) set("askedPricing", true);
  if (/(?:let'?s book|book (?:it|that|a|the)|schedule (?:a|the)|set up a consultation|book the consultation|yes,? please|please book|site visit)/.test(t) ||
      (/consultation|site visit|book/.test(q) && saysYes)) set("consultationInterest", true);
  if (/(?:from a friend|friend of|referred|got your number from|asked me to call|saw your work|instagram|linkedin|google)/.test(t)) {
    set("referralSource", /instagram|linkedin|google/.test(t) ? (t.match(/instagram|linkedin|google/)![0]) : "personal referral");
  }

  const parsed = FactsSchema.safeParse(out);
  return parsed.success ? parsed.data : FactsSchema.parse({ ...prev });
}
