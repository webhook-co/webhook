import { describe, expect, it } from "vitest";

import type { Session } from "./session";
import { signSessionToken, verifySessionToken } from "./session-token";

const SECRET = "test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = 1_750_000_000_000; // fixed ms for deterministic exp checks

const session: Session = {
  userId: "usr_dana",
  orgId: "org_acme",
  user: { name: "Dana Kessler", email: "dana@acme.co", image: "https://img/d.png" },
};

describe("session token codec", () => {
  it("round-trips a principal through sign → verify", async () => {
    const token = await signSessionToken(session, SECRET, 3600, NOW);
    const out = await verifySessionToken(token, SECRET, NOW + 1000);
    expect(out).toEqual(session);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken(session, SECRET, 3600, NOW);
    expect(await verifySessionToken(token, "another-secret-bbbbbbbbbbbbbbbbbbbb", NOW)).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const token = await signSessionToken(session, SECRET, 3600, NOW);
    const [body, sig] = token.split(".");
    // flip a char in the body — the HMAC is over the body, so verification must fail
    const tampered = `${body.slice(0, -1)}${body.at(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(await verifySessionToken(tampered, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signSessionToken(session, SECRET, 3600, NOW);
    const [body] = token.split(".");
    expect(await verifySessionToken(`${body}.AAAA`, SECRET, NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSessionToken(session, SECRET, 60, NOW);
    expect(await verifySessionToken(token, SECRET, NOW + 61_000)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "nodot", ".onlysig", "body.", "a.b.c"]) {
      expect(await verifySessionToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("preserves a null avatar", async () => {
    const noImage: Session = { ...session, user: { ...session.user, image: null } };
    const token = await signSessionToken(noImage, SECRET, 3600, NOW);
    expect((await verifySessionToken(token, SECRET, NOW))?.user.image).toBeNull();
  });
});
