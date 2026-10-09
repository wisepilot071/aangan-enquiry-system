import { getConfig } from "@/lib/config";
import { createMockProvider } from "./mock";
import { createVaaniProvider } from "./vaani";
import type { VoiceProvider } from "./types";

export * from "./types";
export { createMockProvider, signMockPayload, MOCK_SIGNATURE_HEADER, MOCK_TIMESTAMP_HEADER } from "./mock";
export { createVaaniProvider } from "./vaani";

export function getVoiceProvider(): VoiceProvider {
  const c = getConfig();
  return c.VOICE_PROVIDER === "vaani"
    ? createVaaniProvider({ apiKey: c.VAANI_API_KEY, webhookToken: c.VAANI_WEBHOOK_TOKEN, baseUrl: c.VAANI_API_BASE })
    : createMockProvider({ secret: c.MOCK_WEBHOOK_SECRET });
}

/** The configured Vaani provider (with API client), or null when Vaani is not selected / not configured. */
export function getVaaniProvider(): ReturnType<typeof createVaaniProvider> | null {
  const c = getConfig();
  if (c.VOICE_PROVIDER !== "vaani" || !c.VAANI_API_KEY) return null;
  return createVaaniProvider({ apiKey: c.VAANI_API_KEY, webhookToken: c.VAANI_WEBHOOK_TOKEN, baseUrl: c.VAANI_API_BASE });
}
