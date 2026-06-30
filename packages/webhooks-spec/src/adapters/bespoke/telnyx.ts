// Telnyx — Ed25519 over `timestamp + "|" + rawBody` (a literal pipe separator). `telnyx-signature-ed25519`
// (base64) + `telnyx-timestamp`; the registered "secret" is the account's base64-encoded 32-byte public key.

import type { VerifyAdapter } from "../../adapter";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { makeEd25519Adapter } from "./ed25519-adapter";

export function makeTelnyxAdapter(): VerifyAdapter {
  return makeEd25519Adapter({
    slug: "telnyx",
    signatureHeader: "telnyx-signature-ed25519",
    timestampHeader: "telnyx-timestamp",
    signatureEncoding: "base64",
    keyEncoding: "base64",
    separator: "|",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.telnyx,
  });
}
