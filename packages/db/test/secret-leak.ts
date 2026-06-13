// Reusable assertion: a serialized value must not contain any secret string.
//
// The recurrence guard for "did a list/display payload leak a credential?" — the kind of
// regression that is a real security defect, not a style nit. Any endpoint that returns a
// list/detail of credential-bearing rows (api keys today; ingest tokens, signing keys,
// provider secrets tomorrow) should assert its serialized output against the plaintext AND
// the stored hash, so a future field addition can't silently expose either.
//
// Assert the FULL secret, never a slice: a substring check on a slice can pass while the
// whole secret leaks under a different framing. JSON.stringify is the worst-case surface
// (it walks every enumerable field), so serializing here catches a leak regardless of the
// shape the caller hands back.

import { expect } from "vitest";

/**
 * Assert that none of `secrets` appears anywhere in the JSON serialization of `value`.
 * Pass the plaintext credential and (when in hand) the hex of its stored hash.
 */
export function expectNoSecretInSerialized(
  value: unknown,
  secrets: readonly (string | null | undefined)[],
): void {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === null || secret === undefined || secret === "") continue;
    expect(json).not.toContain(secret);
  }
}
