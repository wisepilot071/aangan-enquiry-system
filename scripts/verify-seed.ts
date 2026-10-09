import fs from "node:fs";
import path from "node:path";
import { APPROVED_PRICING_RESPONSE } from "../src/modules/pricing-guardrails";

/**
 * Checks that the application's source-of-truth matches the supplied seed files.
 * Usage: SEED_DIR="C:/path/to/Mesa case 03" npm run verify:seed
 */
const dir = process.env.SEED_DIR || path.join(process.cwd(), "..");
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
let failed = false;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); failed ||= !ok; };

check("knowledge/services.md identical to supplied services.md", read("services.md") === fs.readFileSync("knowledge/services.md", "utf8"));
check("knowledge/qualified.md identical to supplied qualified.md", read("qualified.md") === fs.readFileSync("knowledge/qualified.md", "utf8"));
check("approved pricing response appears verbatim in pricing.md", read("pricing.md").includes(APPROVED_PRICING_RESPONSE));
check("pricing.md is NOT copied into this repository", !fs.existsSync("knowledge/pricing.md"));
check("PDF present", fs.existsSync(path.join(dir, "Aangan_Sep 2026_Enquiries.pdf")));
process.exit(failed ? 1 : 0);
