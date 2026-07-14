import { describe, expect, it } from "vitest";

import { gravatarHash, isAllowedProviderAvatar, resolveAvatarSource } from "./avatar";

// An image proxy that fetches a URL taken from data is an SSRF primitive: point it at 127.0.0.1 or the cloud
// metadata endpoint and it will fetch the bytes and hand them back. `user.image` is written by Better Auth
// from the OAuth provider's profile, so it is not *currently* attacker-controlled — but that is a property of
// code somewhere else, and this module must not depend on it staying true.
//
// The allowlist is the whole defence, so it is what gets tested hardest.
describe("isAllowedProviderAvatar — the SSRF gate", () => {
  it("allows the provider CDNs we actually use — every Google shard, and GitHub", () => {
    // Google shards avatars across lh3-lh6; a user whose picture lives on lh5 must not silently lose it.
    for (const host of ["lh3", "lh4", "lh5", "lh6"]) {
      expect(isAllowedProviderAvatar(`https://${host}.googleusercontent.com/a/abc123`)).toBe(true);
    }
    expect(isAllowedProviderAvatar("https://avatars.githubusercontent.com/u/42?v=4")).toBe(true);
  });

  it("refuses the loopback and link-local addresses an SSRF actually targets", () => {
    expect(isAllowedProviderAvatar("http://127.0.0.1/admin")).toBe(false);
    expect(isAllowedProviderAvatar("http://localhost:8080/")).toBe(false);
    expect(isAllowedProviderAvatar("https://[::1]/")).toBe(false);
    // The cloud metadata endpoint — the classic SSRF payoff, and it answers to plain HTTP.
    expect(isAllowedProviderAvatar("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedProviderAvatar("http://10.0.0.5/internal")).toBe(false);
  });

  it("refuses a non-https scheme even for an allowlisted host", () => {
    // A network-position attacker could swap the bytes, and no provider CDN needs plaintext.
    expect(isAllowedProviderAvatar("http://lh3.googleusercontent.com/a/abc")).toBe(false);
    // And the schemes that are not fetches at all.
    expect(isAllowedProviderAvatar("file:///etc/passwd")).toBe(false);
    expect(isAllowedProviderAvatar("data:image/svg+xml,<svg onload=alert(1)>")).toBe(false);
    expect(isAllowedProviderAvatar("javascript:alert(1)")).toBe(false);
  });

  // A SUBSTRING check would pass every one of these. The host must MATCH, not merely contain.
  it("cannot be fooled by a host that merely contains an allowlisted name", () => {
    expect(isAllowedProviderAvatar("https://lh3.googleusercontent.com.evil.test/x")).toBe(false);
    expect(isAllowedProviderAvatar("https://evil.test/lh3.googleusercontent.com")).toBe(false);
    expect(isAllowedProviderAvatar("https://notlh3.googleusercontent.com/x")).toBe(false);
    // Userinfo in the authority: `@` makes the REAL host `evil.test`, and a naive parse reads the other one.
    expect(isAllowedProviderAvatar("https://lh3.googleusercontent.com@evil.test/x")).toBe(false);
  });

  it("refuses garbage rather than throwing", () => {
    expect(isAllowedProviderAvatar("")).toBe(false);
    expect(isAllowedProviderAvatar("not a url")).toBe(false);
    expect(isAllowedProviderAvatar("///")).toBe(false);
  });
});

describe("gravatarHash", () => {
  // Gravatar's contract: the identifier is a hash of the LOWERCASED, TRIMMED email. Get the normalisation
  // wrong and every user with a capital letter in their address silently has no avatar.
  it("normalises case and whitespace before hashing", async () => {
    const plain = await gravatarHash("dana@acme.co");
    expect(await gravatarHash("  DANA@ACME.CO  ")).toBe(plain);
  });

  it("is SHA-256, not MD5 — 64 hex characters", async () => {
    const hash = await gravatarHash("dana@acme.co");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveAvatarSource", () => {
  it("prefers the provider's avatar when there is one we trust", async () => {
    const source = await resolveAvatarSource({
      image: "https://avatars.githubusercontent.com/u/42",
      email: "dana@acme.co",
      size: 32,
    });

    expect(source).toEqual({ kind: "provider", url: "https://avatars.githubusercontent.com/u/42" });
  });

  // The route must fetch the CANONICALIZED url, never the raw input — validating one string and fetching a
  // different one is the parser-differential SSRF shape. So the source carries the re-serialized href.
  it("returns the canonical URL for the provider, not the raw input", async () => {
    const source = await resolveAvatarSource({
      image: "https://lh3.googleusercontent.com/a/ABC?sz=100",
      email: "dana@acme.co",
      size: 32,
    });

    if (source.kind !== "provider") throw new Error("expected a provider source");
    // Whatever we hand the fetch is a value that has already been through the URL parser.
    expect(source.url).toBe(new URL(source.url).href);
    expect(new URL(source.url).hostname).toBe("lh3.googleusercontent.com");
  });

  // The important half of the SSRF gate: an image we do NOT trust does not become a fetch. It falls through
  // to Gravatar, whose host is a constant.
  it("falls through to Gravatar when the stored image is not one we will fetch", async () => {
    const source = await resolveAvatarSource({
      image: "http://169.254.169.254/latest/meta-data/",
      email: "dana@acme.co",
      size: 32,
    });

    expect(source.kind).toBe("gravatar");
    if (source.kind !== "gravatar") throw new Error("unreachable");
    expect(new URL(source.url).hostname).toBe("gravatar.com");
  });

  // `d=404` is load-bearing. WITHOUT it Gravatar returns a generated "mystery person" silhouette with a 200 —
  // so we would proxy a grey blob for every user who has never heard of Gravatar, which is most of them.
  // With it, a user with no Gravatar 404s, we serve nothing, and the UI shows their initials instead.
  it("asks Gravatar for a 404 rather than a stock silhouette", async () => {
    const source = await resolveAvatarSource({ image: null, email: "dana@acme.co", size: 32 });

    if (source.kind !== "gravatar") throw new Error("expected a gravatar source");
    expect(new URL(source.url).searchParams.get("d")).toBe("404");
  });

  it("requests 2x the rendered size, so it stays sharp on a retina display", async () => {
    const source = await resolveAvatarSource({ image: null, email: "dana@acme.co", size: 32 });

    if (source.kind !== "gravatar") throw new Error("expected a gravatar source");
    expect(new URL(source.url).searchParams.get("s")).toBe("64");
  });

  it("clamps an absurd size rather than passing it upstream", async () => {
    const huge = await resolveAvatarSource({ image: null, email: "d@a.co", size: 100_000 });
    if (huge.kind !== "gravatar") throw new Error("expected a gravatar source");
    expect(Number(new URL(huge.url).searchParams.get("s"))).toBeLessThanOrEqual(1024);
  });

  it("resolves to nothing when there is no usable identity", async () => {
    expect(await resolveAvatarSource({ image: null, email: "", size: 32 })).toEqual({
      kind: "none",
    });
  });
});
