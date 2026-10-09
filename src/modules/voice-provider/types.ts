import { z } from "zod";

/**
 * INTERNAL, provider-neutral event contract. This is our own shape — it is NOT Vaani's payload.
 * A real adapter must map the provider's verified events onto this contract.
 */
export const EVENT_TYPES = [
  "call.started", "call.responded", "call.ended", "call.completed", "call.missed", "call.disconnected", "call.failed",
] as const;

const iso = z.string().datetime({ offset: true });

export const ProviderEventSchema = z.object({
  eventId: z.string().min(1).max(200).optional(),
  type: z.enum(EVENT_TYPES),
  /** Absent means inbound. Outbound calls are operator test calls: stored, costed, but never qualified or counted as enquiries. */
  direction: z.enum(["inbound", "outbound"]).optional(),
  providerCallId: z.string().min(1).max(200),
  occurredAt: iso,
  fromNumber: z.string().min(3).max(32).optional(),
  toNumber: z.string().min(3).max(32).optional(),
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  /** First time the agent actually spoke, as reported by the provider. Never inferred from webhook arrival. */
  firstAgentResponseAt: iso.optional(),
  durationSec: z.number().int().min(0).max(86_400).optional(),
  transcript: z.array(z.object({
    role: z.enum(["agent", "caller"]),
    text: z.string().max(4000),
    at: iso.optional(),
  })).max(500).optional(),
  /** True when only the raw transcript was available (the provider's analysis was late), so answers must be read from it. */
  transcriptOnly: z.boolean().optional(),
  /** Provider/LLM structured extraction. Untrusted: validated with FactsSchema before use. */
  structuredFacts: z.unknown().optional(),
  summary: z.string().max(4000).optional(),
  cost: z.object({
    amount: z.number().nonnegative().max(1e7),
    /** ISO currency, or the provider's own unit (e.g. "CREDITS") — non-INR units are reported separately, never converted. */
    currency: z.string().min(3).max(8),
  }).optional(),
  failureReason: z.string().max(200).optional(),
});
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export type VerifyResult = { ok: true } | { ok: false; reason: string };
export type ParseResult =
  | { ok: true; event: ProviderEvent }
  | { ok: true; ignored: true; note: string } // valid provider event that carries nothing we store (recorded, acknowledged)
  | { ok: false; reason: string };

export type ProviderState = "ready" | "pending_integration" | "unconfigured";

export interface ProviderStatus {
  provider: string;
  mode: "mock" | "live";
  state: ProviderState;
  detail: string;
  /** What this adapter genuinely supports (never assumed for an unverified provider). */
  capabilities: {
    webhookSignature: boolean;
    transcripts: boolean;
    structuredExtraction: boolean;
    providerCost: boolean;
    firstResponseTimestamp: boolean;
  };
}

export interface VoiceProvider {
  readonly id: "mock" | "vaani";
  status(): ProviderStatus;
  /** Fail closed: anything but ok:true must be rejected by the caller. */
  verifyWebhook(input: { rawBody: string; headers: Headers | Record<string, string | undefined>; now: Date; url?: string }): VerifyResult;
  parseEvent(rawBody: string): ParseResult;
  /** Optional: pull authoritative data from the provider's API (best effort, must never throw). */
  enrichEvent?(event: ProviderEvent, opts?: { transcriptFallback?: boolean }): Promise<ProviderEvent>;
}

export function header(h: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : undefined;
}
