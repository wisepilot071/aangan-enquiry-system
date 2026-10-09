import { newSession, processCallerTurn, type Turn } from "@/modules/conversation/session";
import type { Facts } from "@/modules/qualification/facts";
import type { ProviderEvent } from "@/modules/voice-provider/types";

export interface SimulationInput {
  callId: string;
  callerLines: { agentQuestion?: string; text: string }[];
  fromNumber?: string;
  startedAt: Date;
  /** Simulated delay until the agent speaks. Clearly a simulation parameter, never real latency. */
  firstResponseDelaySec?: number | null;
  durationSec?: number;
  /** Simulated provider-reported cost, supplied by the person running the demo (never invented here). */
  providerCostInr?: number;
  /** Supply the final facts as provider "structured extraction" instead of relying on transcript extraction. */
  factOverrides?: Partial<Facts>;
  /** missed | disconnected simulate non-completed outcomes. */
  outcome?: "completed" | "missed" | "disconnected" | "failed";
}

const iso = (d: Date) => d.toISOString();
const add = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000);

/** Builds the provider-neutral event sequence for a simulated call, using the real conversation engine. */
export function simulateCallEvents(input: SimulationInput): { events: ProviderEvent[]; transcript: Turn[] } {
  const outcome = input.outcome ?? "completed";
  const base = { providerCallId: input.callId, fromNumber: input.fromNumber };
  const started: ProviderEvent = { ...base, eventId: `${input.callId}:started`, type: "call.started", occurredAt: iso(input.startedAt), startedAt: iso(input.startedAt) };

  if (outcome === "missed") {
    return { transcript: [], events: [{ ...base, eventId: `${input.callId}:missed`, type: "call.missed", occurredAt: iso(input.startedAt), startedAt: iso(input.startedAt) }] };
  }

  const events: ProviderEvent[] = [started];
  let state = newSession();
  if (input.firstResponseDelaySec !== null) {
    const at = add(input.startedAt, input.firstResponseDelaySec ?? 3);
    events.push({ ...base, eventId: `${input.callId}:responded`, type: "call.responded", occurredAt: iso(at), firstAgentResponseAt: iso(at) });
  }

  let lastResult: ReturnType<typeof processCallerTurn> | undefined;
  const lines = outcome === "disconnected" ? input.callerLines.slice(0, 1) : input.callerLines;
  for (const l of lines) {
    state = { ...state, lastAgentQuestion: l.agentQuestion ?? state.lastAgentQuestion };
    lastResult = processCallerTurn(state, l.text, { now: input.startedAt, factOverrides: input.factOverrides });
    state = lastResult.state;
  }
  const duration = input.durationSec ?? Math.max(30, lines.length * 45);
  const end = add(input.startedAt, duration);
  const transcript = state.turns;

  if (outcome === "disconnected" || outcome === "failed") {
    events.push({ ...base, eventId: `${input.callId}:${outcome}`, type: outcome === "failed" ? "call.failed" : "call.disconnected",
      occurredAt: iso(end), endedAt: iso(end), durationSec: duration, failureReason: outcome === "failed" ? "simulated provider failure" : undefined });
    return { events, transcript };
  }

  events.push({
    ...base, eventId: `${input.callId}:completed`, type: "call.completed", occurredAt: iso(end), endedAt: iso(end), durationSec: duration,
    transcript: transcript.map((t) => ({ role: t.role, text: t.text })),
    ...(input.factOverrides ? { structuredFacts: { ...state.facts } } : {}),
    ...(input.providerCostInr !== undefined ? { cost: { amount: input.providerCostInr, currency: "INR" } } : {}),
  });
  return { events, transcript };
}
