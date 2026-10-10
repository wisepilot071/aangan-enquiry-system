import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_SLOT_POLICY, findNextSlot } from "@/modules/calendar/slots";
import { CalendarError, createGoogleCalendarClient, parseServiceAccount } from "@/modules/calendar/google";

const ist = (iso: string) => new Date(`${iso}+05:30`);
const fmt = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ");

describe("slot picker", () => {
  it("honours the 24 h lead time and business hours (Mon 11:30 IST → Tue 12:00)", () => {
    expect(fmt(findNextSlot([], ist("2026-10-12T11:30:00"))!.start)).toBe("2026-10-13 12:00");
  });
  it("skips Sundays", () => {
    expect(fmt(findNextSlot([], ist("2026-10-10T16:00:00"))!.start)).toBe("2026-10-12 10:00"); // Sat 4 pm + 24 h = Sunday → Monday
  });
  it("skips busy periods", () => {
    const busy = [{ start: ist("2026-10-13T10:00:00"), end: ist("2026-10-13T12:30:00") }];
    expect(fmt(findNextSlot(busy, ist("2026-10-12T09:00:00"))!.start)).toBe("2026-10-13 13:00");
  });
  it("never ends after 7 PM and returns null when nothing is free", () => {
    const all = [{ start: ist("2026-10-01T00:00:00"), end: ist("2027-01-01T00:00:00") }];
    expect(findNextSlot(all, ist("2026-10-12T09:00:00"))).toBeNull();
    const s = findNextSlot([], ist("2026-10-12T17:30:00"), { ...DEFAULT_SLOT_POLICY, minLeadHours: 0 })!;
    expect(fmt(s.end) <= "2026-10-12 19:00").toBe(true);
  });
});

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

function fakeFetch(handler: (url: string, init: RequestInit) => unknown | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("google calendar client", () => {
  it("signs a JWT, caches the token and creates a tentative event with the enquiry tag", async () => {
    const { f, calls } = fakeFetch((url) => url.includes("oauth2") ? { access_token: "tok", expires_in: 3600 } : { id: "ev1", htmlLink: "https://cal/x", status: "tentative" });
    const c = createGoogleCalendarClient({ serviceAccount: key, calendarId: "studio@group.calendar.google.com", fetchImpl: f });
    await c.createEvent({ summary: "s", description: "d", start: new Date("2026-10-13T05:00:00Z"), end: new Date("2026-10-13T06:00:00Z"), tentative: true, enquiryId: "e-1" });
    await c.createEvent({ summary: "s", description: "d", start: new Date("2026-10-14T05:00:00Z"), end: new Date("2026-10-14T06:00:00Z"), tentative: true, enquiryId: "e-2" });
    expect(calls.filter((x) => x.url.includes("oauth2")).length).toBe(1);
    const tokenBody = new URLSearchParams(calls[0]!.init.body as string);
    expect(tokenBody.get("grant_type")).toContain("jwt-bearer");
    const [h, p, sig] = tokenBody.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: key.client_email, scope: "https://www.googleapis.com/auth/calendar" });
    expect(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(privateKey, Buffer.from(sig!, "base64url"))).toBe(true);
    const ev = JSON.parse(calls[1]!.init.body as string);
    expect(ev).toMatchObject({ status: "tentative", extendedProperties: { private: { aangan_enquiry: "e-1" } } });
    expect(calls[1]!.url).toContain("/calendars/studio%40group.calendar.google.com/events");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
  it("reads busy times and flags an unshared calendar", async () => {
    const ok = fakeFetch((url) => url.includes("oauth2") ? { access_token: "t" } : { calendars: { cal: { busy: [{ start: "2026-10-13T05:00:00Z", end: "2026-10-13T06:00:00Z" }] } } });
    expect((await createGoogleCalendarClient({ serviceAccount: key, calendarId: "cal", fetchImpl: ok.f }).freeBusy(new Date(), new Date()))).toHaveLength(1);
    const bad = fakeFetch((url) => url.includes("oauth2") ? { access_token: "t" } : { calendars: { cal: { errors: [{ reason: "notFound" }] } } });
    await expect(createGoogleCalendarClient({ serviceAccount: key, calendarId: "cal", fetchImpl: bad.f }).freeBusy(new Date(), new Date())).rejects.toMatchObject({ category: "not_found" });
  });
  it("classifies auth and API errors without leaking the key", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT" }), { status: 400 }));
    const err = await createGoogleCalendarClient({ serviceAccount: key, calendarId: "c", fetchImpl: f.f }).freeBusy(new Date(), new Date()).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarError);
    expect(err.category).toBe("auth");
    expect(err.message).not.toContain("PRIVATE KEY");
    const g = fakeFetch((url) => url.includes("oauth2") ? { access_token: "t" } : new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 }));
    await expect(createGoogleCalendarClient({ serviceAccount: key, calendarId: "c", fetchImpl: g.f }).findByEnquiry("x")).rejects.toMatchObject({ category: "auth", status: 403 });
  });
  it("deleting an already-gone event is not an error; parseServiceAccount accepts JSON or base64", async () => {
    const f = fakeFetch((url) => url.includes("oauth2") ? { access_token: "t" } : new Response("", { status: 410 }));
    await createGoogleCalendarClient({ serviceAccount: key, calendarId: "c", fetchImpl: f.f }).deleteEvent("gone");
    const json = JSON.stringify({ ...key, private_key: key.private_key.replace(/\n/g, "\\n") });
    expect(parseServiceAccount(json).private_key).toContain("\n");
    expect(parseServiceAccount(Buffer.from(json).toString("base64")).client_email).toBe(key.client_email);
    expect(() => parseServiceAccount("nope")).toThrow(/not valid JSON/);
  });
});
