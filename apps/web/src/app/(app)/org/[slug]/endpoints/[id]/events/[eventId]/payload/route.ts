import { releaseTenantDbEarly } from "@/server/db";
import { isUuid } from "@/server/endpoints";
import { downloadExtension, openPayloadForDownload } from "@/server/payloads";
import { requireOrgAccess } from "@/server/org-access";

// Reads cookies + the DB + R2 per request — never statically optimized.
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Download an event's captured body as opaque bytes. Route handlers are NOT covered by the `(app)` layout
 * gate, so `requireOrgAccess()` (which calls verifySession, then re-checks membership) is the literal first
 * line. The body is streamed from R2 (resolved under RLS +
 * endpoint scope in `openPayloadForDownload`) and ALWAYS served as `application/octet-stream` +
 * `attachment` + `nosniff` — never with the stored content type — so an attacker-controlled `text/html` /
 * `image/svg+xml` body can't execute on the app/session origin.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string; eventId: string }> },
): Promise<Response> {
  const { slug, id, eventId } = await params;
  // No subPath: a route handler does not RENDER, so there is nothing to canonicalise — a 308 here would
  // just make the browser re-issue the download. It resolves a mis-cased/renamed slug straight through.
  const session = await requireOrgAccess(slug);
  if (!isUuid(id) || !isUuid(eventId)) return notFound();

  const result = await openPayloadForDownload(session.orgId, id, eventId);
  if (result === "not_found") return notFound();
  if (result === "error") return new Response("Internal Server Error", { status: 500 });

  // Every database read this request will ever do is now finished — what remains is streaming bytes out of R2,
  // which can take arbitrarily long on a slow link. The tenant client is closed once the RESPONSE finishes
  // (`after()`), so leaving it to that would hold a Postgres connection open, idle, for the entire duration of
  // the download; enough concurrent slow downloads would starve the pool for everyone else. Nothing is gained
  // by holding it, so let it go now.
  //
  // Safe here specifically because a route handler renders no layout: this handler is the only consumer of the
  // client in this request. That is NOT true of a page, which is why this is a deliberate exception rather
  // than a pattern (see releaseTenantDbEarly + the no-early-db-close guard).
  await releaseTenantDbEarly();

  const ext = downloadExtension(result.contentType);
  return new Response(result.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="event-${eventId}.${ext}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(result.size),
      // The body is the org's private captured payload — keep it out of any shared/proxy cache.
      "Cache-Control": "private, no-store",
    },
  });
}
