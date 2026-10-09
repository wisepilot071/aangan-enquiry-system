import { getDbHandle } from "../src/db/client";

async function main() {
  const h = await getDbHandle();
  console.log(`Migrations applied (${h.kind}).`);
  await h.close();
  
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
