import { describe, expect, it, vi } from "vitest";

import {
  SIGNIN_METHOD_BY_PATH,
  emitSignInTelemetry,
  signInMethodForPath,
} from "./signin-telemetry";

// Without this, One Tap is UNFALSIFIABLE. Both it and the "Continue with Google" button write
// `providerId: "google"` with the same Google `sub`, so nothing in the database can tell them apart and
// "did anyone use the feature we shipped" has no answer. These tests pin the two ways that silently
// breaks: a path string that stops matching, and an event that carries something it shouldn't.

// NOT a default parameter: `ctx(path, undefined)` must mean "newSession is undefined", and a default
// would silently substitute a live session and make the negative test below assert its own opposite.
const SIGNED_IN = { user: { id: "u_1" } };
const ctx = (path: string, ...rest: [newSession?: unknown]) => ({
  path,
  context: { newSession: rest.length === 0 ? SIGNED_IN : rest[0] },
});

describe("signInMethodForPath", () => {
  it("maps the One Tap callback", () => {
    expect(signInMethodForPath("/one-tap/callback")).toBe("one_tap");
  });

  // The social path is the PATTERN, not a concrete provider: better-auth's dispatch sets
  // `path: endpoint.path`, and the OAuth callback endpoint is registered as "/callback/:id". Matching
  // "/callback/google" here would never fire in production.
  it("maps the OAuth callback by its REGISTERED pattern, not a concrete provider", () => {
    expect(signInMethodForPath("/callback/:id")).toBe("social");
  });

  it("maps the magic-link verify", () => {
    expect(signInMethodForPath("/magic-link/verify")).toBe("magic_link");
  });

  it("returns undefined for a path that completes no sign-in", () => {
    expect(signInMethodForPath("/sign-in/social")).toBeUndefined();
    expect(signInMethodForPath("/sign-in/magic-link")).toBeUndefined();
    expect(signInMethodForPath("/get-session")).toBeUndefined();
  });

  it("is total over junk input", () => {
    for (const v of [undefined, null, 42, {}, [], ""]) {
      expect(signInMethodForPath(v)).toBeUndefined();
    }
  });
});

describe("emitSignInTelemetry", () => {
  it("emits the method when a session was created", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, ctx("/one-tap/callback"));
    expect(log).toHaveBeenCalledWith("signin.method", { method: "one_tap" });
  });

  it("distinguishes One Tap from the Google button — the whole point", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, ctx("/one-tap/callback"));
    await emitSignInTelemetry(log, ctx("/callback/:id"));
    expect(log.mock.calls.map(([, f]) => (f as { method: string }).method)).toEqual([
      "one_tap",
      "social",
    ]);
  });

  // `newSession` is better-auth's own "a session was established in this request" signal (set by
  // setSessionCookie; the anonymous and multi-session plugins read it the same way). Without this guard
  // the after-hook fires on EVERY request to a matched path, including a rejected one — turning a
  // failed sign-in attempt into a recorded sign-in.
  it("emits NOTHING when no session was created (a rejected attempt is not a sign-in)", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, ctx("/one-tap/callback", null));
    await emitSignInTelemetry(log, ctx("/one-tap/callback", undefined));
    expect(log).not.toHaveBeenCalled();
  });

  it("emits nothing for a path that completes no sign-in", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, ctx("/get-session"));
    expect(log).not.toHaveBeenCalled();
  });

  // PII-free by construction, not by review. The context in scope holds the user's email, name, image
  // and id; the event must carry the METHOD and nothing else, so this asserts the exact payload rather
  // than merely asserting the absence of today's known-bad fields.
  it("emits the method and NOTHING else — no email, no name, no id", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(
      log,
      ctx("/one-tap/callback", {
        user: { id: "u_1", email: "ada@example.dev", name: "Ada Lovelace", image: "https://x/y" },
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const [event, fields] = log.mock.calls[0]!;
    expect(event).toBe("signin.method");
    expect(Object.keys(fields as object)).toEqual(["method"]);
    expect(JSON.stringify(fields)).not.toMatch(/ada|Lovelace|u_1/i);
  });

  // This runs inside the sign-in request. A telemetry fault must never cost a user their session.
  it("never throws when the log sink throws", async () => {
    const log = vi.fn(() => {
      throw new Error("sink down");
    });
    await expect(emitSignInTelemetry(log, ctx("/one-tap/callback"))).resolves.toBeUndefined();
  });

  it("never throws on a malformed context", async () => {
    const log = vi.fn();
    for (const bad of [undefined, null, 42, {}, { path: "/one-tap/callback" }]) {
      await expect(emitSignInTelemetry(log, bad)).resolves.toBeUndefined();
    }
  });

  it("is a no-op when no log sink is configured", async () => {
    await expect(emitSignInTelemetry(undefined, ctx("/one-tap/callback"))).resolves.toBeUndefined();
  });
});

describe("SIGNIN_METHOD_BY_PATH", () => {
  // The map is the contract with better-auth's registered paths. Every key here was read off the
  // installed package (createAuthEndpoint calls), not from docs — a renamed upstream path silently
  // stops matching and the method quietly becomes uncounted rather than wrong-but-loud.
  it("covers exactly the three sign-in-completing endpoints this app mounts", () => {
    expect(Object.keys(SIGNIN_METHOD_BY_PATH).sort()).toEqual([
      "/callback/:id",
      "/magic-link/verify",
      "/one-tap/callback",
    ]);
  });
});

// `/callback/:id` serves BOTH Google and GitHub, so `method: "social"` alone cannot answer the question
// this module was built for: is anyone using One Tap INSTEAD of the Google button. Without the provider
// the comparison is still unavailable and the feature stays unfalsifiable.
describe("emitSignInTelemetry — provider", () => {
  const withParams = (path: string, params: unknown) => ({
    path,
    params,
    context: { newSession: { user: { id: "u_1" } } },
  });

  it("distinguishes the Google button from GitHub on the shared callback path", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, withParams("/callback/:id", { id: "google" }));
    await emitSignInTelemetry(log, withParams("/callback/:id", { id: "github" }));

    expect(log.mock.calls.map(([, f]) => f)).toEqual([
      { method: "social", provider: "google" },
      { method: "social", provider: "github" },
    ]);
  });

  it("omits provider entirely for endpoints that identify none", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, withParams("/one-tap/callback", undefined));
    expect(log).toHaveBeenCalledWith("signin.method", { method: "one_tap" });
  });

  it("stays PII-free — only method and provider, never anything from params", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(
      log,
      withParams("/callback/:id", { id: "google", email: "ada@example.dev", token: "secret" }),
    );
    const [, fields] = log.mock.calls[0]!;
    expect(Object.keys(fields as object).sort()).toEqual(["method", "provider"]);
    expect(JSON.stringify(fields)).not.toMatch(/ada|secret/);
  });

  it("ignores a non-string provider id", async () => {
    const log = vi.fn();
    await emitSignInTelemetry(log, withParams("/callback/:id", { id: 42 }));
    expect(log).toHaveBeenCalledWith("signin.method", { method: "social" });
  });
});
