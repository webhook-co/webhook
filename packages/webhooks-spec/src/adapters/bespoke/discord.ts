// Discord interactions/webhooks — Ed25519 over `timestamp + rawBody` (no separator). `X-Signature-Ed25519`
// (hex) + `X-Signature-Timestamp`; the registered "secret" is the app's hex-encoded 32-byte public key.

import type { VerifyAdapter } from "../../adapter";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { makeEd25519Adapter } from "./ed25519-adapter";

export function makeDiscordAdapter(): VerifyAdapter {
  return makeEd25519Adapter({
    slug: "discord",
    signatureHeader: "x-signature-ed25519",
    timestampHeader: "x-signature-timestamp",
    signatureEncoding: "hex",
    keyEncoding: "hex",
    separator: "",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.discord,
  });
}
