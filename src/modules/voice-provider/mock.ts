import crypto from "node:crypto";
import {
  ProviderEventSchema, header,
  type ParseResult, type ProviderStatus, type VerifyResult, type VoiceProvider,
} from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
export const MOCK_TIMESTAMP_HEADER = "x-mock-timestamp";
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Signature scheme of OUR mock provider only: hex HMAC-SHA256 over `${timestamp}.${rawBody}`. */
export function signMockPayload(secret: string, timestampMs: number, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`).digest("hex");
}

export function createMockProvider(opts: { secret?: string }): VoiceProvider {
  return {
    id: "mock",
    status(): ProviderStatus {
      return {
        provider: "mock", mode: "mock", state: "ready",
        detail: "MOCK provider: simulated calls only. No real telephony, no real Vaani connection.",
        capabilities: { webhookSignature: Boolean(opts.secret), transcripts: true, structuredExtraction: true, providerCost: true, firstResponseTimestamp: true },
      };
    },
    verifyWebhook({ rawBody, headers, now }): VerifyResult {
      if (!opts.secret) return { ok: false, reason: "mock_webhook_secret_not_configured" };
      const sig = header(headers, MOCK_SIGNATURE_HEADER);
      const ts = Number(header(headers, MOCK_TIMESTAMP_HEADER));
      if (!sig || !Number.isFinite(ts)) return { ok: false, reason: "missing_signature_or_timestamp" };
      if (Math.abs(now.getTime() - ts) > REPLAY_WINDOW_MS) return { ok: false, reason: "timestamp_outside_replay_window" };
      const expected = signMockPayload(opts.secret, ts, rawBody);
      const a = Buffer.from(sig, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
      return { ok: true };
    },
    parseEvent(rawBody): ParseResult {
      let json: unknown;
      try { json = JSON.parse(rawBody); } catch { return { ok: false, reason: "malformed_json" }; }
      const r = ProviderEventSchema.safeParse(json);
      if (!r.success) return { ok: false, reason: `invalid_event: ${r.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)").join(", ")}` };
      return { ok: true, event: r.data };
    },
  };
}
