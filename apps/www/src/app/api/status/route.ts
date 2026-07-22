import { fetchStatus } from "@/components/marketing/status-indicator";

/**
 * Same-origin proxy for the live status badge.
 *
 * WHY PROXY AT ALL. The footer needs live status on every page. Fetching Phare directly from the
 * browser would put a third-party request on every pageview of a site that asks visitors for
 * consent, and fetching it during server render turns the footer into a suspense boundary (which
 * broke 126 page tests when tried). A same-origin handler avoids both: the browser only ever talks
 * to webhook.co, and the vendor call happens here, cached.
 *
 * WHAT IT RETURNS. Only the two fields the indicator renders, already validated. The vendor's
 * document also carries an inline `logoSvg` and label colours we neither use nor want to hand to a
 * browser, so this narrows rather than forwards — a proxy that echoed the upstream body verbatim
 * would be a third-party payload wearing a first-party origin.
 *
 * FAILURE MODE: 204 No Content, never a 5xx. A degraded status vendor must not turn into an error in
 * our own logs or a red line in the browser console — the indicator simply renders nothing.
 */
export const dynamic = "force-dynamic";

/** Browser-side cache window. Matches the server revalidate so the two do not fight. */
const BROWSER_CACHE_SECONDS = 60;

export async function GET(): Promise<Response> {
  const status = await fetchStatus();
  if (status === null) return new Response(null, { status: 204 });

  return Response.json(status, {
    headers: {
      // Short cache with a longer stale window: a visitor should never wait on the vendor, and a
      // slightly stale "operational" for a few seconds is fine when the page also links to the real
      // status page. `public` is safe — this response carries no per-visitor data.
      "cache-control": `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=300`,
    },
  });
}
