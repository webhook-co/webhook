// Monday.com webhooks — a BARE HS256 JWT in the `Authorization` header (NO `Bearer ` prefix). The token
// authenticates origin + account + destination via signed claims (`aud` = the exact endpoint URL, plus
// accountId/userId/iat/exp), but carries NO body-hash claim. So this is ORIGIN-authenticated (cryptographic
// proof the request came from Monday for OUR endpoint, fresh) — the payload bytes are not integrity-bound
// by the token (TLS protects them in transit). Key = the app Signing Secret verbatim utf8.
//
// (Webhooks created via the UI / a personal-token GraphQL mutation are UNSIGNED — no Authorization header
// — and therefore unverifiable; only monday-app / OAuth-created webhooks carry the JWT.)

import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { enforceJwtWindow, jwsFailureToResult, verifyCompactHs } from "../jws";
import { findHeader } from "../shared";

const HEADER = "authorization";

export function makeMondayAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.monday;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const token = findHeader(input.headers, HEADER);
    if (token === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: HEADER, scheme: "monday" });
    }

    const jws = await verifyCompactHs(token, input.secrets);
    if (!jws.ok) return jwsFailureToResult(jws.reason, "monday");
    const { payload, secretIndex } = jws;

    // aud binds the token to OUR endpoint — a token minted for a different destination is rejected. We hold
    // only the live request URL, so this is the same best-effort URL match as the other Tier-2 adapters: a
    // non-canonical configured URL fails CLOSED (the ADR-0080 trade-off).
    if (typeof payload.aud === "string") {
      if (input.requestUrl === undefined || payload.aud !== input.requestUrl) {
        return verificationFailed({ code: "SIGNATURE_MISMATCH" });
      }
    }

    const stale = enforceJwtWindow(payload, toleranceSeconds, input.now);
    if (stale !== null) return stale;

    return verificationOk(`secret_${secretIndex}`, "monday");
  }

  return { scheme: "monday", signatureHeader: HEADER, toleranceSeconds, verify };
}
