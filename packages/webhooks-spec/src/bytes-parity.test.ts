import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Recurrence guard for the deliberate duplication in bytes.ts. webhooks-spec is the leaf
// of the dependency graph, so it can't import packages/shared without a package cycle —
// the security-critical primitives below are copied byte-for-byte instead. This test reads
// BOTH files from disk and asserts the source of each mirrored function is identical, so a
// future edit to the constant-time compare or HMAC key import in one cannot silently drift
// from the other. (The two files are supersets of a shared core, not identical files, so we
// compare the mirrored functions, not the whole files.)

// Functions kept identical across packages/shared/src/bytes.ts and this package's bytes.ts.
const MIRRORED = [
  "bytesToHex",
  "bytesToB64",
  "timingSafeEqual",
  "concatBytes",
  "importHmacKey",
] as const;

const localBytes = readFileSync(new URL("./bytes.ts", import.meta.url), "utf8") + "\n";
const sharedBytes =
  readFileSync(new URL("../../shared/src/bytes.ts", import.meta.url), "utf8") + "\n";

/** Extract a top-level `export function <name>(...) { ... }` source, by its column-0 close. */
function extractFn(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = source.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`end of function ${name} not found`);
  return source.slice(start, end + 2); // through the closing "\n}"
}

describe("bytes.ts parity (webhooks-spec mirror of packages/shared)", () => {
  for (const fn of MIRRORED) {
    it(`${fn} is byte-for-byte identical to the shared implementation`, () => {
      expect(extractFn(localBytes, fn)).toBe(extractFn(sharedBytes, fn));
    });
  }
});
