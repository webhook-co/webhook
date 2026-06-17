import "@testing-library/jest-dom/vitest";

import { expect } from "vitest";
import { toHaveNoViolations } from "vitest-axe/matchers.js";

// vitest-axe ships an empty `extend-expect.js` (its augmentation is types-only), so register the
// axe matcher at runtime here.
expect.extend({ toHaveNoViolations });

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
