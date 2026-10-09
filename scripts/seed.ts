import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDbHandle } from "../src/db/client";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/modules/authentication";

async function main() {
  /**
   * Creates the first admin. Production records are never seeded; demo data is created only through the
   * in-app simulator (clearly labelled DEMO). Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD_HASH;
   * in development, if absent, a random password is generated and printed once.
   */
  const h = await getDbHandle();
  const email = (process.env.ADMIN_EMAIL || "admin@aangan.local").toLowerCase();
  const [existing] = await h.db.select().from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`Admin ${email} already exists — nothing to do.`);
  } else {
    let hash = process.env.ADMIN_PASSWORD_HASH;
    let generated: string | undefined;
    if (!hash) {
      if (process.env.NODE_ENV === "production") throw new Error("ADMIN_PASSWORD_HASH is required in production (npm run admin:hash -- '<password>')");
      generated = crypto.randomBytes(12).toString("base64url");
      hash = hashPassword(generated);
    }
    await h.db.insert(users).values({ email, passwordHash: hash, role: "admin" });
    console.log(`Created admin ${email}`);
    if (generated) console.log(`Generated development password (shown once, not stored): ${generated}`);
  }
  await h.close();
  
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
