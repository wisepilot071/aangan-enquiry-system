import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { handleTelegramUpdate, replyFor, telegramWebhookSecret } from "@/modules/notifications/telegram-bot";
import { testDb } from "../helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await testDb(); });
afterAll(() => h.close());

const TOKEN = "123456:TEST-TOKEN-NOT-REAL";
const ok = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

describe("Telegram bot answers messages (so it does not look broken)", () => {
  it("replies with who it is and this chat's id, says honestly it is not connected yet, and records the chat", async () => {
    const f = ok();
    const r = await handleTelegramUpdate(h.db, { message: { chat: { id: 987654321, type: "private", first_name: "Sagar" }, text: "hi" } }, { botToken: TOKEN, fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ replied: true, chatId: 987654321 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe(987654321);
    expect(body.text).toContain("987654321");
    expect(body.text).toContain("not connected yet");
    expect(body.text).toContain("lead-alert bot");
    const seen = await h.db.select().from(auditEvents).where(eq(auditEvents.action, "telegram.chat_seen"));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
  it("tells the connected chat that it is connected", () => {
    expect(replyFor(555, "555")).toContain("✅ This chat is connected");
    expect(replyFor(555, "999")).toContain("not connected yet");
    expect(replyFor(-100123, undefined)).toContain("-100123"); // group ids are negative
  });
  it("ignores bots, remembers a group the bot is added to without chatting, and survives Telegram being down", async () => {
    const f = ok();
    expect(await handleTelegramUpdate(h.db, { message: { chat: { id: 1 }, from: { is_bot: true }, text: "x" } }, { botToken: TOKEN, fetchImpl: f as unknown as typeof fetch })).toEqual({ replied: false });
    expect(await handleTelegramUpdate(h.db, { my_chat_member: { chat: { id: -1001, type: "supergroup", title: "Designers" } } }, { botToken: TOKEN, fetchImpl: f as unknown as typeof fetch })).toEqual({ replied: false, chatId: -1001 });
    expect(f).not.toHaveBeenCalled();
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await handleTelegramUpdate(h.db, { message: { chat: { id: 2, type: "private" }, text: "/start" } }, { botToken: TOKEN, fetchImpl: down as unknown as typeof fetch })).toEqual({ replied: false, chatId: 2 });
    expect(await handleTelegramUpdate(h.db, {}, { botToken: TOKEN })).toEqual({ replied: false });
  });
  it("the webhook secret is deterministic, token-specific and header-safe", () => {
    const s = telegramWebhookSecret(TOKEN);
    expect(s).toBe(telegramWebhookSecret(TOKEN));
    expect(s).not.toBe(telegramWebhookSecret("other:token"));
    expect(s).toMatch(/^[a-f0-9]{64}$/);
    expect(s).not.toContain(TOKEN);
  });
});
