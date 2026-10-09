import type { Db } from "@/db/client";
import { audit } from "@/modules/audit";
import type { ProviderEvent, VoiceProvider } from "@/modules/voice-provider/types";
import type { VaaniClient } from "@/modules/voice-provider/vaani-client";
import { VaaniApiError } from "@/modules/voice-provider/vaani-client";
import { ingestEvent, type IngestOutcome } from "./ingest";

/** E.164: "+", country code (1–9), up to 14 more digits. No spaces, dashes or brackets. */
export const E164 = /^\+[1-9]\d{7,14}$/;

export const maskNumber = (n: string) => `${n.slice(0, 3)}•••••${n.slice(-3)}`;

export class OutboundError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

/**
 * Places an outbound TEST call through Vaani (POST /api/trigger-call/). The agent greets the person as a test call.
 * Safeguards: operator role (enforced by the route), E.164 validation, explicit consent flag, Vaani's Do-Not-Disturb check
 * left ON, audit trail with a masked number, and the resulting record is flagged outbound (never an enquiry).
 */
export async function placeTestCall(
  db: Db, client: VaaniClient, agentId: string, input: { contactNumber: string; name: string; consent: boolean }, actor: string,
): Promise<{ callId: string; liveCaptionsUrl?: string }> {
  if (!input.consent) throw new OutboundError("consent_required", "Confirm that the person has agreed to receive this call.");
  if (!E164.test(input.contactNumber)) throw new OutboundError("invalid_number", "Use international format, e.g. +919876543210 (no spaces or dashes).");
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new OutboundError("name_required", "A name is required.");

  let res;
  try {
    res = await client.triggerCall({
      agentId, contactNumber: input.contactNumber, name, dndCheckSkipped: false,
      modifyAgent: { persona: { identity: { greeting_message: {
        agent_message: `Hello ${name}, this is the virtual assistant of Aangan Studio, calling for a short test of our phone system. Is this a good moment, please?`,
        interruptible: true,
      } } } },
    });
  } catch (e) {
    const err = e as VaaniApiError;
    await audit(db, { actor, action: "call.outbound_failed", entityType: "call", detail: { to: maskNumber(input.contactNumber), category: err.category, status: err.status, message: err.message } });
    throw new OutboundError(`vaani_${err.category ?? "error"}`, err.message, err.category === "validation" ? 422 : err.category === "auth" ? 502 : 502);
  }
  const callId = res.output?.call_id;
  if (!res.success || !callId) {
    await audit(db, { actor, action: "call.outbound_failed", entityType: "call", detail: { to: maskNumber(input.contactNumber), message: String(res.message ?? res.error ?? "no call id").slice(0, 200) } });
    throw new OutboundError("vaani_rejected", `Vaani did not start the call: ${String(res.message ?? res.error ?? "no call id returned").slice(0, 160)}`, 502);
  }
  await audit(db, { actor, action: "call.outbound_requested", entityType: "call", entityId: callId, detail: { to: maskNumber(input.contactNumber), agentId } });
  // Make the call visible immediately; the webhook (or manual sync) completes it later.
  const placed: ProviderEvent = { type: "call.started", direction: "outbound", providerCallId: callId, occurredAt: new Date().toISOString(), startedAt: new Date().toISOString(), fromNumber: input.contactNumber };
  await ingestEvent(db, "vaani", placed, `placed:${callId}`);
  return { callId, liveCaptionsUrl: res.output?.live_captions_url };
}

/**
 * Pulls a finished call from Vaani's API and ingests it, for local development (no public webhook URL) or when a
 * webhook was missed. Safe to repeat: an already-completed call is reported as a duplicate.
 */
export async function syncVaaniCall(db: Db, provider: VoiceProvider, callId: string, actor: string): Promise<IngestOutcome> {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(callId)) throw new OutboundError("invalid_call_id", "That does not look like a Vaani call id.");
  if (!provider.enrichEvent) throw new OutboundError("not_supported", "This provider cannot be synced.", 501);
  const base: ProviderEvent = {
    type: "call.completed", direction: /^outbound/i.test(callId) ? "outbound" : "inbound", providerCallId: callId,
    occurredAt: new Date().toISOString(),
  };
  const event = await provider.enrichEvent(base);
  if (!event.transcript?.length && event.structuredFacts === undefined) {
    throw new OutboundError("not_ready", "Vaani has no transcript for this call yet (post-processing may still be running, or the id is wrong). Try again in a minute.", 409);
  }
  await audit(db, { actor, action: "call.sync_requested", entityType: "call", entityId: callId });
  return ingestEvent(db, "vaani", event, `sync:${callId}`);
}
