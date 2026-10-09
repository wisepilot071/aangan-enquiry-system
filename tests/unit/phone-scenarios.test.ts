import { describe, expect, it } from "vitest";
import { newSession, processCallerTurn, type TurnResult } from "@/modules/conversation/session";
import { PHONE_SCENARIOS } from "../fixtures/phone-transcripts";

function run(s: (typeof PHONE_SCENARIOS)[number]): TurnResult {
  let state = newSession();
  let last: TurnResult | undefined;
  for (const turn of s.turns) {
    state = { ...state, lastAgentQuestion: turn.agent ?? state.lastAgentQuestion };
    last = processCallerTurn(state, turn.caller, { now: new Date(s.date), factOverrides: s.overrides });
    state = last.state;
  }
  return last!;
}

describe("regression: PDF phone-call transcripts (T01–T20)", () => {
  for (const s of PHONE_SCENARIOS) {
    it(`${s.id} — ${s.title}`, () => {
      const r = run(s);
      const a = r.assessment;
      expect(a.disposition, JSON.stringify(a.criteria.map((c) => [c.number, c.state, c.reasonCode]))).toBe(s.expected.disposition);
      expect(a.forwardToDesigner).toBe(s.expected.forward);
      for (const code of s.expected.reasonCodes ?? []) expect(a.reasonCodes).toContain(code);
      if (s.expected.priority) expect(a.priority).toBe(s.expected.priority);
      const facts = r.state.facts;
      if (s.expected.callerName) expect(facts.callerName).toBe(s.expected.callerName);
      if (s.expected.locationExcludes) expect(facts.locationText ?? "").not.toContain(s.expected.locationExcludes);
      if (s.expected.uncertaintyContains) {
        expect(a.uncertainties.join(" ").toLowerCase()).toContain(s.expected.uncertaintyContains.toLowerCase());
      }
    });
  }
});
