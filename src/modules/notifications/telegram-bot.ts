import crypto from "node:crypto";
import type { Db } from "@/db/client";
import { audit } from "@/modules/audit";

/**
 * The alert bot is one-way (it pushes enquiries to designers), but a silent bot looks broken. This tiny handler makes it
 * answer any message with who it is and the chat's id, and whether this chat is the one connected to the dashboard.
 * Telegram signs webhook calls with a secret token header; we derive that secret from the bot token, so no extra setting is needed.
 */
export const telegramWebhookSecret = (botToken: string) => crypto.createHash("sha256").update(`aangan-telegram-webhook:${botToken}`).digest("hex");

export interface TelegramUpdate {
  message?: { chat?: { id?: number; type?: string; title?: string; first_name?: string }; text?: string; from?: { is_bot?: boolean } };
  my_chat_member?: { chat?: { id?: number; type?: string; title?: string } };
}

export function replyFor(chatId: number, configuredChatId: string | undefined): string {
  const connected = configuredChatId !== undefined && String(chatId) === configuredChatId;
  return [
    "Namaste! I am the lead-alert bot of Aangan Studio.",
    "I send new qualified enquiries and urgent complaints to this chat. I do not answer questions, so please do not expect a conversation.",
    `This chat's ID is: ${chatId}`,
    connected ? "✅ This chat is connected to the dashboard. You will receive the alerts here." : "⚠️ This chat is not connected yet. Please share the ID above with the dashboard administrator.",
  ].join("\n\n");
}

export async function handleTelegramUpdate(
  db: Db, update: TelegramUpdate, deps: { botToken: string; configuredChatId?: string; fetchImpl?: typeof fetch },
): Promise<{ replied: boolean; chatId?: number }> {
  const chat = update.message?.chat ?? update.my_chat_member?.chat;
  if (!chat?.id || update.message?.from?.is_bot) return { replied: false };
  await audit(db, { actor: "telegram", action: "telegram.chat_seen", entityType: "telegram", entityId: String(chat.id), detail: { chatId: chat.id, type: chat.type, title: chat.title } });
  if (!update.message) return { replied: false, chatId: chat.id }; // e.g. the bot was added to a group: remember it, say nothing
  const f = deps.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await f(`https://api.telegram.org/bot${deps.botToken}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ chat_id: chat.id, text: replyFor(chat.id, deps.configuredChatId), disable_web_page_preview: true }),
    });
    return { replied: res.ok, chatId: chat.id };
  } catch {
    return { replied: false, chatId: chat.id };
  } finally {
    clearTimeout(timer);
  }
}
