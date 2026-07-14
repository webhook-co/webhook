import type { AuthContext } from "@webhook-co/contract";
import { bytesToB64url, utf8Encoder } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  bindSessionId,
  importSessionKey,
  principalDigest,
  SESSION_ENVELOPE_VERSION,
  SESSION_TTL_SECONDS,
  unbindSessionId,
} from "./session-binding";

// A8c — the per-request principal-isolation primitive. mcp's MCP session id (server-assigned by the
// McpAgent transport, which routes the Durable Object purely by it) is wrapped in an HMAC-signed envelope
// binding it to the INITIALIZING principal; every later request must present the matching principal or the
// session is rejected — so a stolen/reused session id can't be used by a DIFFERENT principal to reach the
// first principal's DO. The envelope is versioned and expires (a max session lifetime) so a leaked id can't
// be replayed forever and an old/incompatible envelope cleanly re-initializes. Pure crypto (Web Crypto +
// base64url), unit-tested with no DO.

const KEY_BYTES = new Uint8Array(32).fill(7);
const OTHER_KEY_BYTES = new Uint8Array(32).fill(9);

const ALICE: AuthContext = { orgId: "org_alice", userId: "usr_a", scopes: ["events:read"] };
const ALICE_AGAIN: AuthContext = { orgId: "org_alice", userId: "usr_a", scopes: ["audit:read"] };
const BOB: AuthContext = { orgId: "org_bob", userId: "usr_b", scopes: ["events:read"] };
const ALICE_ORGKEY: AuthContext = { orgId: "org_alice", scopes: ["events:read"] }; // no userId

// A fixed clock so the expiry assertions are deterministic.
const NOW = 1_750_000_000;

async function key() {
  return importSessionKey(KEY_BYTES);
}

describe("importSessionKey", () => {
  it("rejects a key that isn't 32 bytes", async () => {
    await expect(importSessionKey(new Uint8Array(16))).rejects.toThrow(/32/);
  });
});

describe("principalDigest", () => {
  // The digest binds AUTHORITY, not merely identity. It previously hashed only (org, user) — deliberately
  // excluding scopes so a re-scoped token kept its session. That was the bug: an org-scoped api key carries
  // NO userId, so EVERY api key in an org hashed to the SAME digest, while the DO pins its AuthContext
  // (scopes included) at session init. A key holding only `events:read` could therefore present a session
  // initialised by an `endpoints:write` key, match the digest, route to that DO, and run its tools with the
  // STRONGER key's scopes. Scopes are part of the principal's authority, so they belong in the binding.
  // The DO pins its AuthContext — keyId included — at session init, and routes purely by session id. So if
  // two DISTINCT api keys with identical authority (same org, same scopes) hashed to the same digest, key B
  // could resume the session key A initialised, and every audit row B wrote would name A as the actor. The
  // credential's IDENTITY is part of the principal, not just its authority — attribution depends on it.
  it("DIFFERS for two distinct keys with identical authority (no cross-key attribution)", async () => {
    const keyA: AuthContext = { orgId: "org_alice", scopes: ["events:read"], keyId: "k_a" };
    const keyB: AuthContext = { orgId: "org_alice", scopes: ["events:read"], keyId: "k_b" };
    expect(await principalDigest(keyA)).not.toBe(await principalDigest(keyB));
  });

  it("DIFFERS between a key-bearing principal and the same authority with no key", async () => {
    const keyed: AuthContext = { orgId: "org_alice", scopes: ["events:read"], keyId: "k_a" };
    expect(await principalDigest(keyed)).not.toBe(await principalDigest(ALICE_ORGKEY));
  });

  it("DIFFERS when the scope set differs, even for the same org+user (no scope escalation)", async () => {
    expect(await principalDigest(ALICE)).not.toBe(await principalDigest(ALICE_AGAIN));
  });

  it("differs for two org keys in the same org holding different scopes", async () => {
    const weak: AuthContext = { orgId: "org_alice", scopes: ["events:read"] };
    const strong: AuthContext = { orgId: "org_alice", scopes: ["events:read", "endpoints:write"] };
    expect(await principalDigest(weak)).not.toBe(await principalDigest(strong));
  });

  // Canonicalised (sorted + de-duplicated) so an equivalent scope set that merely arrives in a different
  // order — or with a repeat — is the SAME authority and keeps its session, rather than spuriously
  // re-initialising on every request.
  it("is stable across scope ORDER and duplicates (same authority ⇒ same session)", async () => {
    const a: AuthContext = { orgId: "o", userId: "u", scopes: ["events:read", "audit:read"] };
    const b: AuthContext = {
      orgId: "o",
      userId: "u",
      scopes: ["audit:read", "events:read", "audit:read"],
    };
    expect(await principalDigest(a)).toBe(await principalDigest(b));
  });

  it("differs across orgs", async () => {
    expect(await principalDigest(ALICE)).not.toBe(await principalDigest(BOB));
  });

  it("IGNORES the response-only `organization` field — adding it to a ctx must not re-key the session", async () => {
    // whoami now enriches its RESPONSE with the bound org {id,slug,name}. The digest binds the credential's
    // AUTHORITY (org id + user + scopes + key id), NOT display enrichment — so a ctx that happens to carry the
    // optional `organization` object must produce the byte-identical digest, or every session would spuriously
    // re-initialise the moment the field appears. Guards against anyone folding `organization` into the digest.
    const bare: AuthContext = { orgId: "o", userId: "u", scopes: ["events:read"] };
    const enriched: AuthContext = {
      ...bare,
      organization: { id: "o", slug: "acme", name: "Acme Inc" },
    };
    expect(await principalDigest(enriched)).toBe(await principalDigest(bare));
  });

  it("differs for the same org with vs without a user (an org key is a distinct principal)", async () => {
    expect(await principalDigest(ALICE)).not.toBe(await principalDigest(ALICE_ORGKEY));
  });
});

// The escalation, end-to-end through the real bind/unbind codec.
describe("scope escalation via session-id reuse (S.3)", () => {
  it("a weaker org key CANNOT unbind a session initialised by a stronger org key in the same org", async () => {
    const k = await key();
    const strong: AuthContext = { orgId: "org_alice", scopes: ["events:read", "endpoints:write"] };
    const weak: AuthContext = { orgId: "org_alice", scopes: ["events:read"] };

    // The strong key initialises a session; the DO behind it is pinned with endpoints:write.
    const wrapped = await bindSessionId(k, "base-1", await principalDigest(strong), NOW);

    // The weak key presents that same session id. It must NOT resolve — no base id, no DO, no escalation.
    expect(await unbindSessionId(k, wrapped, await principalDigest(weak), NOW)).toBeNull();

    // ...and the strong key itself still works, so the fix isn't just breaking everything.
    expect(await unbindSessionId(k, wrapped, await principalDigest(strong), NOW)).toBe("base-1");
  });
});

describe("bind / unbind session id", () => {
  it("round-trips: the same principal recovers the base session id", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base-session-123", pd, NOW);
    expect(wrapped).not.toBe("base-session-123"); // it's wrapped, not the raw id
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBe("base-session-123");
  });

  it("is deterministic at a fixed time (same base + principal + now → same wrapped id)", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    expect(await bindSessionId(k, "G", pd, NOW)).toBe(await bindSessionId(k, "G", pd, NOW));
  });

  it("REJECTS a different principal reusing the wrapped id (cross-principal isolation)", async () => {
    const k = await key();
    const wrapped = await bindSessionId(k, "alices-session", await principalDigest(ALICE), NOW);
    // Bob presents Alice's wrapped session id with his own principal → no base id, no DO access.
    expect(await unbindSessionId(k, wrapped, await principalDigest(BOB), NOW)).toBeNull();
  });

  it("rejects a tampered envelope", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base", pd, NOW);
    const tampered = `${wrapped.slice(0, -2)}xx`;
    expect(await unbindSessionId(k, tampered, pd, NOW)).toBeNull();
  });

  it("rejects an envelope signed with a different key (no forgery)", async () => {
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(await importSessionKey(OTHER_KEY_BYTES), "base", pd, NOW);
    expect(await unbindSessionId(await key(), wrapped, pd, NOW)).toBeNull();
  });

  it("rejects a forged `baseId.principalDigest` plaintext (a signature is required)", async () => {
    // An attacker who knows a base id + their own digest can't craft a valid wrapped id without the key.
    const k = await key();
    const forged = `${btoa("base")}.${await principalDigest(BOB)}`;
    expect(await unbindSessionId(k, forged, await principalDigest(BOB), NOW)).toBeNull();
  });

  it("returns null on a malformed (no-dot / empty) id rather than throwing", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    expect(await unbindSessionId(k, "nodothere", pd, NOW)).toBeNull();
    expect(await unbindSessionId(k, "", pd, NOW)).toBeNull();
  });
});

describe("envelope version", () => {
  it("stamps the current version + a max-lifetime expiry on a fresh bind", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base", pd, NOW);
    // It round-trips at bind time and stays valid right up to the TTL ceiling (inclusive).
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBe("base");
    expect(await unbindSessionId(k, wrapped, pd, NOW + SESSION_TTL_SECONDS)).toBe("base");
  });

  it("rejects an envelope whose version != the current version (even if validly signed)", async () => {
    // A validly-signed envelope carrying a different version digit must still be rejected.
    const k = await key();
    const pd = await principalDigest(ALICE);
    const env = {
      v: SESSION_ENVELOPE_VERSION + 1,
      b: "base",
      p: pd,
      exp: NOW + SESSION_TTL_SECONDS,
    };
    const wrapped = await signEnvelope(k, env);
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBeNull();
  });

  it("rejects a validly-signed envelope with a missing version field (e.g. an OLD envelope)", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const env = { b: "base", p: pd, exp: NOW + SESSION_TTL_SECONDS }; // no `v`
    const wrapped = await signEnvelope(k, env);
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBeNull();
  });

  it("rejects an OLD envelope shape with neither `v` nor `exp` (in-flight sessions re-initialize)", async () => {
    // The pre-versioning envelope was exactly `{ b, p }`. It is now treated as invalid → null, so any
    // session opened before this change cleanly re-initializes. That's intended.
    const k = await key();
    const pd = await principalDigest(ALICE);
    const env = { b: "base", p: pd }; // the old { b, p } shape
    const wrapped = await signEnvelope(k, env);
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBeNull();
  });
});

describe("envelope expiry", () => {
  it("rejects an envelope strictly after its expiry (a leaked id can't be replayed forever)", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base", pd, NOW);
    // One second past the TTL ceiling → dead.
    expect(await unbindSessionId(k, wrapped, pd, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects a validly-signed envelope with a missing exp field", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const env = { v: SESSION_ENVELOPE_VERSION, b: "base", p: pd }; // no `exp`
    const wrapped = await signEnvelope(k, env);
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBeNull();
  });

  it("rejects a validly-signed envelope whose exp is in the past", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const env = { v: SESSION_ENVELOPE_VERSION, b: "base", p: pd, exp: NOW - 1 };
    const wrapped = await signEnvelope(k, env);
    expect(await unbindSessionId(k, wrapped, pd, NOW)).toBeNull();
  });
});

describe("method-agnostic round-trip (POST / GET / DELETE call sites)", () => {
  // resource-handler.ts calls bind/unbind identically for every HTTP method (the codec doesn't take a
  // method): a POST `initialize` mints the wrapped id, and subsequent GET (SSE stream) and DELETE (session
  // teardown) requests present that SAME id. These cases prove the same envelope round-trips for the GET and
  // DELETE call sites exactly as it does for POST.
  it("the id minted on the POST initialize unbinds on a later GET request", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const minted = await bindSessionId(k, "session-from-initialize", pd, NOW);
    // Later GET (SSE) request presents the minted id.
    expect(await unbindSessionId(k, minted, pd, NOW + 60)).toBe("session-from-initialize");
  });

  it("the same minted id unbinds on a later DELETE (teardown) request", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const minted = await bindSessionId(k, "session-from-initialize", pd, NOW);
    // Later DELETE (teardown) request presents the minted id.
    expect(await unbindSessionId(k, minted, pd, NOW + 120)).toBe("session-from-initialize");
  });

  it("cross-principal reuse is rejected identically on GET and DELETE call sites", async () => {
    const k = await key();
    const minted = await bindSessionId(k, "alices", await principalDigest(ALICE), NOW);
    // Bob reusing Alice's id on a GET or DELETE is rejected just as on POST.
    expect(await unbindSessionId(k, minted, await principalDigest(BOB), NOW + 60)).toBeNull();
    expect(await unbindSessionId(k, minted, await principalDigest(BOB), NOW + 120)).toBeNull();
  });
});

// A local re-sealer that mirrors the module's `<b64url(json)>.<b64url(mac16)>` codec so a test can mint an
// envelope with an arbitrary (e.g. version/exp-tampered) payload that is nonetheless VALIDLY signed — the
// only way to assert that unbind rejects on the FIELDS, not just on a bad MAC. Uses the same key as the SUT.
async function signEnvelope(k: CryptoKey, env: Record<string, unknown>): Promise<string> {
  const bytes = utf8Encoder.encode(JSON.stringify(env));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes as Uint8Array<ArrayBuffer>));
  return `${bytesToB64url(bytes)}.${bytesToB64url(sig.slice(0, 16))}`;
}
