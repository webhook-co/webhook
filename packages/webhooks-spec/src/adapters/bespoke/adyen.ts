// Adyen standard (payment) webhooks. The signature is not in a header — each entry of the JSON body's
// `notificationItems` array carries its own `NotificationRequestItem.additionalData.hmacSignature`
// (base64). The signed message is 8 fields of THAT item joined by a plain colon, absent fields as the
// empty string, with NO escaping and NO sorting. That is verified against Adyen's own implementations,
// not inferred: `adyen-java-api-library` `HMACValidator.getDataToSign` uses `Util.implode(":", …)` and
// `adyen-php-api-library` `HmacSignature::getNotificationDataToSign` uses `implode(":", …)`, neither
// escaping anything. (Backslash-escaping belongs to the legacy HPP signature — a different scheme from
// the same vendor, and a documented way to get this wrong.) The key is the Customer-Area HMAC key
// HEX-DECODED, not its ASCII characters. HMAC-SHA256, no timestamp.
//
// WHY THIS IS BESPOKE AND NOT A CONFIG ROW. It used to be one, addressing `notificationItems.0.…`,
// because a declarative `jsonField` path is fixed and cannot iterate. Adyen batches: production
// traffic carries several items per request. Verifying index 0 alone left items 1..N neither verified
// nor rejected, so a request pairing one authentic item with any number of forged ones was reported
// `ok` and the caller went on to process all of them. A signature check that can be walked past by
// appending to an array is not providing the property it exists for. Iteration is precisely what a
// config row cannot express, which is what makes this bespoke.
//
// EVERY item must verify, under the SAME key. That is a deliberate tightening with a cost: Adyen
// batches QUEUED notifications, so a batch can straddle an HMAC-key rotation and will now fail as a
// whole where the old code passed on item 0 alone. Likewise a single unsigned item makes the whole
// request MALFORMED. Both fail closed, which is the right direction for a signature check, but they
// do turn some previously-`verified` events into unverified — that is the trade, not an oversight.
//
// KNOWN LIMITATION OF ADYEN'S SCHEME (pre-existing; the config row had it too). The colon join is not
// injective, so adjacent fields can be re-partitioned without changing the signed bytes:
//   merchantReference "REF:1130" + amount.value 1130       -> "…:REF:1130:1130:EUR:…"
//   merchantReference "REF"      + amount.value "1130:1130" -> "…:REF:1130:1130:EUR:…"
// One Adyen-issued signature is valid for both readings, and `merchantReference` is usually
// merchant-controlled. We match Adyen deliberately: adding escaping would reject genuine
// notifications. Consumers who care must compare the fields they act on against their own record.

import { bytesToB64, hexToBytes, hmacSha256, timingSafeEqual, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { oversizeBodyFailure } from "../shared";

/** The 8 signed fields, in Adyen's order. */
const SIGNED_FIELDS = [
  "pspReference",
  "originalReference",
  "merchantAccountCode",
  "merchantReference",
  "amount.value",
  "amount.currency",
  "eventCode",
  "success",
] as const;

/** Present, but an object or array — a shape Adyen never sends in a signed position. */
const NON_SCALAR = Symbol("non-scalar");

/**
 * Read a dotted path. Absent/null -> "" (Adyen's empty-field rule); scalars are stringified.
 *
 * A present-but-non-scalar value is NOT "" — it is rejected. Collapsing both to "" lets a forged
 * `amount: { value: ["999999"], currency: ["EUR"] }` build the same signed message as an authentic
 * notification that carried no `amount` at all, so one real signature covers both. A downstream
 * consumer doing `Number(item.amount.value)` then reads 999999, because JS coerces a 1-element array.
 * The path list is a module constant, so this is only ever reached with attacker-shaped VALUES.
 */
function scalarAt(item: unknown, path: string): string | typeof NON_SCALAR {
  let cur: unknown = item;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return "";
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === null || cur === undefined) return "";
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return NON_SCALAR;
}

interface ParsedItem {
  readonly message: Uint8Array;
  readonly signature: string;
}

/**
 * Every notification item, each with its own signed message and its own claimed signature.
 * `null` means the body is not a shape we can verify at all — reported MALFORMED, never skipped.
 */
function parseItems(rawBody: Uint8Array): ParsedItem[] | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const items = (body as Record<string, unknown>).notificationItems;
  // An empty array is NOT "nothing to check, therefore fine" — there is no authentic content in it,
  // and returning ok would be a pass over an empty set.
  if (!Array.isArray(items) || items.length === 0) return null;

  const parsed: ParsedItem[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = (entry as Record<string, unknown>).NotificationRequestItem;
    if (typeof item !== "object" || item === null) return null;

    const signature = scalarAt(item, "additionalData.hmacSignature");
    if (signature === NON_SCALAR || signature === "") return null;

    const fields: string[] = [];
    for (const f of SIGNED_FIELDS) {
      const value = scalarAt(item, f);
      if (value === NON_SCALAR) return null;
      fields.push(value);
    }
    parsed.push({ message: utf8Encoder.encode(fields.join(":")), signature });
  }
  return parsed;
}

export function makeAdyenAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.adyen;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const oversize = oversizeBodyFailure("adyen", input.rawBody);
    if (oversize !== null) return oversize;

    const items = parseItems(input.rawBody);
    if (items === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail:
          "body is not an Adyen notification: expected a non-empty notificationItems array, each entry carrying NotificationRequestItem.additionalData.hmacSignature and only scalar values in the signed fields",
        scheme: "adyen",
      });
    }

    let sawUsableSecret = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const key = hexToBytes(input.secrets[i]!);
      // `hexToBytes("")` is a 0-BYTE ARRAY, not null — and Web Crypto throws DataError on a
      // zero-length HMAC key. Without this length check one misconfigured empty secret alongside a
      // live one turns every Adyen webhook from verified into an exception. Every sibling guards it
      // the same way (`toHexKeyCandidates`, `contentful.ts`); this adapter must never throw.
      if (key === null || key.length === 0) continue;
      sawUsableSecret = true;

      // EVERY item, not the first. The loop ends early on a mismatch — but as a failure for this key,
      // never as a partial pass.
      let allVerified = true;
      for (const item of items) {
        // Compare the canonical base64 STRINGS, not decoded bytes. Our side is always the canonical
        // 44-char encoding of a 32-byte MAC, so this is strictly stricter than a byte compare: it
        // also rejects the malleable encodings and unpadded forms that decode to the same MAC. It
        // fails closed in every direction. `timingSafeEqual`'s only early exit is on length.
        const expected = bytesToB64(await hmacSha256(key, item.message));
        if (!timingSafeEqual(utf8Encoder.encode(expected), utf8Encoder.encode(item.signature))) {
          allVerified = false;
          break;
        }
      }
      if (allVerified) return verificationOk(`secret_${i}`, "adyen");
    }

    if (!sawUsableSecret) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    // A well-formed signature that simply did not match is WRONG_SECRET, matching every sibling
    // adapter and the diagnosis the docs promise. `SIGNATURE_MISMATCH` here would flatten the most
    // actionable thing we tell a user.
    return verificationFailed({ code: "WRONG_SECRET", confidence: "low" });
  }

  // No header carries the signature; it is inside the body. Kept as "" for parity with the config row
  // this replaces — `detectScheme` cannot identify Adyen from headers, and never could.
  return { scheme: "adyen", signatureHeader: "", toleranceSeconds, verify };
}
