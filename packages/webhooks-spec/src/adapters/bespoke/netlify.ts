// Netlify deploy webhooks — `X-Webhook-Signature` is an HS256 compact JWS with payload exactly
// `{ iss: "netlify", sha256: <hex SHA-256 of the raw body> }` (no iat/exp → no replay window). Key = the
// configured "JWS secret token" verbatim utf8. Pure iss-plus-one-body-hash shape, so it's a thin config
// over the shared JWS hash-binding factory.

import type { VerifyAdapter } from "../../adapter";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { makeHashBindingJwsAdapter } from "./jws-hash-binding";

export function makeNetlifyAdapter(): VerifyAdapter {
  return makeHashBindingJwsAdapter({
    slug: "netlify",
    header: "x-webhook-signature",
    issuer: "netlify",
    bodyHashClaim: "sha256",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.netlify,
  });
}
