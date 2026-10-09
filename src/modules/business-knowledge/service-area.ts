import fs from "node:fs";
import path from "node:path";
import {
  NAMED_OUT_OF_AREA, OTHER_CITIES_OUTSIDE_AREA, SUPPLEMENTARY_LOCALITIES,
} from "./policy";

export type AreaVerdict =
  | { state: "PASS"; matched: string; reason: "IN_SERVICE_AREA" }
  | { state: "FAIL"; matched: string; reason: "OUTSIDE_SERVICE_AREA" }
  | { state: "UNCLEAR"; matched: null; reason: "LOCATION_UNKNOWN" | "LOCATION_NOT_RECOGNISED" };

export interface ServiceCatalogue {
  puneLocalities: string[];
  pcmcLocalities: string[];
  outsideNamed: string[];
}

const SERVICES_MD = path.join(process.cwd(), "knowledge", "services.md");

/** Parses the "## Service area" section of services.md so the full list is used (not just examples). */
export function parseServiceArea(markdown: string): ServiceCatalogue {
  const m = markdown.match(/##\s*Service area\s*\n([\s\S]*?)(?:\n##\s|$)/i);
  if (!m?.[1]) throw new Error("services.md: 'Service area' section not found");
  const section = m[1];
  const splitList = (s: string) =>
    s.replace(/\band adjoining areas\b/i, "").split(/,|\band\b/).map((x) => x.trim().replace(/[.*]/g, "")).filter(Boolean);

  const puneM = section.match(/Pune city\s*\(including\s*([^)]*)\)/i);
  const pcmcM = section.match(/PCMC\s*\(([^)]*)\)/i);
  const outM = section.match(/do not currently serve\s*([^.]*)\./i);
  if (!puneM?.[1] || !pcmcM?.[1]) throw new Error("services.md: could not parse Pune/PCMC locality lists");
  const outside = outM?.[1] ? splitList(outM[1].replace(/or other cities outside this area/i, "")) : [];
  return {
    puneLocalities: splitList(puneM[1]),
    pcmcLocalities: splitList(pcmcM[1]),
    outsideNamed: outside,
  };
}

let cached: ServiceCatalogue | null = null;
export function loadServiceCatalogue(markdown?: string): ServiceCatalogue {
  if (markdown) return parseServiceArea(markdown);
  cached ??= parseServiceArea(fs.readFileSync(SERVICES_MD, "utf8"));
  return cached;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const hasPhrase = (haystack: string, phrase: string) => ` ${haystack} `.includes(` ${norm(phrase)} `);

/**
 * Out-of-area names win over in-area names when both appear ("Talegaon near Pune"),
 * because the specific locality decides where the contractors must go.
 */
export function checkServiceArea(locationText: string | undefined | null, cat = loadServiceCatalogue()): AreaVerdict {
  if (!locationText || !locationText.trim()) return { state: "UNCLEAR", matched: null, reason: "LOCATION_UNKNOWN" };
  const text = norm(locationText);

  const outside = [...cat.outsideNamed, ...NAMED_OUT_OF_AREA, ...OTHER_CITIES_OUTSIDE_AREA];
  for (const o of outside.sort((a, b) => b.length - a.length)) {
    if (hasPhrase(text, o)) return { state: "FAIL", matched: o, reason: "OUTSIDE_SERVICE_AREA" };
  }
  const inside = [
    ...cat.pcmcLocalities, ...cat.puneLocalities, ...SUPPLEMENTARY_LOCALITIES.map((l) => l.name),
    "Pune", "PCMC", "Pimpri Chinchwad", "Pimpri-Chinchwad",
  ];
  for (const i of inside.sort((a, b) => b.length - a.length)) {
    if (hasPhrase(text, i)) return { state: "PASS", matched: i, reason: "IN_SERVICE_AREA" };
  }
  return { state: "UNCLEAR", matched: null, reason: "LOCATION_NOT_RECOGNISED" };
}
