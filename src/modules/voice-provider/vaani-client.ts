/**
 * Thin client for the Vaani Backend API. Every endpoint, header and field below is taken from the
 * official documentation at https://docs.vaanivoice.ai (read 9 Oct 2026):
 *   base URL  https://api.vaanivoice.ai        auth header  X-API-Key
 *   POST /api/create-agent · PATCH /api/agent/{id}/{persona|experience|analysis|deployment}
 *   GET  /api/agents · POST /api/trigger-call/ · GET /api/call_details/{call_id} · GET /api/call-history
 * Nothing else is called. The API key is only placed in the header and never appears in errors or logs.
 */
export const DEFAULT_VAANI_BASE = "https://api.vaanivoice.ai";

export class VaaniApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly category: "auth" | "validation" | "not_found" | "rate_limited" | "server" | "network") {
    super(message);
  }
  get retryable() { return this.category === "server" || this.category === "network" || this.category === "rate_limited"; }
}

export interface VaaniClientOptions { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export interface VaaniCallDetails {
  transcription?: string;
  entity?: Record<string, unknown>;
  conversation_eval?: Record<string, unknown>;
  summary?: string;
  call_eval_tag?: string | null;
}

export interface VaaniCallHistoryRow {
  call_id: string; call_type?: string; direction?: string; call_status?: string; agent_id?: string;
  from_number?: string; to_number?: string; Start_time?: string; End_time?: string; duration_ms?: number;
  call_cost?: number | null; user_picked_up_at?: string | null; call_dialing_at?: string | null; post_processing_status?: string;
}

export function createVaaniClient(opts: VaaniClientOptions) {
  const base = (opts.baseUrl ?? DEFAULT_VAANI_BASE).replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    try {
      const res = await f(`${base}${path}`, {
        method, signal: ctl.signal,
        headers: { "X-API-Key": opts.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      if (res.ok) return json as T;
      const detail = describeError(json) ?? `HTTP ${res.status}`;
      const category = res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "not_found" : res.status === 422 || res.status === 400 ? "validation"
        : res.status === 429 ? "rate_limited" : "server";
      throw new VaaniApiError(res.status, `Vaani ${method} ${path.split("?")[0]} failed: ${detail}`, category);
    } catch (e) {
      if (e instanceof VaaniApiError) throw e;
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new VaaniApiError(0, aborted ? "Vaani request timed out" : "Vaani request failed (network error)", "network");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listAgents: () => request<unknown[] | { data: unknown[] }>("GET", "/api/agents"),
    /** The live API returns the full agent object (with `agent_id`); the docs show `{success, agent_id, agent_name}`. Both are accepted. */
    createAgent: (agentDisplayName: string, config: Record<string, unknown>) =>
      request<{ success?: boolean; agent_id?: string; agent_name?: string; agent_display_name?: string; client_id?: string }>("POST", "/api/create-agent", { agent_display_name: agentDisplayName, config }),
    deleteAgent: (agentId: string) => request<{ message?: string }>("DELETE", `/api/agents/${encodeURIComponent(agentId)}`),
    patchAgent: (agentId: string, section: "persona" | "training" | "experience" | "analysis" | "deployment", body: Record<string, unknown>) =>
      request<{ warnings?: unknown[] } & Record<string, unknown>>("PATCH", `/api/agent/${encodeURIComponent(agentId)}/${section}`, body),
    /** Places an outbound call (telephony). `contact_number` must be E.164. */
    triggerCall: (input: { agentId: string; contactNumber: string; name: string; dndCheckSkipped?: boolean; modifyAgent?: Record<string, unknown>; metadata?: Record<string, unknown> }) =>
      request<{ success?: boolean; message?: string; output?: { agent_name?: string; call_id?: string; live_captions_url?: string }; error?: unknown }>("POST", "/api/trigger-call/", {
        agent_id: input.agentId, medium: "telephony", contact_number: input.contactNumber, name: input.name,
        dnd_check_skipped: input.dndCheckSkipped ?? false,
        ...(input.modifyAgent ? { modify_agent: input.modifyAgent } : {}), ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    getCallDetails: (callId: string) => request<VaaniCallDetails>("GET", `/api/call_details/${encodeURIComponent(callId)}`),
    getCallHistory: (page = 1, pageSize = 50) => request<{ data: VaaniCallHistoryRow[] }>("GET", `/api/call-history?page=${page}&page_size=${pageSize}`),
  };
}
export type VaaniClient = ReturnType<typeof createVaaniClient>;

function describeError(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as { detail?: unknown; message?: unknown; error?: unknown };
  if (Array.isArray(o.detail)) return o.detail.slice(0, 3).map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).join(".")}: ${d.msg ?? ""}`).join("; ");
  const m = [o.detail, o.message, o.error].find((x) => typeof x === "string") as string | undefined;
  return m?.slice(0, 200);
}
