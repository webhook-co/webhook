import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("supports conditional object and array syntax", () => {
    expect(cn("base", { active: true, hidden: false }, ["x", "y"])).toBe("base active x y");
  });

  it("resolves conflicting tailwind utilities, last one wins", () => {
    expect(cn("px-2 px-4")).toBe("px-4");
    expect(cn("text-fg", "text-fg-secondary")).toBe("text-fg-secondary");
  });
});
