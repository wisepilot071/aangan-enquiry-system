/**
 * Vaani's post-call "data points" come back as FREE TEXT written by its model (observed on real calls:
 * scope_kind = "interior design for a room", engagement = "interior design and execution", budget_text = "50,000"),
 * not as the exact keywords we asked for. These helpers translate that text into our fixed vocabulary using
 * explicit, tested rules. Anything they cannot place with confidence becomes `undefined` (unknown) — never a guess.
 */
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = "(\\d[\\d,]*(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const toNum = (s: string): number | undefined => {
  const t = s.toLowerCase().replace(/,/g, "");
  if (NUM_WORDS[t] !== undefined) return NUM_WORDS[t];
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase().trim() : "");

export type Engagement = "design_and_execution" | "advice_only" | "furniture_only" | "vastu_only";
export function normEngagement(v: unknown): Engagement | undefined {
  const s = norm(v).replace(/[\s-]+/g, "_");
  if (["design_and_execution", "advice_only", "furniture_only", "vastu_only"].includes(s)) return s as Engagement;
  const t = norm(v);
  if (!t) return undefined;
  const execution = /execution|turnkey|end[- ]to[- ]end|full[- ]service|design (?:and|&|\+) (?:build|fit|exec)|complete (?:design|redesign|interior)|full (?:redesign|interior)/.test(t);
  if (/vastu/.test(t) && !/design|execution/.test(t)) return "vastu_only";
  if (/furniture/.test(t) && /(only|just|standalone|buy|sourc|purchase)/.test(t) && !execution) return "furniture_only";
  if (/advice|advis|suggestion|ideas|opinion|consultation only|just (?:looking|exploring|researching)|exploring|colour|color/.test(t) && !execution) return "advice_only";
  if (execution) return "design_and_execution";
  return undefined; // e.g. plain "interior design": not enough to know whether execution is wanted
}

export type Scope = "full_home" | "partial_home" | "single_room" | "commercial_fitout";
export function normScope(v: unknown, roomCount?: number): Scope | undefined {
  const s = norm(v).replace(/[\s-]+/g, "_");
  if (["full_home", "partial_home", "single_room", "commercial_fitout"].includes(s)) return s as Scope;
  const t = norm(v);
  if (t) {
    if (/office|clinic|workspace|commercial|fit-?out|co-?working/.test(t)) return "commercial_fitout";
    if (/full (?:home|house|flat|apartment)|whole|entire|complete (?:home|house|flat|apartment)|all rooms|\b\d\s*bhk\b|\bbhk\b/.test(t)) return "full_home";
    if (/\b(?:a|one|single|1)\s+(?:room|bedroom|living room|kitchen)\b|\bsingle room\b|\bone room\b/.test(t)) return "single_room";
    if (/rooms|floor|two|three|multiple|couple|partial/.test(t)) return "partial_home";
    if (/\broom\b|bedroom|living room|kitchen|bathroom/.test(t)) return roomCount !== undefined && roomCount >= 2 ? "partial_home" : "single_room";
  }
  if (roomCount === 1) return "single_room";
  if (roomCount !== undefined && roomCount >= 2) return "partial_home";
  return undefined;
}

export type PropertyType = "apartment" | "independent_house" | "villa" | "office" | "clinic" | "studio" | "restaurant" | "hotel" | "retail" | "gym" | "other";
export function normPropertyType(v: unknown): PropertyType | undefined {
  const t = norm(v);
  if (!t) return undefined;
  if (/restaurant|caf[eé]|bistro|bar\b/.test(t)) return "restaurant";
  if (/hotel|resort|hostel/.test(t)) return "hotel";
  if (/\bgym\b|fitness/.test(t)) return "gym";
  if (/retail|shop|store|showroom|boutique/.test(t)) return "retail";
  if (/clinic|hospital|dental/.test(t)) return "clinic";
  if (/office|workspace|co-?working/.test(t)) return "office";
  if (/\bstudio\b/.test(t) && !/studio apartment|flat/.test(t)) return "studio";
  if (/villa/.test(t)) return "villa";
  if (/independent|bungalow|row house|\bhouse\b|\bhome\b/.test(t)) return "independent_house";
  if (/apartment|flat|\bbhk\b/.test(t)) return "apartment";
  return undefined;
}

export function normCategory(v: unknown, property?: PropertyType): "residential" | "commercial" | undefined {
  const t = norm(v);
  if (/residential|home|house|flat|apartment|villa/.test(t)) return "residential";
  if (/commercial|office|clinic|business|shop/.test(t)) return "commercial";
  if (property) return ["office", "clinic", "studio", "restaurant", "hotel", "retail", "gym"].includes(property) ? "commercial" : "residential";
  return undefined;
}

export type DecisionMaker = "owner" | "authorised_representative" | "researching_for_others" | "not_authorised" | "unknown";
export function normDecisionMaker(v: unknown): DecisionMaker {
  const s = norm(v).replace(/[\s-]+/g, "_");
  if (["owner", "authorised_representative", "researching_for_others", "not_authorised", "unknown"].includes(s)) return s as DecisionMaker;
  const t = norm(v);
  if (!t) return "unknown";
  if (/not (?:the )?(?:decision|authori[sz]ed)|can'?t decide|no authority/.test(t)) return "not_authorised";
  if (/research|for (?:my )?(?:parents|in-?laws|father|mother|family)|just (?:checking|enquir)|exploring/.test(t)) return "researching_for_others";
  if (/authori[sz]ed|on behalf|representing|for the owner|agent of/.test(t)) return "authorised_representative";
  if (/owner|myself|\bi am the\b|\bi own\b|decision[- ]maker|my (?:own )?(?:flat|home|house|office|company)|founder|\bwe own\b/.test(t)) return "owner";
  return "unknown";
}

/** "50,000", "₹50000", "50k", "5 lakh", "10–12 lakh", "1.5 crore" → the caller's upper figure in rupees. A bare small number is ambiguous → undefined. */
export function parseBudgetInr(text: unknown): number | undefined {
  const t = norm(text).replace(/₹|rs\.?|inr|rupees?/g, " ");
  if (!t) return undefined;
  const nums = [...t.matchAll(new RegExp(`${NUM}\\s*(lakhs?|lacs?|crores?|cr\\b|thousand|k\\b|million|m\\b)?`, "g"))]
    .map((m) => ({ n: toNum(m[1]!), unit: (m[2] ?? "").replace(/s$/, "") }))
    .filter((x): x is { n: number; unit: string } => x.n !== undefined && x.n > 0);
  if (!nums.length) return undefined;
  const unitOf = (u: string) => (u.startsWith("lakh") || u.startsWith("lac") ? 100_000 : u.startsWith("cr") ? 10_000_000 : u === "thousand" || u === "k" ? 1000 : u === "million" || u === "m" ? 1_000_000 : 0);
  // A range like "10 to 12 lakh" shares one trailing unit.
  const sharedUnit = unitOf(nums.find((x) => x.unit)?.unit ?? "");
  const values = nums.map((x) => x.n * (unitOf(x.unit) || sharedUnit || 1));
  const top = Math.max(...values);
  if (!sharedUnit && top < 1000) return undefined; // "5" alone: lakh? thousand? unknown — never guessed
  return Math.round(top);
}

export interface TimelineFacts { needByWeeks?: number; desiredStartWeeks?: number; timelineFlexible?: boolean; siteAvailableInWeeks?: number }

/** "within three months", "by March", "no rush", "starting next month" … relative to the call time. */
export function parseTimeline(text: unknown, site: unknown, callTime: Date, monthResolver: (t: string, now: Date) => TimelineFacts): TimelineFacts {
  const out: TimelineFacts = {};
  const t = norm(text);
  if (t) {
    const m = t.match(new RegExp(`${NUM}\\s*(?:\\+\\s*)?(weeks?|wks?|months?|years?)`));
    const starting = /start|begin|commence/.test(t);
    if (m && toNum(m[1]!) !== undefined) {
      const unit = m[2]!.startsWith("w") ? 1 : m[2]!.startsWith("m") ? 4.35 : 52;
      const weeks = Math.round(toNum(m[1]!)! * unit * 10) / 10;
      if (starting) out.desiredStartWeeks = weeks; else out.needByWeeks = weeks;
    } else if (/no rush|not in a hurry|flexible|whenever|no hurry|no deadline|any ?time|plenty of time/.test(t)) {
      out.timelineFlexible = true;
    } else if (/next month/.test(t)) {
      if (starting) out.desiredStartWeeks = 4; else out.needByWeeks = 4;
    } else if (/as soon as possible|asap|immediately|right away|urgent|this week/.test(t)) {
      out.desiredStartWeeks = 0;
    } else {
      Object.assign(out, monthResolver(starting ? t : `needed by ${t}`, callTime));
    }
  }
  const s = norm(site);
  if (s && !/\b(?:not|n't|no|yet|soon|after|later)\b/.test(s)) {
    if (/ready|available|empty|vacant|handed over|already|right now|possession (?:done|received)|level|can start|accessible/.test(s)) out.siteAvailableInWeeks = 0;
  }
  const sw = s.match(new RegExp(`possession[^.]*?${NUM}\\s*(weeks?|months?)`));
  if (sw && toNum(sw[1]!) !== undefined) out.siteAvailableInWeeks = Math.round(toNum(sw[1]!)! * (sw[2]!.startsWith("w") ? 1 : 4.35));
  return out;
}
