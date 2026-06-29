// The config-driven adapter factory. `makeHmacAdapter` turns one declarative HmacProviderConfig
// (./config) into a VerifyAdapter, routing every provider through the SAME audited engine
// (`verifyHmacCore`, via verifyHmacHex/Base64 in ./shared). This is the seam that lets a new
// provider be one config row instead of a hand-written adapter — there is no per-provider crypto.

import { concatBytes, utf8Encoder } from "../bytes";
import { verificationFailed, type VerificationResult } from "../verification";
import type { VerifyAdapter, VerifyInput } from "../adapter";
import { RAW_BODY_MESSAGE, type HmacProviderConfig, type MessagePart } from "./config";
import {
  findHeader,
  oversizeBodyFailure,
  toCandidates,
  verifyHmacBase64,
  verifyHmacHex,
} from "./shared";

/** Concatenate the configured message parts into the EXACT bytes the HMAC is computed over. */
function buildMessage(parts: readonly MessagePart[], rawBody: Uint8Array): Uint8Array {
  // The overwhelmingly common case (raw body verbatim) avoids a copy.
  if (parts.length === 1 && parts[0]!.kind === "body") return rawBody;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(part.kind === "body" ? rawBody : utf8Encoder.encode(part.value));
  }
  return concatBytes(...chunks);
}

/**
 * Build a `VerifyAdapter` from a declarative HMAC config. The adapter computes over the EXACT
 * captured raw bytes, tries each registered secret newest-first (rotation), constant-time
 * compares decoded MAC bytes, and NEVER throws — all of that lives in the shared engine; this
 * factory only does the per-config framing: header lookup, oversize guard, optional value-prefix
 * strip, signed-message assembly, and hex-vs-base64 dispatch.
 */
export function makeHmacAdapter(config: HmacProviderConfig): VerifyAdapter {
  const scheme = config.slug;
  const header = config.signatureHeader;
  const parts = config.message ?? RAW_BODY_MESSAGE;
  const prefix = config.signatureValuePrefix;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const headerValue = findHeader(input.headers, header);
    if (headerValue === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header, scheme });
    }

    const oversize = oversizeBodyFailure(scheme, input.rawBody);
    if (oversize !== null) return oversize;

    let signature = headerValue;
    if (prefix !== undefined) {
      if (!headerValue.startsWith(prefix)) {
        return verificationFailed({
          code: "MALFORMED_SIGNATURE",
          detail: `expected "${prefix}" prefix`,
          scheme,
        });
      }
      signature = headerValue.slice(prefix.length);
    }

    const candidates = toCandidates(input.secrets);
    const buildMsg = (body: Uint8Array) => buildMessage(parts, body);
    if (config.encoding === "hex") {
      return verifyHmacHex({
        scheme,
        rawBody: input.rawBody,
        expectedHexes: [signature],
        candidates,
        buildMessage: buildMsg,
      });
    }
    return verifyHmacBase64({
      scheme,
      rawBody: input.rawBody,
      expectedBase64s: [signature],
      candidates,
      buildMessage: buildMsg,
    });
  }

  return { scheme, signatureHeader: header, toleranceSeconds: config.toleranceSeconds, verify };
}
