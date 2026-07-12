import { describe, expect, it } from "vitest";

import { resolvePostLoginTarget } from "./post-login-target";

describe("resolvePostLoginTarget", () => {
  it("defaults to the session handoff when there is no redirect param", () => {
    // The whole point: a plain login must land on /session/handoff (the auth.→app. producer that mints
    // the exchange ticket), NOT app. directly — app. has no session until the handoff runs.
    expect(resolvePostLoginTarget("")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?foo=bar")).toBe("/session/handoff");
  });

  it("honors a same-origin absolute path (the issuer /authorize bounce sets ?redirect=)", () => {
    expect(resolvePostLoginTarget("?redirect=%2Fauthorize%3Fclient_id%3Dx")).toBe(
      "/authorize?client_id=x",
    );
    expect(resolvePostLoginTarget("?redirect=%2Fsession%2Fhandoff")).toBe("/session/handoff");
  });

  it("rejects an off-origin / protocol-relative / backslash redirect (open-redirect guard) → the handoff", () => {
    expect(resolvePostLoginTarget("?redirect=https%3A%2F%2Fevil.com")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2F%2Fevil.com")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2F%5Cevil.com")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2F")).toBe("/session/handoff");
    // Control-character smuggling: browsers STRIP tab/newline/CR while parsing a Location, so `/	/evil.com`
    // becomes the protocol-relative `//evil.com` → https://evil.com. The old `[^/\]` char-class accepted a
    // tab as the second byte and let this through — an open redirect the moment the guard is the ONLY layer
    // (which it now is: the signed-in bounce calls redirect() directly, with no Better Auth trustedOrigins
    // re-check behind it). Every control-char variant must fall back to the handoff.
    expect(resolvePostLoginTarget("?redirect=%2F%09%2Fevil.com")).toBe("/session/handoff"); // tab
    expect(resolvePostLoginTarget("?redirect=%2F%0A%2Fevil.com")).toBe("/session/handoff"); // newline
    expect(resolvePostLoginTarget("?redirect=%2F%0D%2Fevil.com")).toBe("/session/handoff"); // CR
    expect(resolvePostLoginTarget("?redirect=%09%2F%2Fevil.com")).toBe("/session/handoff"); // leading tab
    // `/\tevil.com` → the browser strips the tab → `/evil.com`, a legitimate SAME-ORIGIN path (not `//`), so
    // it is a safe destination and correctly kept. The dangerous shapes are the ones that become
    // protocol-relative (`//`, `/\`, `\t//`), all rejected above.
    expect(resolvePostLoginTarget("?redirect=%2F%09evil.com")).toBe("/evil.com");
  });

  it("never sends a just-authenticated user back to /login (the loop) → the handoff", () => {
    expect(resolvePostLoginTarget("?redirect=%2Flogin")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2Flogin%3Fredirect%3D%2Fx")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2Flogin%2Ffoo")).toBe("/session/handoff");
    // but a path merely PREFIXED with "login" (e.g. /loginhelp) is still a valid destination
    expect(resolvePostLoginTarget("?redirect=%2Floginhelp")).toBe("/loginhelp");
  });
});
