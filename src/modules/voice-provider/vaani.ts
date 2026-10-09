import crypto from "node:crypto";
import { header, type ParseResult, type ProviderEvent, type ProviderStatus, type VerifyResult, type VoiceProvider } from "./types";
import { createVaaniClient, type VaaniClient, type VaaniCallDetails } from "./vaani-client";
import { entitiesToFacts, mapVaaniWebhook, parseVaaniTranscript } from "./vaani-mapper";

export interface VaaniProviderConfig {
  apiKey?: string;
  webhookToken?: string;
  baseUrl?: string;
  client?: VaaniClient;
}

const safeEqual = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Vaani adapter, built from docs.vaanivoice.ai.
 *
 * Webhook authentication: Vaani documents NO signature scheme. This adapter therefore requires a long random secret in the
 * webhook URL (`?token=…`, or an `x-webhook-token` / Bearer header if the sender can set one), compared in constant time, and
 * fails closed without it. On top of that, call_postprocessing content is replaced by data pulled from Vaani's authenticated
 * API (call_details), so a forged payload cannot inject transcript content for a real call. This is OUR protection, not a
 * Vaani feature — see docs/vaani-integration.md.
 */
export function createVaaniProvider(cfg: VaaniProviderConfig = {}): VoiceProvider & { client: VaaniClient | null } {
  const client = cfg.client ?? (cfg.apiKey ? createVaaniClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }) : null);
  const configured = Boolean(client && cfg.webhookToken);

  return {
    id: "vaani",
    client,
    status(): ProviderStatus {
      return {
        provider: "vaani", mode: "live", state: configured ? "ready" : "unconfigured",
        detail: configured
          ? "Vaani adapter configured from docs.vaanivoice.ai. Not yet verified on a real inbound call: webhooks carry no timestamps or signature, so response time is unmeasurable."
          : "Vaani is selected but VAANI_API_KEY and/or VAANI_WEBHOOK_TOKEN are missing. All webhooks are rejected.",
        capabilities: { webhookSignature: false, transcripts: true, structuredExtraction: true, providerCost: true, firstResponseTimestamp: false },
      };
    },
    verifyWebhook({ headers, url }): VerifyResult {
      if (!cfg.webhookToken) return { ok: false, reason: "vaani_webhook_token_not_configured" };
      let supplied: string | null | undefined = header(headers, "x-webhook-token");
      const auth = header(headers, "authorization");
      if (!supplied && auth?.toLowerCase().startsWith("bearer ")) supplied = auth.slice(7).trim();
      if (!supplied && url) { try { supplied = new URL(url, "http://localhost").searchParams.get("token"); } catch { /* ignore */ } }
      if (!supplied) return { ok: false, reason: "missing_webhook_token" };
      return safeEqual(supplied, cfg.webhookToken) ? { ok: true } : { ok: false, reason: "webhook_token_mismatch" };
    },
    parseEvent(rawBody): ParseResult {
      let json: unknown;
      try { json = JSON.parse(rawBody); } catch { return { ok: false, reason: "malformed_json" }; }
      const m = mapVaaniWebhook(json, new Date());
      if (m.kind === "invalid") return { ok: false, reason: `invalid_event: ${m.reason}` };
      if (m.kind === "ignored") return { ok: true, ignored: true, note: m.note };
      return { ok: true, event: m.event };
    },
    async enrichEvent(event): Promise<ProviderEvent> {
      if (!client || event.type !== "call.completed") return event;
      let out = event;
      try {
        const d: VaaniCallDetails = await client.getCallDetails(event.providerCallId);
        if (d.status === "processing" || d.post_processing_status === "in_processing") throw new Error("still processing"); // keep the webhook's own data
        const entity = d.entity && typeof d.entity === "object" && Object.keys(d.entity).length ? d.entity : undefined;
        const transcript = typeof d.transcription === "string" ? parseVaaniTranscript(d.transcription) : [];
        out = {
          ...out,
          ...(transcript.length ? { transcript } : {}),
          ...(entity ? { structuredFacts: entitiesToFacts(entity, new Date(out.occurredAt)) } : {}),
          ...(typeof d.summary === "string" && d.summary && !/not available/i.test(d.summary) ? { summary: d.summary.slice(0, 4000) } : {}),
        };
      } catch { /* keep the webhook's own (token-protected) data */ }
      try {
        const hist = await client.getCallHistory(1, 50);
        const row = hist.data?.find((r) => r.call_id === event.providerCallId);
        if (row) {
          out = {
            ...out,
            ...(row.from_number && !out.fromNumber ? { fromNumber: row.from_number } : {}),
            ...(row.to_number ? { toNumber: row.to_number } : {}),
            ...(typeof row.call_cost === "number" && row.call_cost >= 0 ? { cost: { amount: row.call_cost, currency: "CREDITS" } } : {}),
          };
        }
      } catch { /* cost stays unknown; never guessed */ }
      return out;
    },
  };
}
