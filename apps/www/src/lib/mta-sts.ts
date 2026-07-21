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
 * `mode: enforce` since 2026-07-21 (was `testing` from 2026-07-14). Under `enforce` a failed policy
 * fetch or an MX mismatch makes senders REFUSE to deliver, and it fails closed — a cached policy keeps
 * being honoured for up to `max_age`. `testing` only ever OBSERVED: a stripped STARTTLS session still
 * delivered in plaintext and was merely reported afterwards, so this flip is where the phase's actual
 * protection begins.
 *
 * Promoted on evidence, not elapsed time: 3 observed TLS-RPT windows (07-17/18/20) reported
 * `policy-type: "sts"` — discovered AND applied — across 17 sessions with 0 failures, and both published
 * MX were verified directly to present valid, hostname-matching certs over TLS 1.3.
 *
 * `max_age` deliberately stays at 86400 through the flip. Raising it would SLOW ROLLBACK, since senders
 * pin a cached `enforce` policy for that long; widen it only after enforcement has been clean for a week.
 *
 * The MX is a WILDCARD on purpose: RFC 8461 allows `*` as the entire left-most label, so
 * `*.mail.icloud.com` matches mx01/mx02 today and any sibling Apple adds tomorrow. Pinning the two
 * literal hosts would turn an Apple infra change into a silent mail outage. (Apple's own cert already
 * carries `mx3.mail.icloud.com` in its SAN — that sibling exists, so the wildcard is load-bearing.)
 */
export const MTA_STS_POLICY = [
  "version: STSv1",
  "mode: enforce",
  "mx: *.mail.icloud.com",
  "max_age: 86400",
  "",
].join("\r\n");

/** sha256(MTA_STS_POLICY)[0..16). Must equal the `id=` in the _mta-sts TXT record. */
export const MTA_STS_POLICY_ID = "bfd20a7feac1a43a";

const WELL_KNOWN_PATH = "/.well-known/mta-sts.txt";

/**
 * The site's security baseline, normally applied by `public/_headers` via Workers Static Assets.
 *
 * These responses are the FIRST in this Worker that never reach `env.ASSETS.fetch`, so `_headers` does
 * not apply to them and the policy host would otherwise sit outside the zone's posture entirely — no
 * HSTS, no nosniff. Restated here so `mta-sts.webhook.co` matches the rest of the site.
 *
 * HSTS is host-scoped with no `includeSubDomains`, matching the `/*` rule in `_headers` (that zone also
 * fronts api./mcp., and includeSubDomains is sticky and cannot be cleanly walked back).
 */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=63072000",
} as const;

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
      headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(MTA_STS_POLICY, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      // Senders SHOULD validate this is text/plain. A Worker/Pages default of text/html is rejected.
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}
