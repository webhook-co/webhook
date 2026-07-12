import { VerificationFailureSchema } from "@webhook-co/webhooks-spec";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VERIFY_FAILURES, VerifyCard } from "./verify-card";

/**
 * The verification card names failure codes. A failure code is not a marketing word — it is a value
 * out of the shipped `VerificationFailureSchema` union, the same string a developer will read back in
 * the dashboard, the CLI and the API. A card that invents one (there used to be a
 * `wrong_secret_test_vs_live`, which exists nowhere in the product) is a lie a reader can only catch
 * by trying it.
 *
 * So the codes on the page are pinned to the union: only real codes, spelled the way the product
 * spells them (UPPERCASE). The import is TEST-ONLY — `@webhook-co/webhooks-spec` is a devDependency of
 * apps/www and never enters the static-export bundle (the 600 KB budget); the component ships plain
 * strings, and this test is what keeps those strings honest.
 */

/** Every failure code the product can actually emit, read off the discriminated union itself. */
const REAL_CODES = new Set(
  VerificationFailureSchema.options.map((option) => option.shape.code.value as string),
);

describe("the verification card's failure codes", () => {
  it("reads the real codes off the schema (this test is not vacuous)", () => {
    // If the extraction above ever silently yields an empty set, every subset assertion below would
    // pass for free. Pin the shape of the source of truth itself.
    expect(REAL_CODES.size).toBe(11);
    expect(REAL_CODES.has("WRONG_SECRET")).toBe(true);
    expect(REAL_CODES.has("wrong_secret_test_vs_live")).toBe(false);
    expect(REAL_CODES.has("wrong_secret")).toBe(false);
  });

  it("only names codes the verification union can actually emit", () => {
    expect(VERIFY_FAILURES.length).toBeGreaterThan(0);
    for (const failure of VERIFY_FAILURES) {
      expect(REAL_CODES, `the card shows ${failure.code}, which no adapter can emit`).toContain(
        failure.code,
      );
    }
  });

  it("shows those codes verbatim, and nothing that merely looks like one", () => {
    render(<VerifyCard />);
    const text = screen.getByRole("list", { name: /verification failures/i }).textContent ?? "";

    for (const failure of VERIFY_FAILURES) {
      expect(text).toContain(failure.code);
    }
    // The product's codes are UPPERCASE. A lowercase snake_case token in this card is, by
    // construction, an invented code (the prose has none) — that is exactly how the old
    // `wrong_secret_test_vs_live` hid in plain sight.
    expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
