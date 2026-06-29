import { isUuid } from "@/server/endpoints";
import { downloadExtension, openPayloadForDownload } from "@/server/payloads";
import { verifySession } from "@/server/session";

// Reads cookies + the DB + R2 per request — never statically optimized.
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Download an event's captured body as opaque bytes. Route handlers are NOT covered by the `(app)` layout
 * gate, so `verifySession()` is the literal first line. The body is streamed from R2 (resolved under RLS +
 * endpoint scope in `openPayloadForDownload`) and ALWAYS served as `application/octet-stream` +
 * `attachment` + `nosniff` — never with the stored content type — so an attacker-controlled `text/html` /
 * `image/svg+xml` body can't execute on the app/session origin.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
): Promise<Response> {
  const session = await verifySession();
  const { id, eventId } = await params;
  if (!isUuid(id) || !isUuid(eventId)) return notFound();

  const result = await openPayloadForDownload(session.orgId, id, eventId);
  if (result === "not_found") return notFound();
  if (result === "error") return new Response("Internal Server Error", { status: 500 });

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
