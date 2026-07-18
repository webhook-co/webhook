import { describe, expect, it } from "vitest";

import { promoSchema } from "./schema";

describe("promoSchema", () => {
  it("accepts a valid promo and rejects an empty headline", () => {
    expect(
      promoSchema.safeParse({ headline: "Ship webhooks faster", tagline: "free, signed URLs" })
        .success,
    ).toBe(true);
    expect(promoSchema.safeParse({ headline: "", tagline: "x" }).success).toBe(false);
  });

  it("rejects an empty tagline", () => {
    expect(promoSchema.safeParse({ headline: "Ship webhooks faster", tagline: "" }).success).toBe(
      false,
    );
  });

  it("defaults theme to dark when omitted", () => {
    const result = promoSchema.safeParse({ headline: "Headline", tagline: "Tagline" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.theme).toBe("dark");
  });

  it("accepts an explicit light theme and rejects an invalid theme", () => {
    expect(promoSchema.safeParse({ headline: "H", tagline: "T", theme: "light" }).success).toBe(
      true,
    );
    expect(promoSchema.safeParse({ headline: "H", tagline: "T", theme: "neon" }).success).toBe(
      false,
    );
  });
});
