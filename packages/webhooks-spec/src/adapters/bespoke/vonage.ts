// Vonage / Nexmo signed webhooks (Messages, Dispatch, Verify, Voice) — `Authorization: Bearer <jwt>` is
// an HS256 JWT with `iss: "Vonage"` and `payload_hash` = hex SHA-256 of the raw body (plus iat/jti, no
// nbf/exp so no provider-enforced window). Key = the account Signature Secret verbatim utf8. The
// iss-plus-one-body-hash shape maps onto the shared JWS hash-binding factory (with Bearer stripping).

import type { VerifyAdapter } from "../../adapter";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { makeHashBindingJwsAdapter } from "./jws-hash-binding";

export function makeVonageAdapter(): VerifyAdapter {
  return makeHashBindingJwsAdapter({
    slug: "vonage",
    header: "authorization",
    bearerPrefix: "Bearer ",
    issuer: "Vonage",
    bodyHashClaim: "payload_hash",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.vonage,
  });
}
