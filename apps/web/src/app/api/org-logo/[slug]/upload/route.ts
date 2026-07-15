import { orgLogoR2Key, validateAvatarImage } from "@webhook-co/shared";
import { updateOrgImageKey } from "@webhook-co/db";

import { logActionError } from "@/server/action-log";
import { getAvatarBucket } from "@/server/avatar-r2";
import { withTenantDb } from "@/server/db";
import { getAppBaseUrl } from "@/server/env";
import { requireOrgAccess } from "@/server/org-access";

export const dynamic = "force-dynamic";

// Upload an organization's logo. The client has cropped + re-encoded the image to a square webp (which also
// strips EXIF/GPS) and POSTs the raw bytes here. The server NEVER trusts that: it re-checks the origin, the
// caller's role, the size, the real magic bytes, and the real header dimensions before storing.
//
// Unlike the user-avatar route this writes the pointer DIRECTLY (webhook_app owns the `orgs` table) via
// withTenantDb → updateOrgImageKey — no auth RPC. Authorization is owner/admin (org branding, same class as
// the org name), enforced here before any write.

const MAX_BYTES = 512 * 1024; // a 512×512 webp is ~20–100 KB; generous headroom + a hard bomb cap.
const MIN_DIM = 64;
const MAX_DIM = 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  // 1) CSRF: route handlers get NO framework CSRF protection, so enforce same-origin EXPLICITLY and FIRST.
  //    Compare against the KNOWN app origin (getAppBaseUrl), NOT `new URL(request.url).origin` (which behind
  //    the CF/OpenNext proxy may reconstruct an internal host and 403 every legitimate upload).
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(getAppBaseUrl()).origin) {
    return json(403, { ok: false, error: "forbidden origin" });
  }

  // 2) The gate: prove membership of the org named in the URL, and read the caller's role.
  const { slug } = await ctx.params;
  const access = await requireOrgAccess(slug);
  // A logo is org branding — gate it to owner/admin, exactly like renaming the org.
  if (access.role !== "owner" && access.role !== "admin") {
    return json(403, { ok: false, error: "Only an owner or admin can change the logo." });
  }

  // 3) Size: cheap Content-Length pre-check, then the real byteLength.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BYTES) {
    return json(413, { ok: false, error: "file too large" });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());

  // 4) Validate the REAL bytes: png/jpeg/webp only (SVG/GIF rejected), square, within bounds — then require
  //    webp specifically (we store one `logo.webp` per org and serve it as image/webp).
  const result = validateAvatarImage(bytes, {
    maxBytes: MAX_BYTES,
    minDim: MIN_DIM,
    maxDim: MAX_DIM,
  });
  if (!result.ok) return json(415, { ok: false, error: result.reason });
  if (result.type !== "webp") return json(415, { ok: false, error: "image must be a webp" });

  // 5) Store in R2 (unbound in dev / non-workerd → the feature is simply unavailable there).
  const bucket = await getAvatarBucket();
  if (!bucket) {
    return json(503, { ok: false, error: "Logo uploads are temporarily unavailable." });
  }
  const key = orgLogoR2Key(access.orgId);
  try {
    await bucket.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: "image/webp" },
    });
  } catch (error) {
    logActionError("org_logo.r2_put", error);
    return json(502, { ok: false, error: "We couldn't save the logo. Please try again." });
  }

  // 6) Point the org row at it (direct webhook_app write). The DB pointer and the R2 object must stay in
  //    lock-step, so on failure ROLL BACK the put — otherwise the object would be stored (and, since serving
  //    reads R2 by key, live) while image_key stayed null.
  try {
    await withTenantDb((app) => updateOrgImageKey(app, access.orgId, key));
  } catch (error) {
    logActionError("org_logo.update_image_key", error);
    await bucket.delete(key).catch(() => {}); // roll back so R2 and image_key stay consistent
    return json(502, { ok: false, error: "We couldn't finish saving the logo. Please try again." });
  }

  return json(200, { ok: true });
}

// Remove the org's logo (owner/admin). Delete the R2 object FIRST — serving probes R2 by key, so the object's
// presence, not the pointer, is what shows a logo — then clear the pointer hint. If the object delete fails we
// stop (502) rather than clear the pointer, keeping the two consistent.
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(getAppBaseUrl()).origin) {
    return json(403, { ok: false, error: "forbidden origin" });
  }
  const { slug } = await ctx.params;
  const access = await requireOrgAccess(slug);
  if (access.role !== "owner" && access.role !== "admin") {
    return json(403, { ok: false, error: "Only an owner or admin can change the logo." });
  }

  const bucket = await getAvatarBucket();
  if (!bucket) {
    return json(503, { ok: false, error: "Logo uploads are temporarily unavailable." });
  }
  const key = orgLogoR2Key(access.orgId);
  try {
    await bucket.delete(key);
  } catch (error) {
    logActionError("org_logo.r2_delete", error);
    return json(502, { ok: false, error: "We couldn't remove the logo. Please try again." });
  }
  // The visible logo is already gone; a failed pointer-clear only leaves a stale "has logo" hint (→ one extra
  // 404 fetch that falls back to the generated avatar), so it does not fail the request.
  try {
    await withTenantDb((app) => updateOrgImageKey(app, access.orgId, null));
  } catch (error) {
    logActionError("org_logo.clear_image_key", error);
  }
  return json(200, { ok: true });
}
