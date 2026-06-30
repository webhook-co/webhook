// Twilio — a hand-written adapter because Twilio's webhook validation is TWO different schemes selected
// at runtime, which the single-HMAC config model can't express:
//  - FORM mode (no `bodySHA256` query param): HMAC-SHA1(authToken, url + sorted-form-params) — the
//    shipped config-driven recipe, reused verbatim here.
//  - JSON / bodySHA256 mode (Twilio appends `?…&bodySHA256=<hex>` for non-form bodies): TWO checks that
//    must BOTH pass — (1) HMAC-SHA1(authToken, the FULL URL incl. bodySHA256, no form tail) ==
//    X-Twilio-Signature, and (2) SHA-256(rawBody) hex == the `bodySHA256` query value. Confirmed against
//    twilio-node `webhooks.ts` + twilio-python `request_validator.py` (and a published test vector).
// The SDK tries the URL with and without the default port (:443/:80); we mirror that with a port-toggle.

import { hexToBytes, sha256, timingSafeEqual } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, type VerificationResult } from "../../verification";
import { PROVIDER_CONFIGS } from "../config";
import { makeHmacAdapter } from "../factory";

const SIGNATURE_HEADER = "x-twilio-signature";

/** The URL forms Twilio's SDK accepts: as received + the default-port-toggled variant. */
function urlVariants(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [rawUrl];
  }
  const toggled = new URL(rawUrl);
  toggled.port = parsed.port ? "" : parsed.protocol === "https:" ? "443" : "80";
  const variants = [rawUrl]; // as received — verbatim, never URL-normalized
  const toggledStr = toggled.toString();
  if (toggledStr !== rawUrl) variants.push(toggledStr);
  return variants;
}

export function makeTwilioAdapter(): VerifyAdapter {
  const tolerance = PROVIDER_CONFIGS.twilio.toleranceSeconds;
  // Form mode delegates to the shipped config-driven recipe (url + sortedFormFields).
  const formAdapter = makeHmacAdapter(PROVIDER_CONFIGS.twilio);
  // JSON mode signs the FULL URL only (no form-param tail), HMAC-SHA1/base64.
  const urlOnlyAdapter = makeHmacAdapter({
    slug: "twilio",
    signatureHeader: SIGNATURE_HEADER,
    digest: "sha1",
    encoding: "base64",
    message: [{ kind: "url", component: "full" }],
    toleranceSeconds: tolerance,
  });

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    let bodyHash: string | null = null;
    if (input.requestUrl !== undefined) {
      try {
        bodyHash = new URL(input.requestUrl).searchParams.get("bodySHA256");
      } catch {
        bodyHash = null;
      }
    }

    // No bodySHA256 → ordinary form-encoded webhook.
    if (bodyHash === null) return formAdapter.verify(input);

    // JSON / bodySHA256 mode. (1) Authenticate the URL (which carries the signed bodySHA256), trying the
    // port variants the way Twilio's SDK does; keep the first ok, else the last failure.
    let urlResult: VerificationResult = verificationFailed({ code: "SIGNATURE_MISMATCH" });
    for (const variant of urlVariants(input.requestUrl!)) {
      urlResult = await urlOnlyAdapter.verify({ ...input, requestUrl: variant });
      if (urlResult.ok) break;
    }
    if (!urlResult.ok) return urlResult;

    // (2) URL signature valid → its bodySHA256 is authentic; confirm the body actually hashes to it.
    // A mismatch means the bytes changed in transit (the URL — and thus the expected hash — is signed).
    const expected = hexToBytes(bodyHash);
    const actual = await sha256(input.rawBody);
    if (expected === null || !timingSafeEqual(actual, expected)) {
      return verificationFailed({ code: "PROXY_MUTATED_BYTES", confidence: "medium" });
    }
    return urlResult; // ok — carries the twilio scheme + keyId
  }

  return {
    scheme: "twilio",
    signatureHeader: SIGNATURE_HEADER,
    toleranceSeconds: tolerance,
    verify,
  };
}
