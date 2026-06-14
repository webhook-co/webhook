import { createCredentialHasherFromBase64 } from "@webhook-co/db";
import { bytesToB64 } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

// The ingest hot path resolves a token by hashing it with the shared credential primitive
// (node:crypto HMAC-SHA256 + pepper). That primitive must run inside WORKERD (nodejs_compat),
// not just Node — this slice's whole resolve path depends on it. Exercise it in the Workers pool
// so a missing/broken node:crypto polyfill fails here, not at the first live event.

// A fixed >=32-byte pepper, base64-encoded (prod injects this as a Workers secret string).
const PEPPER_B64 = bytesToB64(new Uint8Array(32).fill(0x5e));

describe("credential hasher under workerd (nodejs_compat)", () => {
  it("produces a stable, non-plaintext HMAC for a token", () => {
    const hasher = createCredentialHasherFromBase64(PEPPER_B64);
    const token = "whep_live-path-token";
    const a = hasher.hash(token);
    const b = hasher.hash(token);
    expect(a.equals(b)).toBe(true); // deterministic
    expect(a.length).toBe(32); // SHA-256 digest
    expect(a.toString("hex")).not.toContain(token); // never the plaintext
  });

  it("a different pepper yields a different hash (the pepper is actually keyed in)", () => {
    const other = bytesToB64(new Uint8Array(32).fill(0x11));
    const h1 = createCredentialHasherFromBase64(PEPPER_B64).hash("whep_x");
    const h2 = createCredentialHasherFromBase64(other).hash("whep_x");
    expect(h1.equals(h2)).toBe(false);
  });
});
