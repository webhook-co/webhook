import { describe, expect, it } from "vitest";
import { PROVIDER_CONFIGS } from "@webhook-co/webhooks-spec";
import { buildRecipe, recipeClusterKey } from "./build-recipe";

const recipe = (slug: string) => {
  const config = PROVIDER_CONFIGS[slug as keyof typeof PROVIDER_CONFIGS];
  if (!config) throw new Error(`no config for ${slug}`);
  return buildRecipe(config);
};

describe("buildRecipe — config-driven recipes derived from the registry", () => {
  it("stripe: timestamped HMAC-SHA256, hex, {t}.{body}, replay enforced, rotation", () => {
    const r = recipe("stripe");
    expect(r.archetype).toBe("timestamped-hmac");
    expect(r.signatureHeader).toBe("stripe-signature");
    expect(r.signatureLocation).toBe("header");
    expect(r.algorithm).toBe("HMAC-SHA256");
    expect(r.encoding).toBe("hex");
    expect(r.signedMessageParts).toEqual(["timestamp", "literal:.", "body"]);
    expect(r.timestamp).toEqual({ source: expect.stringContaining("t"), format: "seconds" });
    expect(r.replayWindow.enforced).toBe(true);
    expect(r.replayWindow.toleranceSeconds).toBe(300);
    expect(r.rotation).toBe(true); // multiple v1= accepted during a secret roll
    expect(r.clientVerifiable).toBe(true);
    expect(r.verifierInputs).toContain("secret");
    expect(r.verifierInputs).toContain("payload");
    expect(r.verifierInputs).toContain("signatureHeader");
    expect(r.verifierInputs).not.toContain("requestUrl");
  });

  it("github: raw-body HMAC-SHA256, hex, sha256= prefix, NO replay window (no timestamp)", () => {
    const r = recipe("github");
    expect(r.archetype).toBe("raw-body-hmac");
    expect(r.signatureHeader).toBe("x-hub-signature-256");
    expect(r.signatureValuePrefix).toBe("sha256=");
    expect(r.algorithm).toBe("HMAC-SHA256");
    expect(r.signedMessage).toBe("the raw request body");
    expect(r.signedMessageParts).toEqual(["body"]);
    expect(r.timestamp).toBeNull();
    // CORRECTNESS RULE: carries toleranceSeconds=300 but NEVER enforces it (no timestamp resolves).
    expect(r.replayWindow.enforced).toBe(false);
    expect(r.verifierInputs).not.toContain("requestUrl");
    expect(r.verifierInputs).not.toContain("timestamp");
  });

  it("hubspot: request-context HMAC binding method+url+body+ts (ms), replay enforced, needs url+method", () => {
    const r = recipe("hubspot");
    expect(r.archetype).toBe("request-context-hmac");
    expect(r.algorithm).toBe("HMAC-SHA256");
    expect(r.timestamp?.format).toBe("milliseconds");
    expect(r.replayWindow.enforced).toBe(true);
    expect(r.signedMessageParts).toEqual(["method", "url:full", "body", "timestamp"]);
    // CORRECTNESS: request-context providers must prompt for URL + method or verify is impossible.
    expect(r.verifierInputs).toContain("requestUrl");
    expect(r.verifierInputs).toContain("method");
  });

  it("mandrill: request-context but SHA-1 (per-row digest, not the sha256 default)", () => {
    const r = recipe("mandrill");
    expect(r.algorithm).toBe("HMAC-SHA1");
    expect(r.archetype).toBe("request-context-hmac");
    expect(r.verifierInputs).toContain("requestUrl");
  });

  // This case used to be adyen. Adyen moved to a BESPOKE adapter — its signature is per-item inside a
  // batched body, which a fixed `jsonField` path cannot iterate — and its config row was deleted, so
  // there is nothing here for `buildRecipe` to derive; its recipe is asserted in
  // bespoke-recipes.test.ts. Re-pointed at mailgun rather than dropped: adyen was the ONLY
  // config-driven sig-in-body case in this file, so deleting it would have silently retired the
  // archetype's coverage here.
  it("mailgun: signature-in-body (JSON field), hex, no header, no enforced window", () => {
    const r = recipe("mailgun");
    expect(r.archetype).toBe("sig-in-body-hmac");
    expect(r.signatureLocation).toBe("json-body");
    expect(r.signatureHeader).toBeNull();
    expect(r.encoding).toBe("hex");
    expect(r.replayWindow.enforced).toBe(false);
  });

  it("sanity: timestamp is SIGNED but the replay window is NOT enforced (enforceReplayWindow:false)", () => {
    const r = recipe("sanity");
    expect(r.timestamp).not.toBeNull();
    // CORRECTNESS RULE: a signed timestamp with enforceReplayWindow:false must NOT claim enforcement.
    expect(r.replayWindow.enforced).toBe(false);
  });

  it("paystack: raw-body HMAC-SHA512 (per-row digest)", () => {
    const r = recipe("paystack");
    expect(r.algorithm).toBe("HMAC-SHA512");
  });

  it("standard_webhooks: SW family, whsec-base64 key derivation, id.ts.body", () => {
    const r = recipe("standard_webhooks");
    expect(r.archetype).toBe("standard-webhooks");
    expect(r.keyDerivation).toMatch(/base64|whsec/i);
    expect(r.replayWindow.enforced).toBe(true);
  });

  it("every config-driven recipe is client-verifiable and needs secret+payload", () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      const r = buildRecipe(config);
      expect(r.source).toBe("config");
      expect(r.clientVerifiable).toBe(true);
      expect(r.verifierInputs).toContain("secret");
      expect(r.verifierInputs).toContain("payload");
      // CORRECTNESS: if the signed message binds the URL/query, the verifier MUST collect requestUrl;
      // if it binds the method, it MUST collect method — else verification is impossible.
      if (r.signedMessageParts.some((p) => /^(url|queryParam)/.test(p))) {
        expect(r.verifierInputs).toContain("requestUrl");
      }
      if (r.signedMessageParts.includes("method")) {
        expect(r.verifierInputs).toContain("method");
      }
    }
  });
});

describe("request-context quirk is precise (claims-must-not-outrun-the-code)", () => {
  it("hubspot signs the method, so its quirk mentions the method", () => {
    expect(recipe("hubspot").quirks.join(" ")).toMatch(/method/i);
  });

  it("square/trello do NOT sign the method, so their quirk must not claim method-binding", () => {
    for (const slug of ["square", "trello"]) {
      const q = recipe(slug).quirks.join(" ");
      expect(q, `${slug} quirk`).not.toMatch(/method/i);
      expect(q).toMatch(/URL/i); // they DO bind the URL
    }
  });

  it("mercado_pago binds a query param (not the full URL) — the quirk must not overclaim", () => {
    const q = recipe("mercado_pago").quirks.join(" ");
    expect(q).not.toMatch(/HTTP method/i);
    expect(q).toMatch(/query param/i);
  });
});

describe("signedHeaders — extra header values the verifier must collect", () => {
  it("Standard Webhooks family folds the id header into the signed message", () => {
    expect(recipe("standard_webhooks").signedHeaders).toEqual(["webhook-id"]);
    expect(recipe("clerk").signedHeaders).toEqual(["svix-id"]); // svix-* prefix alias
  });

  it("every `header:` message part has a matching signedHeaders entry (verifier can reconstruct)", () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      const r = buildRecipe(config);
      const headerTokens = r.signedMessageParts
        .filter((p) => p.startsWith("header:"))
        .map((p) => p.slice("header:".length));
      for (const h of headerTokens) {
        expect(r.signedHeaders ?? [], `${r.slug} signs header ${h}`).toContain(h);
      }
    }
  });

  it("a raw-body provider that folds no headers has no signedHeaders", () => {
    expect(recipe("github").signedHeaders).toBeUndefined();
  });
});

describe("recipeClusterKey — near-duplicate detection across the registry", () => {
  it("collapses byte-identical-except-header raw-body recipes (github ≈ meta ≈ bitbucket ≈ jira)", () => {
    const gh = recipeClusterKey(recipe("github"));
    expect(gh).toBe(recipeClusterKey(recipe("meta")));
    expect(gh).toBe(recipeClusterKey(recipe("bitbucket")));
    expect(gh).toBe(recipeClusterKey(recipe("atlassian_jira")));
    expect(gh).toBe(recipeClusterKey(recipe("notion")));
  });

  it("keeps genuinely-distinct recipes apart (github hex/prefix ≠ shopify base64/no-prefix ≠ stripe timestamped)", () => {
    const gh = recipeClusterKey(recipe("github"));
    const shopify = recipeClusterKey(recipe("shopify"));
    const stripe = recipeClusterKey(recipe("stripe"));
    expect(new Set([gh, shopify, stripe]).size).toBe(3);
  });

  it("cluster key ignores the header name (that alone does not make a page non-thin)", () => {
    // github (`x-hub-signature-256`) and bitbucket (`x-hub-signature`) differ ONLY in header name;
    // their cluster key must be equal — the header token alone doesn't make a page non-thin.
    expect(recipe("github").signatureHeader).not.toBe(recipe("bitbucket").signatureHeader);
    expect(recipeClusterKey(recipe("github"))).toBe(recipeClusterKey(recipe("bitbucket")));
  });
});
