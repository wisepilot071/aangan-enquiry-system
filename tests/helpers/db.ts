import { createPgliteHandle, type DbHandle } from "@/db/client";

/** Fresh, isolated, in-memory Postgres (PGlite) with all migrations applied. Never touches ./data. */
export async function testDb(): Promise<DbHandle> {
  const h = createPgliteHandle();
  await h.migrate();
  return h;
}
