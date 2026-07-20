/* eslint-disable security/detect-non-literal-fs-filename -- adapter source paths are fixed module-relative URLs, never user input. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { BESPOKE_HEADER_PINS, BESPOKE_RECIPES } from "./bespoke-recipes";

const ADAPTERS_DIR = fileURLToPath(new URL("../../webhooks-spec/src/adapters/", import.meta.url));

describe("bespoke recipes — integrity + code-pinning", () => {
  it("every entry's key matches its slug and is a real registry provider", () => {
    for (const [key, r] of Object.entries(BESPOKE_RECIPES)) {
      expect(r.slug).toBe(key);
      expect(r.source).toBe("bespoke");
      expect(PROVIDERS).toContain(key);
    }
  });

  it("each declared signature header actually appears in its adapter source (code-pin)", () => {
    expect(Object.keys(BESPOKE_HEADER_PINS).length).toBeGreaterThan(0);
    for (const [slug, pin] of Object.entries(BESPOKE_HEADER_PINS)) {
      const source = readFileSync(ADAPTERS_DIR + pin.file, "utf8").toLowerCase();
      expect(
        source.includes(pin.header.toLowerCase()),
        `header "${pin.header}" for ${slug} not found in ${pin.file}`,
      ).toBe(true);
      // The pin must agree with the recipe entry.
      expect(BESPOKE_RECIPES[slug]?.signatureHeader).toBe(pin.header);
    }
  });

  it("remote-fetch and token providers are NOT client-verifiable (no in-browser verify)", () => {
    for (const r of Object.values(BESPOKE_RECIPES)) {
      if (r.archetype === "remote-fetch" || r.archetype === "token") {
        expect(r.clientVerifiable).toBe(false);
        expect(r.verifierInputs).toEqual([]);
      }
    }
  });

  it("asymmetric and jwt providers ARE client-verifiable and need the public key/secret + payload", () => {
    for (const r of Object.values(BESPOKE_RECIPES)) {
      if (r.archetype === "asymmetric" || r.archetype === "jwt") {
        expect(r.clientVerifiable).toBe(true);
        expect(r.verifierInputs).toContain("secret");
        expect(r.verifierInputs).toContain("payload");
      }
    }
  });

  it("operator-configured token providers cannot state a header (signatureHeader is null)", () => {
    for (const slug of [
      "okta",
      "bigcommerce",
      "datadog",
      "brevo",
      "new_relic",
      "fillout",
      "zapier",
    ]) {
      const r = BESPOKE_RECIPES[slug];
      expect(r, `${slug} must have a bespoke recipe`).toBeDefined();
      expect(r!.signatureHeader).toBeNull();
    }
  });
});
