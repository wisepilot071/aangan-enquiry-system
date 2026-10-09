import { telegramWebhookSecret } from "../src/modules/notifications/telegram-bot";

/**
 * Registers (or with --remove, removes) the bot's webhook so it answers messages.
 *   npm run telegram:webhook -- https://<your-app>/api/telegram/webhook
 * While a webhook is set, Telegram's getUpdates stops working (by design).
 */
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const arg = process.argv[2];
  const api = (m: string, body: object) => fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (arg === "--remove") { console.log(JSON.stringify(await api("deleteWebhook", {}))); return; }
  if (!arg?.startsWith("https://")) throw new Error("Usage: npm run telegram:webhook -- https://<app>/api/telegram/webhook   (or --remove)");
  const r = await api("setWebhook", { url: arg, secret_token: telegramWebhookSecret(token), allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false }) as { ok: boolean; description?: string };
  console.log(r.ok ? `Webhook set to ${arg}` : `Failed: ${r.description}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
