import { avatarR2Key } from "@webhook-co/shared";

import { serveAvatar } from "@/server/avatar-serve";
import { verifySession } from "@/server/session";

// Fetches an upstream image per request; never statically optimized.
export const dynamic = "force-dynamic";

/**
 * The signed-in user's avatar, proxied.
 *
 * ── This route takes NO INPUT ───────────────────────────────────────────────────────────────────────────
 *
 * No path parameter, no query string, no header. It reads the SESSION (HMAC-verified), so the identity it
 * serves is derived entirely from server-held state — there is nothing for a caller to point it at. That is a
 * stronger guarantee than validating an input would be: the classic shape of this bug is an image proxy with a
 * `?url=` parameter and a blocklist that misses `http://169.254.169.254`. There is no parameter here.
 *
 * The upstream host is ALSO allowlisted (inside `serveAvatar`), because `user.image` is written by another app
 * from a third party's profile payload, and "that value is trustworthy" is not an assumption to build a fetch
 * on. The uploaded R2 avatar (validated webp on upload) wins over the provider image; the CSP is
 * `img-src 'self' data:`, so proxying through our own origin is the only way a provider avatar can render at
 * all — and it keeps Gravatar from beaconing the user's IP + email hash on every page view.
 */
export async function GET(): Promise<Response> {
  const session = await verifySession(); // the gate + the only source of identity
  return serveAvatar({
    r2Key: avatarR2Key(session.userId),
    image: session.user.image,
    email: session.user.email,
  });
}
