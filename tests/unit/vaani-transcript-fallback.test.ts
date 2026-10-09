import { describe, expect, it } from "vitest";
import { parseVaaniTranscript } from "@/modules/voice-provider/vaani-mapper";
import { qualifyCompletedCall } from "@/modules/telephony-events/ingest";
import { ProviderEventSchema } from "@/modules/voice-provider/types";
import { explain } from "@/modules/qualification/explain";

/** Format exactly as returned by Vaani's GET /api/transcript/{call_id} on a real browser test call (9 Oct 2026). */
const REAL = `[2026-10-09 18:52:05] AGENT: Namaste, and a warm welcome to Aangan Studio, I am the studio's virtual assistant, and it is a pleasure to speak with you, How may I help you today, please? . 
 interrupted: False

[2026-10-09 18:52:16] USER: Hello. I'm Priya Sharma. I want to redo my flat, a three BHK I need complete redesign with execution.. 
 interrupted: False

[2026-10-09 18:52:29] AGENT: Thank you so much, Priya ji. Could you kindly tell me where in Pune or PCMC your property is located?. 
 interrupted: False

[2026-10-09 18:52:40] USER: It is in Baner, Pune. Right. Sorry.. 
 interrupted: False

[2026-10-09 18:52:52] AGENT: Thank you, Priya ji. If you do not mind, could you please tell me when you would need the project to be complete?. 
 interrupted: False

[2026-10-09 18:53:08] USER: Need this project completed by January. Flat is emptied out... Empty now. It is available for working.. 
 interrupted: False

[2026-10-09 18:53:24] AGENT: Thank you. Are you the owner of the flat, or calling on behalf of the owner?. 
 interrupted: True

[2026-10-09 18:53:46] USER: Yes, I'm the owner, my husband and I.. 
 interrupted: False`;

describe("reading Vaani's raw transcript format", () => {
  it("splits turns, drops timestamps and 'interrupted' noise, keeps the words", () => {
    const t = parseVaaniTranscript(REAL);
    expect(t.map((x) => x.role)).toEqual(["agent", "caller", "agent", "caller", "agent", "caller", "agent", "caller"]);
    expect(t[1]!.text).toBe("Hello. I'm Priya Sharma. I want to redo my flat, a three BHK I need complete redesign with execution..");
    expect(JSON.stringify(t)).not.toMatch(/interrupted|2026-10-09/);
    expect(t[0]!.text).toMatch(/^Namaste/);
  });
});

describe("a call whose Vaani analysis is late is still qualified from its transcript — with a caveat", () => {
  const event = ProviderEventSchema.parse({ type: "call.completed", providerCallId: "webrtc-x", occurredAt: "2026-10-09T18:54:00.000Z", startedAt: "2026-10-09T18:52:00.000Z", transcript: parseVaaniTranscript(REAL), transcriptOnly: true });

  it("understands the caller's words and reaches the right decision", () => {
    const q = qualifyCompletedCall(event, "vaani");
    expect(q.facts).toMatchObject({ callerName: "Priya Sharma", scopeKind: "full_home", engagement: "design_and_execution", decisionMaker: "owner" });
    expect(q.facts.locationText).toContain("Baner");
    expect(q.assessment.disposition).toBe("QUALIFIED");
    expect(q.assessment.criteria.find((c) => c.id === "realistic_timeline")?.state).toBe("PASS");
  });
  it("tells the designers it was read from the transcript and should be checked", () => {
    const q = qualifyCompletedCall(event, "vaani");
    expect(q.notes.join(" ")).toMatch(/answers were read from the transcript/);
    expect(q.assessment.humanReviewReasons.join(" ")).toMatch(/Please check the details/);
  });
  it("without that flag, a live provider's bare transcript is NOT trusted (unchanged safety rule)", () => {
    const q = qualifyCompletedCall({ ...event, transcriptOnly: undefined }, "vaani");
    expect(q.assessment.disposition).toBe("HUMAN_REVIEW");
    expect(q.assessment.reasonCodes).toEqual(["NO_USABLE_DATA"]);
    expect(explain({ disposition: "HUMAN_REVIEW", criteria: [], humanReviewReasons: q.assessment.humanReviewReasons }).headline).toBe("Nothing usable was captured");
  });
});
