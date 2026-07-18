import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WordmarkView } from "./Wordmark";

// jsdom normalizes `style.color` from a hex literal to its rgb() form, so
// assert against that rendered form rather than `colors.verified`'s "#3FB27F".
const VERIFIED_RGB = "rgb(63, 178, 127)";

// Wordmark's real logic is the progress→opacity/translateY settle mapping
// (shared with KineticLine/IngestPill) plus the "." accent split — test the
// pure View directly (mirrors the KineticLine/TypedLine split; the spring
// itself is Remotion's own tested primitive, driven with the brief §3.4
// headlineSettle config by the thin wrapper).
describe("WordmarkView", () => {
  it('renders the real "webhook.co" lockup byte-for-byte', () => {
    const { container } = render(<WordmarkView progress={1} />);
    expect(container.textContent).toBe("webhook.co");
  });

  it('carries the single colors.verified accent on the "." only', () => {
    const { container } = render(<WordmarkView progress={1} />);
    const dot = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === ".");
    expect(dot?.style.color).toBe(VERIFIED_RGB);
  });

  it("starts fully transparent, offset by 12px, before the spring begins (progress=0)", () => {
    const { container } = render(<WordmarkView progress={0} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.style.opacity).toBe("0");
    expect(mark.style.transform).toBe("translateY(12px)");
  });

  it("settles fully visible at translateY(0) once the spring completes (progress=1)", () => {
    const { container } = render(<WordmarkView progress={1} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.style.opacity).toBe("1");
    expect(mark.style.transform).toBe("translateY(0px)");
  });
});
