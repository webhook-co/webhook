/* eslint-disable security/detect-non-literal-fs-filename -- all paths are fixed module-relative URLs (import.meta.url), never user input. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { buildAllRecipes, renderGolden } from "./build-all";

const GOLDEN_PATH = fileURLToPath(new URL("./recipes.generated.ts", import.meta.url));
const WRITE = process.env.WEBHOOK_RECIPES_WRITE === "1";

describe("recipes.generated.ts — golden drift + coverage", () => {
  if (WRITE) {
    it("regenerates the golden from the registry", () => {
      writeFileSync(GOLDEN_PATH, renderGolden(buildAllRecipes()));
      expect(existsSync(GOLDEN_PATH)).toBe(true);
    });
    return;
  }

  it("covers every provider in the registry vocabulary, exactly once", () => {
    const recipes = buildAllRecipes();
    expect(recipes.length).toBe(PROVIDERS.length);
    const slugs = recipes.map((r) => r.slug).sort();
    expect(slugs).toEqual([...PROVIDERS].sort());
    expect(new Set(slugs).size).toBe(slugs.length); // no dup slug
  });

  it("the committed golden is byte-identical to a fresh generation (no hand-edits, no drift)", () => {
    expect(existsSync(GOLDEN_PATH)).toBe(true);
    const onDisk = readFileSync(GOLDEN_PATH, "utf8");
    expect(onDisk).toBe(renderGolden(buildAllRecipes()));
  });

  it("the exported RECIPES equals a fresh generation (semantic)", async () => {
    const { RECIPES } = await import("./recipes.generated");
    expect(RECIPES).toEqual(buildAllRecipes());
  });

  it("no raw-body provider claims replay-window enforcement (claims-must-not-outrun-the-code)", () => {
    for (const r of buildAllRecipes()) {
      if (r.timestamp === null) expect(r.replayWindow.enforced).toBe(false);
    }
  });

  it("remote-fetch providers are NOT client-verifiable (excluded from the interactive tool)", () => {
    const remote = buildAllRecipes().filter((r) => r.archetype === "remote-fetch");
    expect(remote.length).toBeGreaterThan(0);
    for (const r of remote) expect(r.clientVerifiable).toBe(false);
  });

  it("every client-verifiable recipe requires the secret and the payload", () => {
    for (const r of buildAllRecipes()) {
      if (!r.clientVerifiable) continue;
      expect(r.verifierInputs).toContain("secret");
      expect(r.verifierInputs).toContain("payload");
    }
  });

  // The interactive verifier renders an input ONLY for headers a recipe declares in `signedHeaders`. A
  // `header:X` message part that isn't declared is a provider the tool OFFERS but can never verify — the
  // adapter fails MISSING_HEADER/MALFORMED forever because the value can't be entered. keygen shipped
  // exactly that way (`header:host`/`header:date` undeclared), so this is the standing floor.
  it("every header folded into a client-verifiable signed message is declared collectable", () => {
    let checked = 0;
    for (const r of buildAllRecipes()) {
      if (!r.clientVerifiable) continue;
      const declared = new Set((r.signedHeaders ?? []).map((h) => h.toLowerCase()));
      for (const part of r.signedMessageParts) {
        if (!part.startsWith("header:")) continue;
        checked++;
        const name = part.slice("header:".length).toLowerCase();
        expect(
          declared.has(name),
          `${r.slug}: signs "${part}" but does not declare it in signedHeaders — the verifier cannot collect it`,
        ).toBe(true);
      }
    }
    // Floor: a vacuous loop would make this guard a lie.
    expect(checked).toBeGreaterThan(0);
  });
});
