import { eq } from "drizzle-orm";
import { getDbHandle } from "../src/db/client";
import { enquiries } from "../src/db/schema";
import { deleteEnquiry, purgeOldTranscripts } from "../src/modules/enquiries/privacy";

/**
 *   npm run privacy -- purge-transcripts <days>
 *   npm run privacy -- delete <enquiry-uuid> --confirm
 */
async function main() {
  const [cmd, arg, flag] = process.argv.slice(2);
  const h = await getDbHandle();
  try {
    if (cmd === "purge-transcripts" && arg) {
      console.log(`Purged transcripts from ${await purgeOldTranscripts(h.db, Number(arg), "cli")} enquiries.`);
    } else if (cmd === "delete" && arg) {
      const [e] = await h.db.select({ id: enquiries.id }).from(enquiries).where(eq(enquiries.id, arg));
      if (!e) { console.error("No such enquiry."); process.exitCode = 1; return; }
      if (flag !== "--confirm") { console.error("This permanently deletes the enquiry and its notifications, costs and tasks. Re-run with --confirm."); process.exitCode = 1; return; }
      await deleteEnquiry(h.db, arg, "cli");
      console.log("Deleted.");
    } else {
      console.error("Usage: npm run privacy -- purge-transcripts <days> | delete <enquiry-uuid> --confirm");
      process.exitCode = 1;
    }
  } finally {
    await h.close();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
