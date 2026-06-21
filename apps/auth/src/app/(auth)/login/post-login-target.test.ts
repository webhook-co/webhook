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
  });

  it("never sends a just-authenticated user back to /login (the loop) → the handoff", () => {
    expect(resolvePostLoginTarget("?redirect=%2Flogin")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2Flogin%3Fredirect%3D%2Fx")).toBe("/session/handoff");
    expect(resolvePostLoginTarget("?redirect=%2Flogin%2Ffoo")).toBe("/session/handoff");
    // but a path merely PREFIXED with "login" (e.g. /loginhelp) is still a valid destination
    expect(resolvePostLoginTarget("?redirect=%2Floginhelp")).toBe("/loginhelp");
  });
});
