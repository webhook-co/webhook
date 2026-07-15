import { avatarR2Key, validateAvatarImage } from "@webhook-co/shared";

import { logActionError } from "@/server/action-log";
import { getAvatarBucket } from "@/server/avatar-r2";
import { getOnboardingBinding } from "@/server/env";
import { verifySession } from "@/server/session";

export const dynamic = "force-dynamic";

// Upload the signed-in user's avatar. The client has cropped + re-encoded the image to a square webp (which
// also strips EXIF/GPS) and POSTs the raw bytes here. The server NEVER trusts that: it re-checks the origin,
// the size, the real magic bytes, and the real header dimensions before storing.
//
// dal-gate-allow: user-scoped — gates on verifySession; the avatar is the caller's own, stored under a
// key derived from the verified userId, and the pointer write goes through the identity RPC.

const MAX_BYTES = 512 * 1024; // a 512×512 webp is ~20–100 KB; 512 KB is generous headroom, and a hard bomb cap.
const MIN_DIM = 64;
const MAX_DIM = 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(request: Request): Promise<Response> {
  // 1) CSRF: route handlers get NO framework CSRF protection (unlike server actions), so enforce same-origin
  //    EXPLICITLY and FIRST — a cross-site form/fetch carries a foreign (or absent) Origin. Fail closed.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: "forbidden origin" });
  }

  // 2) The gate.
  const session = await verifySession();

  // 3) Size: cheap Content-Length pre-check, then the real byteLength (a lying/absent length can't smuggle an
  //    oversize body past the second check).
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BYTES) {
    return json(413, { ok: false, error: "file too large" });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());

  // 4) Validate the REAL bytes: png/jpeg/webp only (SVG/GIF rejected), square, within bounds. Then require
  //    webp specifically — we store one `avatar.webp` per user and serve it as image/webp, so a non-webp body
  //    would be served with the wrong type. Modern browsers all encode webp; the client falls back to webp.
  const result = validateAvatarImage(bytes, {
    maxBytes: MAX_BYTES,
    minDim: MIN_DIM,
    maxDim: MAX_DIM,
  });
  if (!result.ok) return json(415, { ok: false, error: result.reason });
  if (result.type !== "webp") {
    return json(415, { ok: false, error: "image must be a webp" });
  }

  // 5) Store in R2 (unbound in dev / non-workerd → the feature is simply unavailable there).
  const bucket = await getAvatarBucket();
  if (!bucket) {
    return json(503, { ok: false, error: "Avatar uploads are temporarily unavailable." });
  }
  const key = avatarR2Key(session.userId);
  try {
    await bucket.put(key, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: "image/webp" },
    });
  } catch (error) {
    logActionError("avatar.r2_put", error);
    return json(502, { ok: false, error: "We couldn't save your avatar. Please try again." });
  }

  // 6) Point the identity row at it, over the auth RPC (webhook_app can't write `user`). Serving reads R2
  //    directly, so the avatar already shows — but the pointer must be set so the orphan sweep keeps the
  //    object. On failure, surface an error (the object is retained by the sweep's safety window; a retry
  //    re-puts + re-points).
  const binding = getOnboardingBinding();
  if (!binding) {
    return json(503, { ok: false, error: "Avatar uploads are temporarily unavailable." });
  }
  try {
    await binding.updateImageKey(session.userId, key);
  } catch (error) {
    logActionError("avatar.update_image_key_rpc", error);
    return json(502, {
      ok: false,
      error: "We couldn't finish saving your avatar. Please try again.",
    });
  }

  return json(200, { ok: true });
}
