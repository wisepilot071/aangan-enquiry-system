import { z } from "zod";

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(emptyToUndef, s.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: opt(z.string().url()),
  /** Postgres connection string. If unset, an embedded PGlite database in ./data is used (dev/demo only). */
  DATABASE_URL: opt(z.string()),
  SESSION_SECRET: opt(z.string().min(32, "SESSION_SECRET must be at least 32 characters")),
  /** Initial admin created by `npm run db:seed` — password supplied as a scrypt hash. */
  ADMIN_EMAIL: opt(z.string().email()),
  ADMIN_PASSWORD_HASH: opt(z.string()),
  /** mock | vaani — "vaani" is pending until the exact product/API is verified. */
  VOICE_PROVIDER: z.enum(["mock", "vaani"]).default("mock"),
  /** "login" (default): email + password. "open": NO sign-in — anyone with the URL gets the role below. */
  AUTH_MODE: z.enum(["login", "open"]).default("login"),
  /** Role everyone gets in open mode. viewer = read-only (no transcripts, no calls, no settings). */
  OPEN_ACCESS_ROLE: z.enum(["viewer", "operator", "admin"]).default("viewer"),
  /** Shared secret for HMAC-signing mock webhooks (our own mock contract, not Vaani's). */
  MOCK_WEBHOOK_SECRET: opt(z.string().min(16)),
  /** Vaani (docs.vaanivoice.ai). The key is sent as the X-API-Key header; never commit it. */
  VAANI_API_KEY: opt(z.string().min(12)),
  /** UUID of the agent created by `npm run vaani:setup`. Needed to place calls. */
  VAANI_AGENT_ID: opt(z.string().uuid()),
  /** Secret token appended to the webhook URL registered in Vaani (?token=...). Vaani documents no webhook signature. */
  VAANI_WEBHOOK_TOKEN: opt(z.string().min(24, "VAANI_WEBHOOK_TOKEN must be at least 24 characters")),
  VAANI_API_BASE: opt(z.string().url()),
  TELEGRAM_BOT_TOKEN: opt(z.string()),
  TELEGRAM_CHAT_ID: opt(z.string()),
  /** Set to "false" to forbid mock-mode Telegram records when credentials are missing. */
  ALLOW_DEMO_MODE: z.enum(["true", "false"]).default("true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  mode: "mock" | "live";
  telegramConfigured: boolean;
  vaaniConfigured: boolean;
  warnings: string[];
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const c = parsed.data;
  const warnings: string[] = [];
  const telegramConfigured = Boolean(c.TELEGRAM_BOT_TOKEN && c.TELEGRAM_CHAT_ID);
  if (!telegramConfigured) warnings.push("Telegram is not configured: handoffs are recorded as 'unavailable' (or 'mock_sent' in demo mode).");
  if (!c.SESSION_SECRET) {
    if (c.NODE_ENV === "production") throw new ConfigError("SESSION_SECRET is required in production");
    warnings.push("SESSION_SECRET is not set: using an insecure per-process development secret.");
  }
  if (c.NODE_ENV === "production" && !c.DATABASE_URL) throw new ConfigError("DATABASE_URL is required in production");
  if (c.NODE_ENV === "production" && c.VOICE_PROVIDER === "mock") {
    warnings.push("VOICE_PROVIDER=mock in production: no real calls will be processed.");
  }
  if (c.AUTH_MODE === "open") {
    warnings.push(`AUTH_MODE=open: there is NO sign-in. Anyone with the URL has the "${c.OPEN_ACCESS_ROLE}" role and can see caller names and phone numbers${c.OPEN_ACCESS_ROLE === "viewer" ? "" : ", transcripts and operator actions"}.`);
  }
  const vaaniConfigured = Boolean(c.VAANI_API_KEY && c.VAANI_WEBHOOK_TOKEN);
  if (c.VOICE_PROVIDER === "vaani") {
    if (!c.VAANI_API_KEY) warnings.push("VOICE_PROVIDER=vaani but VAANI_API_KEY is missing: all Vaani webhooks and calls will be refused.");
    if (!c.VAANI_WEBHOOK_TOKEN) warnings.push("VAANI_WEBHOOK_TOKEN is missing: webhooks cannot be authenticated, so all are rejected (fail closed).");
    if (!c.VAANI_AGENT_ID) warnings.push("VAANI_AGENT_ID is not set: run `npm run vaani:setup`, then set it. Outbound test calls are unavailable until then.");
  }
  if (c.VOICE_PROVIDER === "mock" && !c.MOCK_WEBHOOK_SECRET) {
    warnings.push("MOCK_WEBHOOK_SECRET is not set: signed mock webhooks are disabled (in-app simulator still works).");
  }
  return { ...c, mode: c.VOICE_PROVIDER === "mock" ? "mock" : "live", telegramConfigured, vaaniConfigured, warnings };
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
export function resetConfigForTests() { cached = undefined; }
