import crypto from "node:crypto";

/**
 * Minimal Google Calendar client using a SERVICE ACCOUNT (no SDK, no OAuth screen).
 * Only documented Google endpoints are used:
 *   token   POST https://oauth2.googleapis.com/token   (JWT bearer grant, scope calendar)
 *   busy    POST https://www.googleapis.com/calendar/v3/freeBusy
 *   events  POST/GET/PATCH/DELETE https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events[/{id}]
 * The studio calendar must be shared with the service account's email with "Make changes to events".
 * A service account cannot invite attendees without domain-wide delegation, so events carry the caller's details in the description.
 */
export interface ServiceAccountKey { client_email: string; private_key: string }

export class CalendarError extends Error {
  constructor(public readonly status: number, message: string, public readonly category: "auth" | "not_found" | "conflict" | "rate_limited" | "server" | "network" | "config") { super(message); }
}

export interface CalendarEvent { id: string; htmlLink?: string; start?: string; status?: string }

export interface CalendarClient {
  readonly calendarId: string;
  freeBusy(from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  createEvent(e: { summary: string; description: string; start: Date; end: Date; tentative: boolean; enquiryId: string }): Promise<CalendarEvent>;
  findByEnquiry(enquiryId: string): Promise<CalendarEvent | null>;
  updateEvent(eventId: string, patch: { start?: Date; end?: Date; tentative?: boolean; summary?: string }): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export function parseServiceAccount(raw: string): ServiceAccountKey {
  let text = raw.trim();
  if (!text.startsWith("{")) { try { text = Buffer.from(text, "base64").toString("utf8"); } catch { /* fall through */ } }
  let j: Partial<ServiceAccountKey>;
  try { j = JSON.parse(text); } catch { throw new CalendarError(0, "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64 of JSON)", "config"); }
  if (!j.client_email || !j.private_key) throw new CalendarError(0, "service account JSON needs client_email and private_key", "config");
  return { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, "\n") };
}

export function createGoogleCalendarClient(opts: { serviceAccount: ServiceAccountKey; calendarId: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }): CalendarClient {
  const f = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  let token: { value: string; exp: number } | null = null;

  async function raw(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    try { return await f(url, { ...init, signal: ctl.signal }); }
    catch (e) { throw new CalendarError(0, e instanceof Error && e.name === "AbortError" ? "Google Calendar timed out" : "Google Calendar unreachable", "network"); }
    finally { clearTimeout(timer); }
  }

  async function accessToken(): Promise<string> {
    if (token && token.exp > clock() + 60_000) return token.value;
    const iat = Math.floor(clock() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: opts.serviceAccount.client_email, scope: "https://www.googleapis.com/auth/calendar", aud: TOKEN_URL, iat, exp: iat + 3600 }));
    let sig: string;
    try { sig = crypto.createSign("RSA-SHA256").update(`${head}.${claims}`).sign(opts.serviceAccount.private_key).toString("base64url"); }
    catch { throw new CalendarError(0, "service account private key could not be used to sign", "config"); }
    const res = await raw(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }).toString() });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new CalendarError(res.status, `Google rejected the service account (${j.error ?? res.status}${j.error_description ? `: ${j.error_description.slice(0, 80)}` : ""})`, "auth");
    token = { value: j.access_token, exp: clock() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await raw(`${API}${path}`, { method, headers: { authorization: `Bearer ${await accessToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let j: unknown; try { j = text ? JSON.parse(text) : undefined; } catch { j = undefined; }
    if (res.ok) return j as T;
    const msg = (j as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${res.status}`;
    const category = res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 429 ? "rate_limited" : "server";
    throw new CalendarError(res.status, `Google Calendar ${method} failed: ${msg.slice(0, 160)}`, category);
  }

  const cal = encodeURIComponent(opts.calendarId);
  return {
    calendarId: opts.calendarId,
    async freeBusy(from, to) {
      const r = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>("POST", "/freeBusy",
        { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "Asia/Kolkata", items: [{ id: opts.calendarId }] });
      const c = r.calendars?.[opts.calendarId];
      if (!c || c.errors?.length) throw new CalendarError(404, "Google could not read this calendar's availability (is it shared with the service account?)", "not_found");
      return (c.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    },
    async createEvent(e) {
      const ev = await call<{ id: string; htmlLink?: string; status?: string }>("POST", `/calendars/${cal}/events`, {
        summary: e.summary, description: e.description, status: e.tentative ? "tentative" : "confirmed",
        start: { dateTime: e.start.toISOString(), timeZone: "Asia/Kolkata" }, end: { dateTime: e.end.toISOString(), timeZone: "Asia/Kolkata" },
        extendedProperties: { private: { aangan_enquiry: e.enquiryId } }, reminders: { useDefault: true },
      });
      return { id: ev.id, htmlLink: ev.htmlLink, status: ev.status };
    },
    async findByEnquiry(enquiryId) {
      const r = await call<{ items?: { id: string; htmlLink?: string; status?: string; start?: { dateTime?: string } }[] }>("GET",
        `/calendars/${cal}/events?privateExtendedProperty=${encodeURIComponent(`aangan_enquiry=${enquiryId}`)}&showDeleted=false&maxResults=5`);
      const hit = (r.items ?? []).find((i) => i.status !== "cancelled");
      return hit ? { id: hit.id, htmlLink: hit.htmlLink, status: hit.status, start: hit.start?.dateTime } : null;
    },
    async updateEvent(id, p) {
      await call("PATCH", `/calendars/${cal}/events/${encodeURIComponent(id)}`, {
        ...(p.summary ? { summary: p.summary } : {}), ...(p.tentative === undefined ? {} : { status: p.tentative ? "tentative" : "confirmed" }),
        ...(p.start ? { start: { dateTime: p.start.toISOString(), timeZone: "Asia/Kolkata" } } : {}), ...(p.end ? { end: { dateTime: p.end.toISOString(), timeZone: "Asia/Kolkata" } } : {}),
      });
    },
    async deleteEvent(id) {
      try { await call("DELETE", `/calendars/${cal}/events/${encodeURIComponent(id)}`); }
      catch (e) { if (!(e instanceof CalendarError && (e.status === 404 || e.status === 410))) throw e; }
    },
  };
}
