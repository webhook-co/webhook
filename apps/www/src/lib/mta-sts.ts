/**
 * MTA-STS (RFC 8461) policy for webhook.co.
 *
 * Stops an on-path attacker stripping STARTTLS from mail sent TO us. It is the ONLY inbound TLS
 * enforcement available to this domain: DANE is impossible here because `icloud.com` publishes no DS
 * record (unsigned zone), and TLSA records would have to live in Apple's zone, not ours.
 *
 * Two halves, and BOTH must agree:
 *   1. DNS  — `_mta-sts.webhook.co  TXT  "v=STSv1; id=<MTA_STS_POLICY_ID>;"`
 *   2. HTTPS — this policy, at `https://mta-sts.webhook.co/.well-known/mta-sts.txt`
 *
 * The `id` is the cache key: senders only re-fetch when it CHANGES. It is derived from a hash of the
 * policy body and asserted in mta-sts.test.ts, so editing the policy without bumping DNS cannot ship.
 */

/** The policy host. Bound as a second custom domain on the www Worker (see worker/index.ts). */
export const MTA_STS_HOST = "mta-sts.webhook.co";

/**
 * `mode: testing` reports failures via TLS-RPT without ever refusing delivery. Move to `enforce` only
 * after TLS reports are clean — under `enforce` a broken policy fetch or an MX mismatch means senders
 * REFUSE to deliver, and it fails closed (a cached policy keeps being honoured).
 *
 * The MX is a WILDCARD on purpose: RFC 8461 allows `*` as the entire left-most label, so
 * `*.mail.icloud.com` matches mx01/mx02 today and any sibling Apple adds tomorrow. Pinning the two
 * literal hosts would turn an Apple infra change into a silent mail outage.
 */
export const MTA_STS_POLICY = [
  "version: STSv1",
  "mode: testing",
  "mx: *.mail.icloud.com",
  "max_age: 86400",
  "",
].join("\r\n");

/** sha256(MTA_STS_POLICY)[0..16). Must equal the `id=` in the _mta-sts TXT record. */
export const MTA_STS_POLICY_ID = "168b696a309ca3e1";

const WELL_KNOWN_PATH = "/.well-known/mta-sts.txt";

/**
 * Returns the MTA-STS response for the policy host, or `null` if this request is not for it (so the
 * caller falls through to the marketing site untouched).
 *
 * The policy host is NOT a website: every other path 404s rather than serving www's content on it.
 */
export function mtaStsResponse(url: URL): Response | null {
  if (url.hostname !== MTA_STS_HOST) return null;

  if (url.pathname !== WELL_KNOWN_PATH) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(MTA_STS_POLICY, {
    status: 200,
    headers: {
      // Senders SHOULD validate this is text/plain. A Worker/Pages default of text/html is rejected.
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}
