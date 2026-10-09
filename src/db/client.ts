import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;
export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  /** Cheap liveness probe. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** Embedded Postgres (PGlite) for local dev, demos and tests — real Postgres semantics, no install needed. */
export function createPgliteHandle(dataDir?: string): DbHandle {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db, kind: "pglite",
    migrate: () => migratePglite(drizzlePglite(client, { schema }), { migrationsFolder: MIGRATIONS }),
    ping: async () => { await client.query("select 1"); },
    close: () => client.close(),
  };
}

export function createPostgresHandle(url: string): DbHandle {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  return {
    db, kind: "postgres",
    migrate: () => migratePg(drizzlePg(pool, { schema }), { migrationsFolder: MIGRATIONS }),
    ping: async () => { await pool.query("select 1"); },
    close: () => pool.end(),
  };
}

const g = globalThis as unknown as { __aanganDb?: Promise<DbHandle> };

/** Process-wide handle. DATABASE_URL → Postgres; otherwise PGlite persisted under ./data (dev/demo only). */
export function getDbHandle(): Promise<DbHandle> {
  g.__aanganDb ??= (async () => {
    const url = process.env.DATABASE_URL?.trim();
    const h = url ? createPostgresHandle(url) : createPgliteHandle(process.env.PGLITE_DATA_DIR?.trim() || path.join(process.cwd(), "data", "pglite"));
    await h.migrate();
    return h;
  })();
  return g.__aanganDb;
}
export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}
export function resetDbHandleForTests() { g.__aanganDb = undefined; }
