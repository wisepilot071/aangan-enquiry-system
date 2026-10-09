export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; category: "transient" | "rate_limited" | "permanent"; retryAfterMs?: number; detail: string };

export interface TelegramSender {
  send(text: string): Promise<SendResult>;
}

/**
 * Telegram Bot API `sendMessage` (https://core.telegram.org/bots/api#sendmessage).
 * Plain text only (no parse_mode) so caller-supplied words can never be interpreted as markup.
 * The bot token is only ever used to build the request URL; it is never logged or returned.
 */
export function createTelegramSender(opts: {
  token: string; chatId: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): TelegramSender {
  const f = opts.fetchImpl ?? fetch;
  return {
    async send(text) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
      try {
        const res = await f(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: opts.chatId, text, disable_web_page_preview: true }),
          signal: ctl.signal,
        });
        let body: { ok?: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } } = {};
        try { body = await res.json(); } catch { /* non-JSON error page */ }
        if (res.ok && body.ok && body.result?.message_id !== undefined) return { ok: true, messageId: String(body.result.message_id) };
        if (res.status === 429) return { ok: false, category: "rate_limited", retryAfterMs: (body.parameters?.retry_after ?? 1) * 1000, detail: "telegram_rate_limited" };
        if (res.status >= 500) return { ok: false, category: "transient", detail: `telegram_http_${res.status}` };
        return { ok: false, category: "permanent", detail: `telegram_http_${res.status}` };
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        return { ok: false, category: "transient", detail: aborted ? "telegram_timeout" : "telegram_network_error" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
