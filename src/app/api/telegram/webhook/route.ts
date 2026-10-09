import crypto from "node:crypto";
import { getDb } from "@/db/client";
import { clientIp } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { json, safe } from "@/lib/http";
import { createRateLimiter } from "@/modules/authentication";
import { handleTelegramUpdate, telegramWebhookSecret, type TelegramUpdate } from "@/modules/notifications/telegram-bot";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter(120, 60_000);

const same = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/** Telegram → us. Authenticated by the secret-token header Telegram attaches (set when the webhook is registered). */
export const POST = safe(async (req: Request) => {
  const cfg = getConfig();
  if (!cfg.TELEGRAM_BOT_TOKEN) return json({ error: "telegram_not_configured" }, 409);
  if (!limiter.allow(clientIp(req))) return json({ error: "rate_limited" }, 429);
  const supplied = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!same(supplied, telegramWebhookSecret(cfg.TELEGRAM_BOT_TOKEN))) return json({ error: "unauthorized" }, 401);
  const text = await req.text();
  if (text.length > 64 * 1024) return json({ error: "payload_too_large" }, 413);
  let update: TelegramUpdate;
  try { update = JSON.parse(text); } catch { return json({ ok: true }); } // never make Telegram retry garbage
  await handleTelegramUpdate(await getDb(), update, { botToken: cfg.TELEGRAM_BOT_TOKEN, configuredChatId: cfg.TELEGRAM_CHAT_ID });
  return json({ ok: true });
});
