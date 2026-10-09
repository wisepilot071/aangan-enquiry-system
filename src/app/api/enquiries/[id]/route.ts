import { getDb } from "@/db/client";
import { apiUser } from "@/lib/auth-server";
import { json, readJson, safe } from "@/lib/http";
import { can } from "@/modules/authentication";
import { UpdateEnquirySchema, getEnquiryDetail, updateEnquiry } from "@/modules/enquiries/service";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = safe(async (req: Request, { params }: Ctx) => {
  const a = await apiUser(req, "view");
  if ("error" in a) return a.error;
  const d = await getEnquiryDetail(await getDb(), (await params).id, { includeTranscript: can(a.user.role, "view_transcript") });
  return d ? json(d) : json({ error: "not_found" }, 404);
});

export const PATCH = safe(async (req: Request, { params }: Ctx) => {
  const a = await apiUser(req, "operate", true);
  if ("error" in a) return a.error;
  const body = await readJson(req, UpdateEnquirySchema);
  if (!body.ok) return body.res;
  const d = await updateEnquiry(await getDb(), (await params).id, a.user.email, body.data);
  return d ? json(d) : json({ error: "not_found" }, 404);
});
