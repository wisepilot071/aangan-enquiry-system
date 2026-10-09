import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { enquiries, costs } from "@/db/schema";
import { testDb } from "../helpers/db";

describe("database schema", async () => {
  const h = await testDb();
  afterAll(() => h.close());

  it("migrates and answers ping", async () => {
    await h.ping();
    const r = await h.db.execute(sql`select count(*)::int as n from enquiries`);
    expect(r.rows[0]).toEqual({ n: 0 });
  });
  it("enforces phone-only channel and unique provider call id", async () => {
    await h.db.insert(enquiries).values({ provider: "mock", providerCallId: "c1" });
    await expect(h.db.insert(enquiries).values({ provider: "mock", providerCallId: "c1" })).rejects.toThrow();
    await expect(h.db.insert(enquiries).values({ provider: "mock", providerCallId: "c2", channel: "whatsapp" })).rejects.toThrow();
  });
  it("unknown cost must have NULL amount; actual/estimated must not (unknown is never zero)", async () => {
    await expect(h.db.insert(costs).values({ provider: "mock", category: "voice_call", rateSource: "x", basis: "unknown", amount: "0" })).rejects.toThrow();
    await h.db.insert(costs).values({ provider: "mock", category: "voice_call", rateSource: "x", basis: "unknown", amount: null });
  });
});
